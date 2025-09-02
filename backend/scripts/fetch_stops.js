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

// Optional LIRR static GTFS feed (merged if available)
const DEFAULT_LIRR_URLS = [
	process.env.LIRR_GTFS_STATIC_URL,
	// Official S3 static info referenced by MTA developers
	"https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip",
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

function extractFile(zipBuf, pattern) {
	const zip = new AdmZip(zipBuf);
	const entries = zip.getEntries();
	const entry = entries.find((e) => pattern.test(e.entryName));
	if (!entry) return null;
	return entry.getData().toString("utf8");
}

function buildStationsAndParents(stopsCsv) {
	const rows = parse(stopsCsv, { columns: true, skip_empty_lines: true, trim: true });
	// GTFS: location_type 1 = Station, 0 = Stop/platform
	const stations = {};
	const parentOf = {};

	for (const r of rows) {
		const lt = (r.location_type || "").toString().trim();
		const id = (r.stop_id || "").trim();
		const parent = (r.parent_station || "").trim();
		if (lt === "1") {
			if (!id) continue;
			const lat = Number(r.stop_lat);
			const lng = Number(r.stop_lon);
			const name = (r.stop_name || "").trim();
			if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) continue;
			stations[id] = { lat, lng, name };
			parentOf[id] = id;
		} else {
			if (id) parentOf[id] = parent || id;
		}
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
				parentOf[parentId] = parentId;
			}
		}

		// Secondary fallback: treat every stop as its own station (e.g., LIRR often omits parent_station)
		if (Object.keys(stations).length === 0) {
			let added = 0;
			for (const r of rows) {
				const id = (r.stop_id || "").trim();
				if (!id) continue;
				const lat = Number(r.stop_lat);
				const lon = Number(r.stop_lon);
				const name = (r.stop_name || id).toString().trim();
				if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
				if (!stations[id]) {
					stations[id] = { lat, lng: lon, name };
					parentOf[id] = id;
					added++;
				}
			}
			if (added === 0) {
				throw new Error(
					"Parsed zero stations from stops.txt (no explicit stations, parents, or valid stops found)"
				);
			}
		}
	}

	return { stations, parentOf };
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
	const stopsCsv = extractFile(buf, /(^|\/)stops\.txt$/i);
	if (!stopsCsv) throw new Error("stops.txt not found in GTFS zip");
	const { stations, parentOf } = buildStationsAndParents(stopsCsv);

	// Try to build route adjacency edges from trips and stop_times
	const tripsCsv = extractFile(buf, /(^|\/)trips\.txt$/i);
	const stopTimesCsv = extractFile(buf, /(^|\/)stop_times\.txt$/i);
	let edgesByRoute = {};
	if (tripsCsv && stopTimesCsv) {
		const trips = parse(tripsCsv, { columns: true, skip_empty_lines: true, trim: true });
		const stopTimes = parse(stopTimesCsv, { columns: true, skip_empty_lines: true, trim: true });
		const routeOfTrip = new Map();
		for (const t of trips) {
			const tripId = (t.trip_id || "").trim();
			const routeId = (t.route_id || "").trim();
			if (tripId && routeId) routeOfTrip.set(tripId, routeId);
		}

		const timesByTrip = new Map();
		for (const st of stopTimes) {
			const tripId = (st.trip_id || "").trim();
			const stopId = (st.stop_id || "").trim();
			const seq = Number(st.stop_sequence);
			if (!tripId || !stopId || !Number.isFinite(seq)) continue;
			if (!timesByTrip.has(tripId)) timesByTrip.set(tripId, []);
			timesByTrip.get(tripId).push({ stopId, seq });
		}

		const edgeSetByRoute = new Map();
		for (const [tripId, arr] of timesByTrip) {
			const routeId = routeOfTrip.get(tripId);
			if (!routeId) continue;
			arr.sort((a, b) => a.seq - b.seq);
			for (let i = 0; i < arr.length - 1; i++) {
				const a = parentOf[arr[i].stopId] || arr[i].stopId;
				const b = parentOf[arr[i + 1].stopId] || arr[i + 1].stopId;
				if (!a || !b || a === b) continue;
				if (!edgeSetByRoute.has(routeId)) edgeSetByRoute.set(routeId, new Set());
				const key = a < b ? `${a}|${b}` : `${b}|${a}`;
				edgeSetByRoute.get(routeId).add(key);
			}
		}
		edgesByRoute = {};
		for (const [routeId, set] of edgeSetByRoute) {
			edgesByRoute[routeId] = Array.from(set, (k) => k.split("|"));
		}
	} else {
		console.warn("[fetch-stops] trips.txt or stop_times.txt missing; route_edges.json will not be generated");
	}
	// Attempt to merge LIRR static feed into stations and edges if reachable
	try {
		let lirrBuf;
		for (const u of DEFAULT_LIRR_URLS) {
			try {
				console.log(`[fetch-stops] Downloading LIRR GTFS static from: ${u}`);
				lirrBuf = await download(u);
				break;
			} catch (e) {
				console.warn(`[fetch-stops] Failed to download LIRR from ${u}: ${e.message}`);
			}
		}
		if (lirrBuf) {
			const lStopsCsv = extractFile(lirrBuf, /(^|\/)stops\.txt$/i);
			if (lStopsCsv) {
				const { stations: lStations, parentOf: lParentOf } = buildStationsAndParents(lStopsCsv);
				// Merge LIRR stations
				Object.assign(stations, lStations);

				// LIRR edges
				const lTripsCsv = extractFile(lirrBuf, /(^|\/)trips\.txt$/i);
				const lStopTimesCsv = extractFile(lirrBuf, /(^|\/)stop_times\.txt$/i);
				if (lTripsCsv && lStopTimesCsv) {
					const lTrips = parse(lTripsCsv, { columns: true, skip_empty_lines: true, trim: true });
					const lStopTimes = parse(lStopTimesCsv, { columns: true, skip_empty_lines: true, trim: true });
					const lRouteOfTrip = new Map();
					for (const t of lTrips) {
						const tripId = (t.trip_id || "").trim();
						const routeId = (t.route_id || "").trim();
						if (tripId && routeId) lRouteOfTrip.set(tripId, routeId);
					}
					const lTimesByTrip = new Map();
					for (const st of lStopTimes) {
						const tripId = (st.trip_id || "").trim();
						const stopId = (st.stop_id || "").trim();
						const seq = Number(st.stop_sequence);
						if (!tripId || !stopId || !Number.isFinite(seq)) continue;
						if (!lTimesByTrip.has(tripId)) lTimesByTrip.set(tripId, []);
						lTimesByTrip.get(tripId).push({ stopId, seq });
					}
					const lEdgeSetByRoute = new Map();
					for (const [tripId, arr] of lTimesByTrip) {
						const routeId = lRouteOfTrip.get(tripId);
						if (!routeId) continue;
						arr.sort((a, b) => a.seq - b.seq);
						for (let i = 0; i < arr.length - 1; i++) {
							const a = lParentOf[arr[i].stopId] || arr[i].stopId;
							const b = lParentOf[arr[i + 1].stopId] || arr[i + 1].stopId;
							if (!a || !b || a === b) continue;
							if (!lEdgeSetByRoute.has(routeId)) lEdgeSetByRoute.set(routeId, new Set());
							const key = a < b ? `${a}|${b}` : `${b}|${a}`;
							lEdgeSetByRoute.get(routeId).add(key);
						}
					}
					for (const [routeId, set] of lEdgeSetByRoute) {
						const arr = Array.from(set, (k) => k.split("|"));
						if (!edgesByRoute[routeId]) edgesByRoute[routeId] = arr;
						else edgesByRoute[routeId] = edgesByRoute[routeId].concat(arr);
					}
					console.log(`[fetch-stops] Merged LIRR edges for ${lEdgeSetByRoute.size} routes`);
				}
				console.log(`[fetch-stops] Merged ${Object.keys(lStations).length} LIRR stations`);
			}
		}
	} catch (e) {
		console.warn(`[fetch-stops] LIRR merge skipped due to error: ${e.message}`);
	}

	ensureDirFor(out);
	fs.writeFileSync(out, JSON.stringify(stations));
	console.log(`[fetch-stops] Wrote ${Object.keys(stations).length} stations to ${out}`);
	if (edgesByRoute && Object.keys(edgesByRoute).length) {
		const edgesOut = path.resolve(path.dirname(out), "route_edges.json");
		fs.writeFileSync(edgesOut, JSON.stringify(edgesByRoute));
		console.log(`[fetch-stops] Wrote edges for ${Object.keys(edgesByRoute).length} routes to ${edgesOut}`);
	}
	// Explicitly exit to avoid lingering open handles in some environments
	process.exit(0);
}

main().catch((err) => {
	console.error("[fetch-stops] Error:", err.message);
	process.exitCode = 1;
});
