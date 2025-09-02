const express = require("express");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");
// Use global fetch if available (Node 18+), else lazy-load node-fetch for Node <18
const fetch =
	typeof globalThis.fetch === "function"
		? globalThis.fetch.bind(globalThis)
		: (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const router = express.Router();

// MTA Feed URLs - No API key required!
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

// Cache for LIRR routes metadata (route_id -> { shortName, longName })
let LIRR_ROUTES_META = null;
async function getLirrRoutesMeta() {
	if (LIRR_ROUTES_META) return LIRR_ROUTES_META;
	// Prefer env override, else default S3 static zip
	const url = process.env.LIRR_GTFS_STATIC_URL || "https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip";
	try {
		const buf = await fetchBuffer(url);
		const AdmZip = require("adm-zip");
		const zip = new AdmZip(buf);
		const entry = zip.getEntries().find((e) => /(^|\/)routes\.txt$/i.test(e.entryName));
		if (!entry) {
			LIRR_ROUTES_META = new Map();
			return LIRR_ROUTES_META;
		}
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
	} catch (e) {
		console.warn("Failed to load LIRR routes metadata:", e.message);
		LIRR_ROUTES_META = new Map();
	}
	return LIRR_ROUTES_META;
}

// Get real-time data for a specific feed
router.get("/feed/:feedId", async (req, res) => {
	try {
		const feedId = req.params.feedId;
		const feedUrl = MTA_FEEDS[feedId];

		if (!feedUrl) {
			return res.status(404).json({ error: "Feed not found" });
		}

		const buffer = await fetchProto(feedUrl);
		const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

		let processedData = processFeedData(feed);
		if (feedId === "lirr") {
			const meta = await getLirrRoutesMeta();
			processedData = processedData.map((t) => {
				const m = meta.get(String(t.routeId)) || null;
				const display = m ? m.shortName || m.longName || String(t.routeId) : String(t.routeId);
				return { ...t, displayRoute: display };
			});
		}
		res.json(processedData);
	} catch (error) {
		console.error("Error fetching MTA feed:", error.message);
		res.status(500).json({ error: "Failed to fetch feed data", details: error.message });
	}
});

// Get all feeds
router.get("/feeds/all", async (req, res) => {
	try {
		const allFeedsData = await Promise.all(
			Object.entries(MTA_FEEDS).map(async ([feedId, feedUrl]) => {
				try {
					const buffer = await fetchProto(feedUrl);
					const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

					let data = processFeedData(feed);
					if (feedId === "lirr") {
						const meta = await getLirrRoutesMeta();
						data = data.map((t) => {
							const m = meta.get(String(t.routeId)) || null;
							const display = m ? m.shortName || m.longName || String(t.routeId) : String(t.routeId);
							return { ...t, displayRoute: display };
						});
					}
					return { feedId, data };
				} catch (error) {
					console.error(`Error processing feed ${feedId}:`, error.message);
					return { feedId, error: true, details: error.message };
				}
			})
		);

		res.json(allFeedsData.filter((f) => !f.error));
	} catch (error) {
		console.error("Error fetching all feeds:", error.message);
		res.status(500).json({ error: "Failed to fetch feeds", details: error.message });
	}
});

function processFeedData(feed) {
	// Combine VehiclePosition (with lat/lon) and TripUpdate into a single, deduplicated list per trip
	const results = [];
	const vehiclesByTrip = new Map(); // tripId -> vehicle object
	const now = Date.now();

	// 1) Parse vehicle positions first so we can prefer them for each trip
	feed.entity.forEach((entity) => {
		if (entity.vehicle) {
			const v = entity.vehicle;
			const pos = v.position || {};
			const tripId = v.trip && v.trip.tripId ? String(v.trip.tripId) : null;
			const routeId = v.trip && v.trip.routeId ? String(v.trip.routeId) : null;
			const lat = typeof pos.latitude === "number" ? pos.latitude : null;
			const lng = typeof pos.longitude === "number" ? pos.longitude : null;
			const bearing = typeof pos.bearing === "number" ? pos.bearing : null;
			const ts = v.timestamp ? Number(v.timestamp) * 1000 : null;
			const obj = {
				tripId: tripId || undefined,
				routeId: routeId || undefined,
				stopId: v.stopId || undefined,
				lat,
				lng,
				bearing,
				timestamp: ts ? new Date(ts) : now ? new Date(now) : undefined,
			};
			if (tripId) vehiclesByTrip.set(tripId, obj);
			results.push(obj);
		}
	});

	// 2) Parse trip updates; only add for trips without a vehicle position
	feed.entity.forEach((entity) => {
		if (!entity.tripUpdate) return;
		const tripUpdate = entity.tripUpdate;
		const tripId = tripUpdate.trip && tripUpdate.trip.tripId ? String(tripUpdate.trip.tripId) : null;
		const routeId = tripUpdate.trip && tripUpdate.trip.routeId ? String(tripUpdate.trip.routeId) : null;
		if (tripId && vehiclesByTrip.has(tripId)) {
			// Optionally enrich existing vehicle routeId if missing
			const v = vehiclesByTrip.get(tripId);
			if (routeId && !v.routeId) v.routeId = routeId;
			return; // vehicle already represents this trip
		}
		// Find the first stopTimeUpdate with a meaningful time
		const stu = Array.isArray(tripUpdate.stopTimeUpdate) ? tripUpdate.stopTimeUpdate : [];
		for (const stopUpdate of stu) {
			const arrivalTime = stopUpdate.arrival && stopUpdate.arrival.time ? Number(stopUpdate.arrival.time) : null;
			const departureTime =
				stopUpdate.departure && stopUpdate.departure.time ? Number(stopUpdate.departure.time) : null;
			if (arrivalTime || departureTime) {
				results.push({
					tripId: tripId || undefined,
					routeId: routeId || undefined,
					stopId: stopUpdate.stopId || undefined,
					arrival: arrivalTime ? new Date(arrivalTime * 1000) : null,
					departure: departureTime ? new Date(departureTime * 1000) : null,
					delay:
						stopUpdate.arrival && stopUpdate.arrival.delay
							? stopUpdate.arrival.delay
							: stopUpdate.departure && stopUpdate.departure.delay
							? stopUpdate.departure.delay
							: 0,
				});
				break; // only add one summary record per trip when no vehicle is present
			}
		}
	});

	return results;
}

module.exports = router;

async function fetchProto(url) {
	const response = await fetch(url, {
		headers: {
			Accept: "application/x-protobuf, application/octet-stream;q=0.9,*/*;q=0.8",
		},
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} fetching ${url}`);
	}
	const ab = await response.arrayBuffer();
	return Buffer.from(ab);
}

async function fetchBuffer(url) {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
	const ab = await r.arrayBuffer();
	return Buffer.from(ab);
}
