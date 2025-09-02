const express = require("express");
const path = require("path");
const fs = require("fs");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

// Use global fetch if available (Node 18+), else lazy-load node-fetch for Node <18
const fetchFn =
	typeof globalThis.fetch === "function"
		? globalThis.fetch.bind(globalThis)
		: (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const router = express.Router();

// MTA Feed URLs (same as in api/mta.js)
const MTA_FEEDS = {
	1234567: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
	ace: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
	bdfm: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
	g: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
	jz: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
	l: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
	nqrw: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
	si: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",
	// LIRR GTFS-realtime feed
	lirr: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr",
};

// OneBusAway / SIRI (Bus)
const OBA_BASE = process.env.BUSTIME_OBA_BASE || "https://bustime.mta.info/api/where";
const SIRI_BASE = process.env.BUSTIME_SIRI_BASE || "https://bustime.mta.info/api/siri";
function getBusApiKey() {
	const key = process.env.MTA_API_KEY;
	if (!key) throw new Error("Missing MTA BusTime API key (MTA_API_KEY)");
	return key;
}

// Static stations.json loader (merged subway + LIRR coordinates)
let STATIONS = null; // id -> {lat,lng,name}
let LIRR_STATION_IDS = null; // Set of LIRR stop_ids
let SUBWAY_PARENT_TO_CHILDREN = null; // parentId -> [platformIds]

async function ensureStaticLoaded() {
	if (STATIONS && LIRR_STATION_IDS && SUBWAY_PARENT_TO_CHILDREN) return;
	// stations.json path (written by backend/scripts/fetch_stops.js)
	const stationsPath = path.join(__dirname, "../../frontend/stations.json");
	try {
		const txt = fs.readFileSync(stationsPath, "utf8");
		STATIONS = JSON.parse(txt);
	} catch (e) {
		STATIONS = {};
	}
	// Build subway parent->children map and LIRR station id set by downloading static GTFS zips
	const { buildModeMaps } = await importStaticHelpers();
	try {
		const maps = await buildModeMaps();
		LIRR_STATION_IDS = maps.lirrStationIds;
		SUBWAY_PARENT_TO_CHILDREN = maps.subwayParentToChildren;
	} catch (e) {
		// Fallbacks
		LIRR_STATION_IDS = new Set();
		SUBWAY_PARENT_TO_CHILDREN = new Map();
	}
}

async function importStaticHelpers() {
	// Lazy-load small helper that downloads stops.txt for subway + LIRR and builds maps
	return {
		buildModeMaps: async function () {
			const AdmZip = require("adm-zip");
			const { parse } = require("csv-parse/sync");
			async function download(url) {
				const r = await fetchFn(url);
				if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
				const ab = await r.arrayBuffer();
				return Buffer.from(ab);
			}
			async function extractStops(zipUrl) {
				const buf = await download(zipUrl);
				const zip = new AdmZip(buf);
				const entry = zip.getEntries().find((e) => /(^|\/)stops\.txt$/i.test(e.entryName));
				if (!entry) return [];
				const txt = entry.getData().toString("utf8");
				return parse(txt, { columns: true, skip_empty_lines: true, trim: true });
			}

			// Subway static
			const subwayUrls = [
				process.env.GTFS_STATIC_URL,
				"https://static.mta.info/developers/data/nyct/subway/google_transit.zip",
				"https://www.mta.info/developers/data/nyct/subway/google_transit.zip",
				"http://web.mta.info/developers/data/nyct/subway/google_transit.zip",
			].filter(Boolean);
			let subwayStops = [];
			for (const u of subwayUrls) {
				try {
					subwayStops = await extractStops(u);
					if (subwayStops.length) break;
				} catch (_) {}
			}
			// Build parent->children map (platform stop_ids per station)
			const parentToChildren = new Map();
			for (const r of subwayStops) {
				const id = String(r.stop_id || "").trim();
				const parent = String(r.parent_station || "").trim();
				const lt = String(r.location_type || "").trim();
				if (parent) {
					if (!parentToChildren.has(parent)) parentToChildren.set(parent, new Set());
					parentToChildren.get(parent).add(id);
				} else if (lt !== "1" && id) {
					// Some feeds omit parent; synthesize parent as 1st 3 chars (NYCT) if plausible
					const guessParent = id.length >= 3 ? id.slice(0, 3) : id;
					if (!parentToChildren.has(guessParent)) parentToChildren.set(guessParent, new Set());
					parentToChildren.get(guessParent).add(id);
				}
			}

			// LIRR static
			const lirrUrls = [
				process.env.LIRR_GTFS_STATIC_URL,
				"https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip",
			].filter(Boolean);
			let lirrStops = [];
			for (const u of lirrUrls) {
				try {
					lirrStops = await extractStops(u);
					if (lirrStops.length) break;
				} catch (_) {}
			}
			const lirrStationIds = new Set();
			for (const r of lirrStops) {
				const id = String(r.stop_id || "").trim();
				const lt = String(r.location_type || "").trim();
				// Treat any listed id as candidate station; LIRR often lacks parent_station
				if (id && (lt === "1" || lt === "0" || lt === "")) {
					lirrStationIds.add(id);
				}
			}

			// Convert child sets to arrays
			const map = new Map();
			for (const [p, set] of parentToChildren.entries()) map.set(p, Array.from(set));
			return { subwayParentToChildren: map, lirrStationIds };
		},
	};
}

function haversine(a, b) {
	const R = 6371000;
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLon = toRad(b.lon - a.lon);
	const s1 = Math.sin(dLat / 2);
	const s2 = Math.sin(dLon / 2);
	const A = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
	return 2 * R * Math.atan2(Math.sqrt(A), Math.sqrt(1 - A));
}

function fmt24(date) {
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

function fmtDelta(now, when) {
	const ms = Math.max(0, when - now);
	const min = Math.round(ms / 60000);
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	return `${h} hr ${m} min`;
}

async function fetchProto(url) {
	const r = await fetchFn(url, {
		headers: { Accept: "application/x-protobuf, application/octet-stream;q=0.9,*/*;q=0.8" },
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
	const ab = await r.arrayBuffer();
	return Buffer.from(ab);
}

async function getSubwayArrivalsForStopIds(stopIds, maxPerRoute = 2) {
	// Query all NYCT feeds, filter TripUpdates by stopIds, collect arrivals grouped by routeId
	const feedKeys = Object.keys(MTA_FEEDS).filter((k) => k !== "lirr");
	const now = new Date();
	const grouped = new Map(); // routeId -> [{time, headsign, tripId, direction}]
	await Promise.all(
		feedKeys.map(async (key) => {
			try {
				const buf = await fetchProto(MTA_FEEDS[key]);
				const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
				for (const ent of feed.entity) {
					const tu = ent.tripUpdate;
					if (!tu) continue;
					const routeId = tu.trip && tu.trip.routeId ? String(tu.trip.routeId) : null;
					const tripId = tu.trip && tu.trip.tripId ? String(tu.trip.tripId) : null;
					const headsign = tu.trip && tu.trip.tripHeadsign ? String(tu.trip.tripHeadsign) : null;
					const dir =
						tu.trip && (tu.trip.directionId === 0 || tu.trip.directionId === 1)
							? tu.trip.directionId
							: null;
					if (!routeId) continue;
					const stus = Array.isArray(tu.stopTimeUpdate) ? tu.stopTimeUpdate : [];
					for (const s of stus) {
						const sid = s.stopId ? String(s.stopId) : null;
						if (!sid) continue;
						if (!stopIds.has(sid)) continue;
						const t =
							s.arrival && s.arrival.time
								? new Date(Number(s.arrival.time) * 1000)
								: s.departure && s.departure.time
								? new Date(Number(s.departure.time) * 1000)
								: null;
						if (!t) continue;
						if (!grouped.has(routeId)) grouped.set(routeId, []);
						grouped.get(routeId).push({ time: t, headsign, tripId, direction: dir });
					}
				}
			} catch (_) {}
		})
	);
	// Sort and trim per route
	const byRoute = [];
	for (const [routeId, arr] of grouped.entries()) {
		arr.sort((a, b) => a.time - b.time);
		byRoute.push({ routeId, arrivals: arr.slice(0, maxPerRoute) });
	}
	// Sort routes alphabetically/numerically for stable output
	byRoute.sort((a, b) => String(a.routeId).localeCompare(String(b.routeId), undefined, { numeric: true }));
	// Produce lines like: "7 to 34 St-Hudson Yards @ Flushing Main St at 19:30 (16 min) & 19:35 (21 min)"
	const lines = [];
	for (const { routeId, arrivals } of byRoute) {
		if (!arrivals.length) continue;
		const first = arrivals[0];
		const dest = first.headsign || "";
		const times = arrivals.map((a) => `${fmt24(a.time)} (${fmtDelta(now, a.time)})`).join(" & ");
		lines.push(`${routeId} to ${dest || "Unknown"} at ${times}`);
	}
	return lines;
}

// LIRR route metadata (route_id -> {shortName,longName})
let LIRR_ROUTES_META = null;
async function getLirrRoutesMeta() {
	if (LIRR_ROUTES_META) return LIRR_ROUTES_META;
	const url = process.env.LIRR_GTFS_STATIC_URL || "https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip";
	try {
		const buf = await fetchProto(url);
		const AdmZip = require("adm-zip");
		const zip = new AdmZip(buf);
		const entry = zip.getEntries().find((e) => /(^|\/)routes\.txt$/i.test(e.entryName));
		if (!entry) return (LIRR_ROUTES_META = new Map());
		const text = entry.getData().toString("utf8");
		const { parse } = require("csv-parse/sync");
		const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
		const map = new Map();
		for (const r of rows) {
			const id = String(r.route_id || "").trim();
			if (!id) continue;
			const shortName = (r.route_short_name || "").trim();
			const longName = (r.route_long_name || "").trim();
			map.set(id, { shortName, longName });
		}
		LIRR_ROUTES_META = map;
	} catch (_) {
		LIRR_ROUTES_META = new Map();
	}
	return LIRR_ROUTES_META;
}

function normalizeBranchName(name) {
	if (!name) return "";
	return String(name)
		.toLowerCase()
		.replace(/\(.*?\)/g, "")
		.replace(/\b(branch|line)\b/gi, "")
		.replace(/[\-–—]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

async function getLirrArrivalsForStationId(stationId, maxCount = 2, branchFilter = null) {
	const now = new Date();
	const buf = await fetchProto(MTA_FEEDS.lirr);
	const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
	const meta = await getLirrRoutesMeta();

	const matches = [];
	for (const ent of feed.entity) {
		const tu = ent.tripUpdate;
		if (!tu) continue;
		const routeId = tu.trip && tu.trip.routeId ? String(tu.trip.routeId) : null;
		const tripId = tu.trip && tu.trip.tripId ? String(tu.trip.tripId) : null;
		const headsign = tu.trip && tu.trip.tripHeadsign ? String(tu.trip.tripHeadsign) : null;
		const stus = Array.isArray(tu.stopTimeUpdate) ? tu.stopTimeUpdate : [];
		const disp =
			routeId && meta.get(routeId)
				? meta.get(routeId).shortName || meta.get(routeId).longName || routeId
				: routeId;
		const branchNorm = normalizeBranchName(disp);
		if (branchFilter && branchNorm !== branchFilter) continue;
		for (const s of stus) {
			const sid = s.stopId ? String(s.stopId) : null;
			if (!sid) continue;
			// Accept direct match or base form before space/hyphen/colon
			const base = sid.split(/[ \-:]/)[0];
			const targetBase = String(stationId).split(/[ \-:]/)[0];
			if (sid !== stationId && base !== targetBase) continue;
			const t =
				s.arrival && s.arrival.time
					? new Date(Number(s.arrival.time) * 1000)
					: s.departure && s.departure.time
					? new Date(Number(s.departure.time) * 1000)
					: null;
			if (!t) continue;
			matches.push({ time: t, headsign, routeId, display: disp, tripId });
		}
	}
	matches.sort((a, b) => a.time - b.time);
	const top = matches.slice(0, maxCount);
	return top.map(
		(m) => `${m.display ? "" : ""}To ${m.headsign || "Unknown"} at ${fmt24(m.time)} (${fmtDelta(now, m.time)})`
	);
}

async function obaStopsForLocation(lat, lon, opts = {}) {
	const key = getBusApiKey();
	const url = new URL(`${OBA_BASE}/stops-for-location.json`);
	const qs = new URLSearchParams({ key, lat: String(lat), lon: String(lon) });
	if (opts.radius) qs.set("radius", String(opts.radius));
	if (opts.maxCount) qs.set("maxCount", String(opts.maxCount));
	url.search = qs.toString();
	const r = await fetchFn(url.toString());
	if (!r.ok) throw new Error(`OBA ${r.status}`);
	return r.json();
}

async function siriArrivalsForStop(stopId, maxVisits = 3) {
	const key = getBusApiKey();
	const url = new URL(`${SIRI_BASE}/stop-monitoring.json`);
	const qs = new URLSearchParams({
		key,
		version: "2",
		MonitoringRef: String(stopId),
		MaximumStopVisits: String(maxVisits),
	});
	url.search = qs.toString();
	const r = await fetchFn(url.toString());
	if (!r.ok) throw new Error(`SIRI ${r.status}`);
	return r.json();
}

function parseSiriArrivals(json, maxPerLine = 2) {
	const now = new Date();
	const out = [];
	try {
		const deliveries = json.Siri && json.Siri.ServiceDelivery && json.Siri.ServiceDelivery.StopMonitoringDelivery;
		const d0 = Array.isArray(deliveries) ? deliveries[0] : deliveries;
		const visits = (d0 && d0.MonitoredStopVisit) || [];
		// Group by PublishedLineName
		const byLine = new Map();
		for (const v of visits) {
			const mvj = v.MonitoredVehicleJourney || {};
			const line = mvj.PublishedLineName || (mvj.LineRef ? String(mvj.LineRef).split("_").pop() : "?");
			const dest = mvj.DestinationName || "Unknown";
			const call = mvj.MonitoredCall || {};
			const ts =
				call.ExpectedArrivalTime ||
				call.AimedArrivalTime ||
				call.AimedDepartureTime ||
				call.ExpectedDepartureTime;
			const when = ts ? new Date(ts) : null;
			if (!when) continue;
			if (!byLine.has(line)) byLine.set(line, []);
			byLine.get(line).push({ when, dest });
		}
		for (const [line, arr] of byLine.entries()) {
			arr.sort((a, b) => a.when - b.when);
			const top = arr.slice(0, maxPerLine);
			const times = top.map((a) => `${fmt24(a.when)} (${fmtDelta(now, a.when)})`).join(" & ");
			out.push({ line, dest: top[0] ? top[0].dest : "Unknown", times });
		}
	} catch (_) {}
	return out;
}

function findNearestStations(lat, lon) {
	const here = { lat, lon };
	let nearestSubway = null;
	let nearestLirr = null;
	for (const [id, info] of Object.entries(STATIONS || {})) {
		if (!info || typeof info.lat !== "number" || typeof info.lng !== "number") continue;
		const d = haversine(here, { lat: info.lat, lon: info.lng });
		if (LIRR_STATION_IDS && LIRR_STATION_IDS.has(id)) {
			if (!nearestLirr || d < nearestLirr.dist)
				nearestLirr = { id, name: info.name, lat: info.lat, lon: info.lng, dist: d };
		} else {
			if (!nearestSubway || d < nearestSubway.dist)
				nearestSubway = { id, name: info.name, lat: info.lat, lon: info.lng, dist: d };
		}
	}
	return { nearestSubway, nearestLirr };
}

function stationStopIdsForSubway(parentId) {
	const ids = new Set();
	if (SUBWAY_PARENT_TO_CHILDREN && SUBWAY_PARENT_TO_CHILDREN.has(parentId)) {
		for (const c of SUBWAY_PARENT_TO_CHILDREN.get(parentId)) ids.add(String(c));
	} else {
		// Heuristic: parentId + N/S/E/W
		["N", "S", "E", "W"].forEach((suf) => ids.add(`${parentId}${suf}`));
	}
	return ids;
}

// Build string for /preliminary
router.get("/preliminary", async (req, res) => {
	try {
		const lat = Number(req.query.lat);
		const lon = Number(req.query.lon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon))
			return res.status(400).send("Bad request: lat/lon required");
		await ensureStaticLoaded();

		const { nearestSubway, nearestLirr } = findNearestStations(lat, lon);
		const linesOut = [];

		// Subway section
		if (nearestSubway) {
			const stopIds = stationStopIdsForSubway(nearestSubway.id);
			const subwayLines = await getSubwayArrivalsForStopIds(stopIds, 2);
			if (subwayLines.length) {
				linesOut.push("Subway:");
				subwayLines.forEach((ln, i) => {
					if (i === 0) {
						const idx = ln.indexOf(" at ");
						if (idx > 0) {
							linesOut.push(`${ln.slice(0, idx)} @ ${nearestSubway.name}${ln.slice(idx)}`);
						} else {
							linesOut.push(`${ln} @ ${nearestSubway.name}`);
						}
					} else {
						linesOut.push(ln);
					}
				});
			}
		}

		// Bus section (both directions if possible)
		try {
			const oba = await obaStopsForLocation(lat, lon, { radius: 400, maxCount: 10 });
			const stops = (oba && oba.data && (oba.data.list || oba.data.stops)) || [];
			// Pick two nearest distinct stops
			stops.sort(
				(a, b) =>
					haversine({ lat, lon }, { lat: a.lat, lon: a.lon }) -
					haversine({ lat, lon }, { lat: b.lat, lon: b.lon })
			);
			const selected = stops.slice(0, 2);
			const busLines = [];
			for (const s of selected) {
				const stopId = String(s.id || s.code || "")
					.split("_")
					.pop();
				const siri = await siriArrivalsForStop(stopId, 4);
				const parsed = parseSiriArrivals(siri, 2);
				for (const p of parsed) {
					busLines.push(`${p.line} to ${p.dest} @ ${s.name} at ${p.times}`);
				}
			}
			if (busLines.length) {
				linesOut.push("Bus:");
				busLines.forEach((ln) => linesOut.push(ln));
			}
		} catch (_) {}

		// LIRR section (only Port Washington branch and within 1 mile)
		if (nearestLirr && nearestLirr.dist <= 1609) {
			const pw = normalizeBranchName("port washington");
			const lirrLines = await getLirrArrivalsForStationId(nearestLirr.id, 2, pw);
			if (lirrLines.length) {
				linesOut.push("LIRR:");
				lirrLines.forEach((ln, i) => {
					if (i === 0) linesOut.push(`${ln} @ ${nearestLirr.name}`);
					else linesOut.push(ln);
				});
			}
		}

		// Join as a single string response
		const outStr = linesOut.join("\n");
		res.type("text/plain").send(outStr || "");
	} catch (e) {
		res.status(500).send(`Error: ${e.message}`);
	}
});

// Build string for /nearby (pick the single closest item and show 3 arrivals with more details)
router.get("/nearby", async (req, res) => {
	try {
		const lat = Number(req.query.lat);
		const lon = Number(req.query.lon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon))
			return res.status(400).send("Bad request: lat/lon required");
		await ensureStaticLoaded();

		// Find nearest subway and LIRR
		const { nearestSubway, nearestLirr } = findNearestStations(lat, lon);
		// Find nearest bus stop via OBA small radius
		let nearestBus = null;
		try {
			const oba = await obaStopsForLocation(lat, lon, { radius: 120, maxCount: 5 });
			const stops = (oba && oba.data && (oba.data.list || oba.data.stops)) || [];
			stops.sort(
				(a, b) =>
					haversine({ lat, lon }, { lat: a.lat, lon: a.lon }) -
					haversine({ lat, lon }, { lat: b.lat, lon: b.lon })
			);
			nearestBus = stops[0] || null;
		} catch (_) {}

		// Decide winning category within a small fixed radius (~120 m)
		const choices = [];
		if (nearestBus)
			choices.push({ type: "bus", dist: haversine({ lat, lon }, { lat: nearestBus.lat, lon: nearestBus.lon }) });
		if (nearestSubway) choices.push({ type: "subway", dist: nearestSubway.dist });
		if (nearestLirr) choices.push({ type: "lirr", dist: nearestLirr.dist });
		choices.sort((a, b) => a.dist - b.dist);
		const winner = choices[0];
		if (!winner || winner.dist > 150) {
			return res.type("text/plain").send("No nearby transit within ~150m");
		}

		const linesOut = [];
		if (winner.type === "bus" && nearestBus) {
			const stopId = String(nearestBus.id || nearestBus.code || "")
				.split("_")
				.pop();
			const siri = await siriArrivalsForStop(stopId, 6);
			const parsed = parseSiriArrivals(siri, 3);
			if (parsed.length) {
				linesOut.push("Bus:");
				parsed.forEach((p) => {
					linesOut.push(`${p.line} to ${p.dest} @ ${nearestBus.name} at ${p.times}`);
				});
			}
		} else if (winner.type === "subway" && nearestSubway) {
			const stopIds = stationStopIdsForSubway(nearestSubway.id);
			const subwayLines = await getSubwayArrivalsForStopIds(stopIds, 3);
			if (subwayLines.length) {
				linesOut.push("Subway:");
				subwayLines.forEach((ln, i) => {
					if (i === 0) {
						const idx = ln.indexOf(" at ");
						if (idx > 0) {
							linesOut.push(`${ln.slice(0, idx)} @ ${nearestSubway.name}${ln.slice(idx)}`);
						} else {
							linesOut.push(`${ln} @ ${nearestSubway.name}`);
						}
					} else {
						linesOut.push(ln);
					}
				});
			}
		} else if (winner.type === "lirr" && nearestLirr) {
			const lirrLines = await getLirrArrivalsForStationId(nearestLirr.id, 3, null);
			if (lirrLines.length) {
				linesOut.push("LIRR:");
				lirrLines.forEach((ln, i) => {
					const suffix = i === 0 ? ` @ ${nearestLirr.name}` : "";
					linesOut.push(`${ln}${suffix}`);
				});
			}
		}
		res.type("text/plain").send(linesOut.join("\n") || "");
	} catch (e) {
		res.status(500).send(`Error: ${e.message}`);
	}
});

module.exports = router;
