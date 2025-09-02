const express = require("express");
// Use global fetch if available (Node 18+), else lazy-load node-fetch for Node <18
const fetch =
	typeof globalThis.fetch === "function"
		? globalThis.fetch.bind(globalThis)
		: (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const router = express.Router();

const OBA_BASE = process.env.BUSTIME_OBA_BASE || "https://bustime.mta.info/api/where";
const SIRI_BASE = process.env.BUSTIME_SIRI_BASE || "https://bustime.mta.info/api/siri";

function getApiKey() {
	const key = process.env.MTA_API_KEY;
	if (!key) {
		throw new Error("Missing MTA BusTime API key. Set MTA_API_KEY in your environment.");
	}
	return key;
}

function num(v) {
	if (v === undefined) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function cleanStopIdForSiri(id) {
	if (!id) return id;
	const s = String(id);
	const idx = s.indexOf("_");
	return idx >= 0 ? s.slice(idx + 1) : s;
}

async function obaFetch(pathname, params = {}) {
	const key = getApiKey();
	const url = new URL(`${OBA_BASE}${pathname}`);
	const qs = new URLSearchParams({ key: String(key) });
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) qs.set(k, String(v));
	}
	url.search = qs.toString();
	const r = await fetch(url.toString());
	if (!r.ok) {
		const text = await r.text().catch(() => "");
		const msg = text ? `${r.status} ${text.slice(0, 200)}` : `${r.status}`;
		throw new Error(`OBA error: ${msg}`);
	}
	return r.json();
}

async function siriStopMonitoring(params = {}) {
	const key = getApiKey();
	const url = new URL(`${SIRI_BASE}/stop-monitoring.json`);
	const qs = new URLSearchParams({ key: String(key) });
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) qs.set(k, String(v));
	}
	url.search = qs.toString();
	const r = await fetch(url.toString());
	if (!r.ok) {
		const text = await r.text().catch(() => "");
		const msg = text ? `${r.status} ${text.slice(0, 200)}` : `${r.status}`;
		throw new Error(`SIRI error: ${msg}`);
	}
	return r.json();
}

// GET /api/bus/stops-for-location?lat=..&lon=..&radius=..&latSpan=..&lonSpan=..&query=..
router.get("/stops-for-location", async (req, res) => {
	try {
		const key = getApiKey();
		const lat = num(req.query.lat);
		const lon = num(req.query.lon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return res.status(400).json({ error: "lat and lon are required and must be numbers" });
		}

		const url = new URL(`${OBA_BASE}/stops-for-location.json`);
		const params = new URLSearchParams({ key: String(key), lat: String(lat), lon: String(lon) });

		const passthrough = ["radius", "latSpan", "lonSpan", "query", "includePolylines", "maxCount"];
		for (const p of passthrough) {
			if (req.query[p] !== undefined) params.set(p, String(req.query[p]));
		}
		url.search = params.toString();

		const r = await fetch(url.toString());
		if (!r.ok) {
			return res.status(r.status).json({ error: `Upstream error ${r.status}` });
		}
		const data = await r.json();
		res.json(data);
	} catch (err) {
		console.error("/stops-for-location error:", err.message);
		res.status(500).json({ error: "Failed to fetch stops-for-location", details: err.message });
	}
});

// GET /api/bus/stop-monitoring?stopId=308214&version=2&OperatorRef=MTA&LineRef=MTA%20NYCT_B63&DirectionRef=0&MaximumStopVisits=5&StopMonitoringDetailLevel=minimum
router.get("/stop-monitoring", async (req, res) => {
	try {
		const key = getApiKey();
		const stopId = req.query.MonitoringRef || req.query.stopId || req.query.StopId;
		if (!stopId) {
			return res.status(400).json({ error: "Missing stopId (or MonitoringRef)" });
		}
		const url = new URL(`${SIRI_BASE}/stop-monitoring.json`);
		const params = new URLSearchParams({ key: String(key) });

		// Defaults commonly used
		params.set("version", String(req.query.version || 2));
		params.set("MonitoringRef", String(stopId));
		if (req.query.OperatorRef) params.set("OperatorRef", String(req.query.OperatorRef));
		if (req.query.LineRef) params.set("LineRef", String(req.query.LineRef));
		if (req.query.DirectionRef !== undefined) params.set("DirectionRef", String(req.query.DirectionRef));
		if (req.query.MaximumStopVisits !== undefined)
			params.set("MaximumStopVisits", String(req.query.MaximumStopVisits));
		if (req.query.MinimumStopVisitsPerLine !== undefined)
			params.set("MinimumStopVisitsPerLine", String(req.query.MinimumStopVisitsPerLine));
		if (req.query.MaximumNumberOfCallsOnwards !== undefined)
			params.set("MaximumNumberOfCallsOnwards", String(req.query.MaximumNumberOfCallsOnwards));
		if (req.query.StopMonitoringDetailLevel)
			params.set("StopMonitoringDetailLevel", String(req.query.StopMonitoringDetailLevel));

		url.search = params.toString();

		const r = await fetch(url.toString());
		if (!r.ok) {
			return res.status(r.status).json({ error: `Upstream error ${r.status}` });
		}
		const data = await r.json();
		res.json(data);
	} catch (err) {
		console.error("/stop-monitoring error:", err.message);
		res.status(500).json({ error: "Failed to fetch stop-monitoring", details: err.message });
	}
});

// GET /api/bus/stops-for-agency?agencyId=MTA&includePolylines=false
router.get("/stops-for-agency", async (req, res) => {
	try {
		const agencyId = String(req.query.agencyId || "MTA");
		const includePolylines = req.query.includePolylines;
		const data = await obaFetch(`/stops-for-agency/${encodeURIComponent(agencyId)}.json`, {
			includePolylines,
		});
		res.json(data);
	} catch (err) {
		console.error("/stops-for-agency error:", err.message);
		res.status(500).json({ error: "Failed to fetch stops-for-agency", details: err.message });
	}
});

// GET /api/bus/routes-for-agency?agencyId=MTA
router.get("/routes-for-agency", async (req, res) => {
	try {
		const agencyId = String(req.query.agencyId || "MTA");
		const data = await obaFetch(`/routes-for-agency/${encodeURIComponent(agencyId)}.json`);
		res.json(data);
	} catch (err) {
		console.error("/routes-for-agency error:", err.message);
		res.status(500).json({ error: "Failed to fetch routes-for-agency", details: err.message });
	}
});

// GET /api/bus/stops-for-bounds?minLat=&minLon=&maxLat=&maxLon=&maxCount=&includePolylines=
router.get("/stops-for-bounds", async (req, res) => {
	try {
		const minLat = num(req.query.minLat);
		const minLon = num(req.query.minLon);
		const maxLat = num(req.query.maxLat);
		const maxLon = num(req.query.maxLon);
		if (![minLat, minLon, maxLat, maxLon].every(Number.isFinite)) {
			return res.status(400).json({ error: "minLat, minLon, maxLat, maxLon are required and must be numbers" });
		}
		const includePolylines = req.query.includePolylines;
		const maxCount = req.query.maxCount;

		let oba;
		let list = [];
		try {
			// Some OBA deployments may not support stops-for-bounds; try it first
			oba = await obaFetch(`/stops-for-bounds.json`, {
				minLat,
				minLon,
				maxLat,
				maxLon,
				includePolylines,
				maxCount,
			});
			list = (oba && oba.data && (oba.data.list || oba.data.stops)) || [];
		} catch (e) {
			// Fallback to stops-for-location using center + spans
			const lat = (minLat + maxLat) / 2;
			const lon = (minLon + maxLon) / 2;
			const latSpan = Math.abs(maxLat - minLat);
			const lonSpan = Math.abs(maxLon - minLon);
			oba = await obaFetch(`/stops-for-location.json`, {
				lat,
				lon,
				latSpan,
				lonSpan,
				includePolylines,
				maxCount,
			});
			list = (oba && oba.data && (oba.data.list || oba.data.stops)) || [];
		}
		res.json({ data: { list }, references: (oba && oba.references) || {} });
	} catch (err) {
		console.error("/stops-for-bounds error:", err.message);
		res.status(500).json({ error: "Failed to fetch stops-for-bounds", details: err.message });
	}
});

// GET /api/bus/stops-for-route?routeId=MTA%20NYCT_B63&includePolylines=true
router.get("/stops-for-route", async (req, res) => {
	try {
		const routeId = String(req.query.routeId || "").trim();
		if (!routeId) return res.status(400).json({ error: "routeId is required" });
		const includePolylines = req.query.includePolylines;
		const data = await obaFetch(`/stops-for-route/${encodeURIComponent(routeId)}.json`, {
			includePolylines,
		});
		res.json(data);
	} catch (err) {
		console.error("/stops-for-route error:", err.message);
		res.status(500).json({ error: "Failed to fetch stops-for-route", details: err.message });
	}
});

// GET /api/bus/stop/:id - Combined stop info (OBA where stop details + SIRI arrivals)
// Accepts optional query: agencyStopId (explicit OBA stop id like 'MTA_308214' or 'MTA NYCT_308214'),
// or agencyId (used to build agencyId_id for OBA). If neither provided, OBA details are skipped.
router.get("/stop/:id", async (req, res) => {
	const rawId = String(req.params.id);
	const agencyStopId = req.query.agencyStopId ? String(req.query.agencyStopId) : undefined;
	const agencyId = req.query.agencyId ? String(req.query.agencyId) : undefined;
	try {
		let obaStop = null;
		if (agencyStopId) {
			obaStop = await obaFetch(`/stop/${encodeURIComponent(agencyStopId)}.json`);
		} else if (agencyId) {
			const obaId = `${agencyId}_${rawId}`;
			try {
				obaStop = await obaFetch(`/stop/${encodeURIComponent(obaId)}.json`);
			} catch (e) {
				// swallow to allow SIRI-only result
				obaStop = null;
			}
		}

		const stopNumeric = cleanStopIdForSiri(agencyStopId || rawId);
		const siri = await siriStopMonitoring({
			version: String(req.query.version || 2),
			MonitoringRef: stopNumeric,
			OperatorRef: req.query.OperatorRef,
			LineRef: req.query.LineRef,
			DirectionRef: req.query.DirectionRef,
			MaximumStopVisits: req.query.MaximumStopVisits,
			MinimumStopVisitsPerLine: req.query.MinimumStopVisitsPerLine,
			MaximumNumberOfCallsOnwards: req.query.MaximumNumberOfCallsOnwards,
			StopMonitoringDetailLevel: req.query.StopMonitoringDetailLevel,
		});

		res.json({ obaStop, siri });
	} catch (err) {
		console.error("/stop/:id error:", err.message);
		res.status(500).json({ error: "Failed to fetch stop info", details: err.message });
	}
});

// GET /api/bus/stops-monitoring?stopIds=308214,308215&version=2&MaximumStopVisits=3
router.get("/stops-monitoring", async (req, res) => {
	try {
		const raw = String(req.query.stopIds || "");
		if (!raw) return res.status(400).json({ error: "stopIds is required (comma-separated)" });
		const ids = raw
			.split(",")
			.map((s) => cleanStopIdForSiri(s.trim()))
			.filter(Boolean);
		const version = String(req.query.version || 2);
		const baseParams = {
			OperatorRef: req.query.OperatorRef,
			LineRef: req.query.LineRef,
			DirectionRef: req.query.DirectionRef,
			MaximumStopVisits: req.query.MaximumStopVisits,
			MinimumStopVisitsPerLine: req.query.MinimumStopVisitsPerLine,
			MaximumNumberOfCallsOnwards: req.query.MaximumNumberOfCallsOnwards,
			StopMonitoringDetailLevel: req.query.StopMonitoringDetailLevel,
		};
		const results = await Promise.all(
			ids.map((id) =>
				siriStopMonitoring({ ...baseParams, version, MonitoringRef: id }).catch((e) => ({
					error: e.message,
					id,
				}))
			)
		);
		res.json({ results });
	} catch (err) {
		console.error("/stops-monitoring error:", err.message);
		res.status(500).json({ error: "Failed to fetch stops monitoring", details: err.message });
	}
});

module.exports = router;
