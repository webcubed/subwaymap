#!/usr/bin/env node
/*
 Fetch the MTA GTFS static feed (subway) and extract stations from stops.txt,
 then write a compact stations.json file for the frontend.

 Usage:
   node backend/scripts/fetch_stops.js [--out <path>] [--url <gtfs_zip_url>]

 You can also set GTFS_STATIC_URL env var to override the default URL.
*/

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { parse } = require("csv-parse/sync");
const AdmZip = require("adm-zip");

const DEFAULT_URLS = [
	process.env.GTFS_STATIC_URL,
	// Current static CDN (preferred)
	"https://static.mta.info/developers/data/nyct/subway/google_transit.zip",
	// Alternate host
	"https://www.mta.info/developers/data/nyct/subway/google_transit.zip",
	// Legacy public URL
	"http://web.mta.info/developers/data/nyct/subway/google_transit.zip",
].filter(Boolean);

function parseArgs(argv) {
	const args = { out: path.resolve(__dirname, "../../frontend/stations.json"), url: undefined };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--out" && argv[i + 1]) {
			args.out = path.resolve(argv[i + 1]);
			i++;
		} else if (a === "--url" && argv[i + 1]) {
			args.url = argv[i + 1];
			i++;
		}
	}
	return args;
}

function download(url) {
	const client = url.startsWith("https") ? https : http;
	return new Promise((resolve, reject) => {
		const req = client.get(url, (res) => {
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				// follow redirects
				return resolve(download(res.headers.location));
			}
			if (res.statusCode !== 200) {
				return reject(new Error(`Failed to download: ${url} (status ${res.statusCode})`));
			}
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve(Buffer.concat(chunks)));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.setTimeout(20000, () => {
			req.destroy(new Error("Request timeout"));
		});
	});
}

function ensureDirFor(filePath) {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
}

function extractStopsTxt(zipBuf) {
	const zip = new AdmZip(zipBuf);
	const entries = zip.getEntries();
	const entry = entries.find((e) => /(^|\/)stops\.txt$/i.test(e.entryName));
	if (!entry) throw new Error("stops.txt not found in GTFS zip");
	return entry.getData().toString("utf8");
}

function buildStations(stopsCsv) {
	const rows = parse(stopsCsv, { columns: true, skip_empty_lines: true, trim: true });
	// GTFS: location_type 1 = Station, 0 = Stop/platform
	const stations = {};

	for (const r of rows) {
		const lt = (r.location_type || "").toString().trim();
		if (lt !== "1") continue; // only explicit stations
		const id = (r.stop_id || "").trim();
		if (!id) continue;
		const lat = Number(r.stop_lat);
		const lng = Number(r.stop_lon);
		const name = (r.stop_name || "").trim();
		if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) continue;
		stations[id] = { lat, lng, name };
	}

	// Fallback: derive station coordinates by averaging child platforms grouped by parent_station
	if (Object.keys(stations).length === 0) {
		const childrenByParent = new Map();
		for (const r of rows) {
			const parent = (r.parent_station || "").trim();
			if (!parent) continue;
			if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
			childrenByParent.get(parent).push(r);
		}
		for (const [parentId, kids] of childrenByParent) {
			let sumLat = 0,
				sumLon = 0,
				count = 0;
			let name = "";
			for (const k of kids) {
				const lat = Number(k.stop_lat);
				const lon = Number(k.stop_lon);
				if (Number.isFinite(lat) && Number.isFinite(lon)) {
					sumLat += lat;
					sumLon += lon;
					count++;
				}
				if (!name && k.stop_name) name = String(k.stop_name).trim();
			}
			if (count > 0) {
				stations[parentId] = {
					lat: sumLat / count,
					lng: sumLon / count,
					name: name || parentId,
				};
			}
		}
		if (Object.keys(stations).length === 0) {
			throw new Error("Parsed zero stations from stops.txt (no explicit stations or parent groups found)");
		}
	}

	return stations;
}

async function main() {
	const { out, url } = parseArgs(process.argv);
	const urls = url ? [url] : DEFAULT_URLS;
	let lastErr;
	let buf;
	for (const u of urls) {
		try {
			console.log(`[fetch-stops] Downloading GTFS static from: ${u}`);
			buf = await download(u);
			break;
		} catch (err) {
			lastErr = err;
			console.warn(`[fetch-stops] Failed to download from ${u}: ${err.message}`);
		}
	}
	if (!buf) {
		console.error(
			"[fetch-stops] Hints: Manually download from https://www.mta.info/developers and pass --url or set GTFS_STATIC_URL"
		);
		throw lastErr || new Error("No GTFS URL succeeded");
	}
	const stopsCsv = extractStopsTxt(buf);
	const stations = buildStations(stopsCsv);
	ensureDirFor(out);
	fs.writeFileSync(out, JSON.stringify(stations));
	console.log(`[fetch-stops] Wrote ${Object.keys(stations).length} stations to ${out}`);
	// Explicitly exit to avoid lingering open handles in some environments
	process.exit(0);
}

main().catch((err) => {
	console.error("[fetch-stops] Error:", err.message);
	process.exitCode = 1;
});
