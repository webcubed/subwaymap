const BUS_API_BASE = "/api/bus";

let map;
let stopMarkersLayer;
let busMarkersLayer;
let busStopLinesLayer;
let autoTimer;
let currentRenderId = 0; // used to abort in-flight renders when refreshing/moving
let userLocationMarker;
let userLocationCircle;

// Caches and references
const ROUTE_SEQ_CACHE = new Map(); // key: routeId -> { dir0: [stopIds], dir1: [stopIds], fetchedAt }
let ROUTE_REFS = { byId: new Map(), byShort: new Map() }; // OBA references for routes
let STOP_INDEX = new Map(); // key: OBA stop id (e.g., MTA_308214) -> { lat, lon, name, id }
// Track routes observed in SIRI to guide line drawing when references are sparse
const SIRI_ROUTE_IDS = new Set(); // full OBA route ids from LineRef when available

// Filters: active route:dir pairs. Example entries: 'Q28:0', 'Q28:1'
const ACTIVE_ROUTE_DIRS = new Set();
// Helper mapping from shortName -> full OBA route id
const SHORT_TO_FULL = new Map();

function yieldToBrowser() {
	return new Promise((resolve) => {
		if (typeof window.requestIdleCallback === "function") {
			window.requestIdleCallback(() => resolve());
		} else {
			setTimeout(resolve, 0);
		}
	});
}

function initMap() {
	map = L.map("map").setView([40.7128, -74.006], 12);
	L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
		maxZoom: 19,
		attribution: "&copy; OpenStreetMap contributors",
	}).addTo(map);
	stopMarkersLayer = L.layerGroup().addTo(map);
	busMarkersLayer = L.layerGroup().addTo(map);
	busStopLinesLayer = L.layerGroup().addTo(map);
}

function setStatus(msg) {
	const el = document.getElementById("status");
	if (el) el.textContent = msg;
}

async function fetchStopsInView() {
	const b = map.getBounds();
	const params = new URLSearchParams({
		minLat: b.getSouth(),
		minLon: b.getWest(),
		maxLat: b.getNorth(),
		maxLon: b.getEast(),
		maxCount: 10000,
	});
	const res = await fetch(`${BUS_API_BASE}/stops-for-bounds?${params.toString()}`);
	if (!res.ok) throw new Error(`stops-for-bounds ${res.status}`);
	return res.json();
}

function classifyBusRouteByMeta(meta, fallbackLabel) {
	const name = (meta && (meta.shortName || meta.longName || meta.desc)) || fallbackLabel || "";
	const id = (meta && meta.id) || "";
	const norm = String(name).toUpperCase();
	const normId = String(id).toUpperCase();
	// Heuristics:
	// - SBS: contains 'SBS' or 'SELECT BUS'
	if (/SBS|SELECT BUS/.test(norm)) return "sbs";
	// - Rush: contains 'RUSH' (Queens redesign) or route id includes '-RUSH' in future OBA data
	if (/RUSH/.test(norm) || /RUSH/.test(normId)) return "rush";
	return "regular";
}

function routeBadge(routeLabel, routeMeta, overrideCls) {
	const cls = overrideCls || classifyBusRouteByMeta(routeMeta, routeLabel);
	const palette = {
		regular: { bg: "#0b3d91", fg: "#ffffff" }, // dark blue
		sbs: { bg: "#60a5fa", fg: "#0b3d91" }, // light blue
		rush: { bg: "#7e22ce", fg: "#ffffff" }, // purple
	};
	const { bg, fg } = palette[cls] || palette.regular;
	const text = String(routeLabel || "").replace(/\s+/g, "");
	return { html: `<span class="bus-badge" style="background:${bg};color:${fg};">${text}</span>`, bg, fg, cls };
}

function clearLayers() {
	stopMarkersLayer.clearLayers();
	busMarkersLayer.clearLayers();
	busStopLinesLayer.clearLayers();
	STOP_INDEX.clear();
}

async function refresh() {
	try {
		const renderId = ++currentRenderId;
		setStatus("Loading stops...");
		clearLayers();
		const data = await fetchStopsInView();
		const stops = (data && data.data && data.data.list) || [];
		// Capture route references for classification/lookups
		const refs = (data && data.references) || {};
		ROUTE_REFS = { byId: new Map(), byShort: new Map() };
		SHORT_TO_FULL.clear();
		if (refs.routes && Array.isArray(refs.routes)) {
			for (const r of refs.routes) {
				if (!r) continue;
				ROUTE_REFS.byId.set(String(r.id), r);
				if (r.shortName) ROUTE_REFS.byShort.set(String(r.shortName).toUpperCase(), r);
				if (r.shortName) SHORT_TO_FULL.set(String(r.shortName).toUpperCase(), String(r.id));
			}
		}
		// Fallback/augmentation: derive routes from in-view stops and SIRI LineRefs when references are sparse
		const derivedShortToFull = new Map();
		// From stops' routeIds
		for (const s of stops) {
			const rids = Array.isArray(s && s.routeIds) ? s.routeIds.map(String) : [];
			for (const rid of rids) {
				const short = deriveShortFromRouteId(rid);
				if (!short) continue;
				if (!ROUTE_REFS.byId.has(rid)) {
					// create minimal meta if not present
					const meta = { id: String(rid), shortName: short, longName: "", desc: "" };
					ROUTE_REFS.byId.set(String(rid), meta);
				}
				const key = short.toUpperCase();
				if (!ROUTE_REFS.byShort.has(key)) ROUTE_REFS.byShort.set(key, ROUTE_REFS.byId.get(String(rid)));
				if (!SHORT_TO_FULL.has(key)) SHORT_TO_FULL.set(key, String(rid));
				if (!derivedShortToFull.has(key)) derivedShortToFull.set(key, String(rid));
			}
		}
		// From SIRI-observed route ids
		for (const rid of SIRI_ROUTE_IDS) {
			const short = deriveShortFromRouteId(rid);
			if (!short) continue;
			if (!ROUTE_REFS.byId.has(rid)) {
				const meta = { id: String(rid), shortName: short, longName: "", desc: "" };
				ROUTE_REFS.byId.set(String(rid), meta);
			}
			const key = short.toUpperCase();
			if (!ROUTE_REFS.byShort.has(key)) ROUTE_REFS.byShort.set(key, ROUTE_REFS.byId.get(String(rid)));
			if (!SHORT_TO_FULL.has(key)) SHORT_TO_FULL.set(key, String(rid));
			if (!derivedShortToFull.has(key)) derivedShortToFull.set(key, String(rid));
		}
		// Build or update routes sidebar
		await ensureSomeRoutesAvailable();
		buildRoutesSidebar();
		const stopIds = await renderStopsChunked(stops, renderId);

		// If a new refresh started during rendering, abort
		if (renderId !== currentRenderId) return;

		if (stopIds.length) {
			await fetchAndRenderBusesInBatches(stopIds, renderId);
		}
		// Draw connection lines between stops for visible routes/directions
		await drawBusStopLinesInView();
		setStatus(`Showing ${stopIds.length} stops`);
	} catch (e) {
		console.error(e);
		setStatus(`Error: ${e.message}`);
	}
}

async function renderStopsChunked(stops, renderId) {
	const stopIds = [];
	const total = stops.length || 0;
	const chunkSize = 200;
	for (let i = 0; i < total; i += chunkSize) {
		if (renderId !== currentRenderId) break; // abort if a new refresh started
		const slice = stops.slice(i, i + chunkSize);
		const markers = [];
		for (const s of slice) {
			if (!s || !s.lat || !s.lon) continue;
			// Filter stops by active route/direction selection (if any)
			if (!stopMatchesFilters(s)) continue;
			const id = String(s.code || s.id || "")
				.replace(/^.*_/, "")
				.trim();
			if (id) stopIds.push(id);
			// Build stop index by OBA id (e.g., MTA_308214) for route sequences
			if (s.id) {
				STOP_INDEX.set(String(s.id), {
					id: String(s.id),
					lat: s.lat,
					lon: s.lon,
					name: s.name || "Stop",
					routeIds: Array.isArray(s.routeIds) ? s.routeIds.map(String) : [],
				});
			}
			const marker = L.circleMarker([s.lat, s.lon], {
				radius: 4,
				color: "#111827",
				weight: 1,
				fillColor: "#22c55e",
				fillOpacity: 0.9,
			});
			// Bind popup with lazy-loaded arrivals
			marker.bindPopup(
				`<div id="stop-${cssEscapeId(s.id)}"><strong>${s.name || "Stop"}</strong><br/>ID: ${
					s.code || s.id
				}<div class="stop-arrivals">Tap to load arrivals…</div></div>`
			);
			marker.on("popupopen", () => loadStopArrivalsIntoPopup(s));
			markers.push(marker);
		}
		// Add this chunk's markers to the map
		markers.forEach((m) => stopMarkersLayer.addLayer(m));
		setStatus(`Rendering ${Math.min(i + chunkSize, total)} / ${total} stops...`);
		await yieldToBrowser();
	}
	return stopIds;
}

function renderBusesFromSiri(payload) {
	if (!payload || !payload.results) return;
	for (const r of payload.results) {
		if (!r || r.error) continue;
		const sm = r.Siri || r;
		const deliveries = (sm.ServiceDelivery && sm.ServiceDelivery.StopMonitoringDelivery) || [];
		deliveries.forEach((d) => {
			const visits = d.MonitoredStopVisit || [];
			visits.forEach((v) => {
				const mvj = v.MonitoredVehicleJourney;
				if (!mvj) return;
				const route = mvj.PublishedLineName || mvj.LineRef || "BUS";
				// Capture full LineRef when present to drive candidate route selection
				if (mvj.LineRef && typeof mvj.LineRef === "string") {
					SIRI_ROUTE_IDS.add(String(mvj.LineRef));
				}
				const veh = mvj.VehicleLocation;
				const lat = veh && veh.Latitude;
				const lon = veh && veh.Longitude;
				if (!lat || !lon) return;
				// Filter buses by active route/direction if any
				if (!vehicleMatchesFilters(mvj, route)) return;
				// Lookup route meta for styling
				const routeLabel = String(route).replace(/\s+/g, "");
				const meta = ROUTE_REFS.byShort.get(routeLabel.toUpperCase()) || null;
				// If destination mentions "Rush", force purple classification for this vehicle
				const mc =
					mvj.MonitoredCall ||
					(mvj.OnwardCalls && mvj.OnwardCalls.OnwardCall && mvj.OnwardCalls.OnwardCall[0]) ||
					{};
				const isRush = hasRushKeyword(mvj.DestinationName, mc.DestinationDisplay);
				const badge = routeBadge(routeLabel, meta, isRush ? "rush" : undefined);
				// Optional arrow showing bearing
				const bearing = typeof mvj.Bearing === "number" ? mvj.Bearing : null;
				const arrowSvg =
					bearing === null
						? ""
						: `
					<svg class="bus-bearing" width="16" height="16" viewBox="0 0 24 24" style="transform: rotate(${bearing}deg);">
						<path d="M12 2l5 9h-3v11h-4V11H7l5-9z" fill="${badge.bg}" stroke="white" stroke-width="0.5" />
					</svg>`;
				const html = `<div class="bus-icon-wrap">${badge.html}${arrowSvg}</div>`;
				const icon = L.divIcon({
					className: "bus-icon",
					html,
					iconSize: [48, 20],
					iconAnchor: [24, 10],
				});
				const marker = L.marker([lat, lon], { icon });

				// Build a richer popup with additional info from SIRI, when available
				const fmtTime = (t) => {
					if (!t) return null;
					try {
						const dt = new Date(t);
						if (!isNaN(dt)) return dt.toLocaleTimeString();
					} catch (_) {}
					return String(t);
				};
				const details = [];
				if (mvj.DestinationName)
					details.push(`<div><strong>Destination:</strong> ${mvj.DestinationName}</div>`);
				if (mvj.OriginName) details.push(`<div><strong>Origin:</strong> ${mvj.OriginName}</div>`);
				if (mvj.DirectionRef !== undefined)
					details.push(`<div><strong>Direction:</strong> ${mvj.DirectionRef}</div>`);
				if (mvj.VehicleRef) details.push(`<div><strong>Vehicle:</strong> ${mvj.VehicleRef}</div>`);
				if (mvj.Bearing !== undefined) details.push(`<div><strong>Bearing:</strong> ${mvj.Bearing}°</div>`);
				if (typeof mvj.InCongestion !== "undefined")
					details.push(`<div><strong>In Congestion:</strong> ${mvj.InCongestion}</div>`);
				if (mvj.ProgressRate) details.push(`<div><strong>Progress:</strong> ${mvj.ProgressRate}</div>`);
				// MonitoredCall info (next stop + timing)
				const parseDate = (t) => {
					if (!t) return null;
					try {
						const d = new Date(t);
						return isNaN(d) ? null : d;
					} catch {
						return null;
					}
				};
				const fmtCountdown = (dt) => {
					if (!dt) return "";
					const diffMs = dt.getTime() - Date.now();
					const sign = diffMs < 0 ? -1 : 1;
					const ms = Math.abs(diffMs);
					const totalSec = Math.round(ms / 1000);
					const m = Math.floor(totalSec / 60);
					const s = totalSec % 60;
					if (sign < 0) return m > 0 ? `${m}m ${s}s ago` : `${s}s ago`;
					if (m === 0 && s <= 10) return "due";
					return m > 0 ? `in ${m}m ${s}s` : `in ${s}s`;
				};
				const nextName =
					mc.StopPointName ||
					(mvj.OnwardCalls &&
						mvj.OnwardCalls.OnwardCall &&
						mvj.OnwardCalls.OnwardCall[0] &&
						mvj.OnwardCalls.OnwardCall[0].StopPointName);
				const nextRef =
					mc.StopPointRef ||
					(mvj.OnwardCalls &&
						mvj.OnwardCalls.OnwardCall &&
						mvj.OnwardCalls.OnwardCall[0] &&
						mvj.OnwardCalls.OnwardCall[0].StopPointRef);
				const nextArrDt = parseDate(mc.ExpectedArrivalTime || mc.AimedArrivalTime);
				const nextDepDt = parseDate(mc.ExpectedDepartureTime || mc.AimedDepartureTime);
				const nextCountdown = nextArrDt ? fmtCountdown(nextArrDt) : nextDepDt ? fmtCountdown(nextDepDt) : "";
				if (nextName || nextRef) {
					const idPart = nextRef ? ` <span style="color:#6b7280">(${nextRef})</span>` : "";
					const whenPart = nextCountdown ? ` · <strong>${nextCountdown}</strong>` : "";
					details.push(
						`<div><strong>Next stop:</strong> ${nextName || "(unknown)"}${idPart}${whenPart}</div>`
					);
				}
				const expArr = fmtTime(mc.ExpectedArrivalTime || mc.AimedArrivalTime);
				if (expArr) details.push(`<div><strong>Expected arrival:</strong> ${expArr}</div>`);
				const expDep = fmtTime(mc.ExpectedDepartureTime || mc.AimedDepartureTime);
				if (expDep) details.push(`<div><strong>Expected departure:</strong> ${expDep}</div>`);
				const dist = mc.Extensions && mc.Extensions.Distances;
				if (dist) {
					if (dist.PresentableDistance)
						details.push(`<div><strong>Distance:</strong> ${dist.PresentableDistance}</div>`);
					if (typeof dist.StopsFromCall === "number")
						details.push(`<div><strong>Stops away:</strong> ${dist.StopsFromCall}</div>`);
					if (typeof dist.DistanceFromCall === "number")
						details.push(
							`<div><strong>Distance from stop:</strong> ${Math.round(dist.DistanceFromCall)} m</div>`
						);
				}
				const recorded = v.RecordedAtTime || d.ResponseTimestamp;
				const rec = fmtTime(recorded);
				if (rec) details.push(`<div><strong>Last update:</strong> ${rec}</div>`);

				const popupHtml = `
					<div>
						<div style="margin-bottom:6px;"><strong>${String(route)}</strong></div>
						${details.join("") || "<div>No additional data</div>"}
					</div>
				`;
				marker.bindPopup(popupHtml);
				busMarkersLayer.addLayer(marker);
			});
		});
	}
}

async function fetchRouteStopSequence(routeId) {
	if (ROUTE_SEQ_CACHE.has(routeId)) return ROUTE_SEQ_CACHE.get(routeId);
	const params = new URLSearchParams({ routeId, includePolylines: false });
	const res = await fetch(`${BUS_API_BASE}/stops-for-route?${params.toString()}`);
	if (!res.ok) throw new Error(`stops-for-route ${res.status}`);
	const data = await res.json();
	// Expect data.data.entry + data.data.references
	const entry = data && data.data && data.data.entry;
	const stopGroupings = entry && entry.stopGroupings;
	const out = { dir0: [], dir1: [], dirNames: {} };
	if (Array.isArray(stopGroupings)) {
		for (const g of stopGroupings) {
			if (!g || g.id !== "direction" || !Array.isArray(g.stopGroups)) continue;
			for (const sg of g.stopGroups) {
				const dirId = String(sg.id || sg.name || "");
				const list = (sg && sg.stopIds) || [];
				const name = (sg && ((sg.name && (sg.name.name || sg.name)) || sg.name)) || String(dirId);
				if (/^0$|NORTH|EAST|NB|EB/i.test(dirId)) {
					out.dir0 = list.slice();
					out.dirNames[0] = String(name);
				} else if (/^1$|SOUTH|WEST|SB|WB/i.test(dirId)) {
					out.dir1 = list.slice();
					out.dirNames[1] = String(name);
				}
			}
		}
	}
	ROUTE_SEQ_CACHE.set(routeId, out);
	return out;
}

async function drawBusStopLinesInView() {
	if (!map || !busStopLinesLayer) return;
	busStopLinesLayer.clearLayers();
	const bounds = map.getBounds();
	// Build candidate route list:
	// 1) Use selected filters if any (full OBA route ids)
	// 2) Else, derive from in-view stops' routeIds (most relevant)
	// 3) Else, use routes seen in SIRI LineRef
	// 4) Else, fall back to all referenced route ids
	let candidateRoutes = [];
	const selected = getSelectedRouteIds();
	if (selected.length) {
		candidateRoutes = selected;
	} else {
		const counts = new Map();
		STOP_INDEX.forEach((info) => {
			const p = L.latLng(info.lat, info.lon);
			if (!bounds.contains(p)) return;
			const rids = Array.isArray(info.routeIds) ? info.routeIds : [];
			rids.forEach((rid) => counts.set(rid, (counts.get(rid) || 0) + 1));
		});
		if (counts.size > 0) {
			candidateRoutes = Array.from(counts.entries())
				.sort((a, b) => b[1] - a[1])
				.map(([rid]) => rid);
		} else if (SIRI_ROUTE_IDS.size > 0) {
			candidateRoutes = Array.from(SIRI_ROUTE_IDS);
		} else {
			candidateRoutes = Array.from(ROUTE_REFS.byId.keys());
		}
	}
	// Fetch more sequences to show more lines; keep a sane upper bound
	const limit = Math.min(candidateRoutes.length, 60);
	let fetched = 0;
	for (const routeId of candidateRoutes) {
		if (fetched >= limit) break;
		// Quick filter: if fewer than 2 of its stops are currently indexed and in bounds, skip fetching sequence
		// We can't know without fetching; proceed but continue limiting total.
		try {
			const seq = await fetchRouteStopSequence(routeId);
			fetched++;
			const meta = ROUTE_REFS.byId.get(routeId);
			const cls = classifyBusRouteByMeta(meta, meta && meta.shortName);
			const color = cls === "sbs" ? "#60a5fa" : cls === "rush" ? "#7e22ce" : "#0b3d91";

			for (const dirKey of ["dir0", "dir1"]) {
				const arr = seq[dirKey] || [];
				const dirNum = dirKey === "dir0" ? 0 : 1;
				if (!directionAllowedForRoute(routeId, dirNum)) continue;
				if (arr.length < 2) continue;
				// Walk consecutive pairs; if both stops exist and are in view, draw a line
				for (let i = 0; i < arr.length - 1; i++) {
					const aId = String(arr[i]);
					const bId = String(arr[i + 1]);
					const a = STOP_INDEX.get(aId);
					const b = STOP_INDEX.get(bId);
					if (!a || !b) continue;
					const pa = L.latLng(a.lat, a.lon);
					const pb = L.latLng(b.lat, b.lon);
					if (!bounds.contains(pa) || !bounds.contains(pb)) continue;
					// Skip absurdly long segments in degrees (~ > 0.5 deg)
					const dist = Math.hypot(pa.lat - pb.lat, pa.lng - pb.lng);
					if (dist > 0.5) continue;
					const line = L.polyline(
						[
							[a.lat, a.lon],
							[b.lat, b.lon],
						],
						{ color, weight: 2.5, opacity: 0.8 }
					);
					line.addTo(busStopLinesLayer);
					if (typeof line.bringToFront === "function") line.bringToFront();
				}
			}
		} catch (e) {
			// ignore individual route errors
		}
	}
}

// -------------------- Filters and UI --------------------
async function fetchAndRenderBusesInBatches(stopIds, renderId) {
	setStatus("Loading arrivals...");
	// Batch size: keep small to avoid very long URLs and upstream load; 40 is safe
	const batchSize = 40;
	const batches = [];
	for (let i = 0; i < stopIds.length; i += batchSize) {
		batches.push(stopIds.slice(i, i + batchSize));
	}
	for (let i = 0; i < batches.length; i++) {
		if (renderId !== currentRenderId) return; // abort if view changed
		const idsBatch = batches[i];
		const params = new URLSearchParams({
			stopIds: idsBatch.join(","),
			MaximumStopVisits: 3,
			version: 2,
			StopMonitoringDetailLevel: "minimum",
		});
		if (ACTIVE_ROUTE_DIRS.size === 1) {
			const only = Array.from(ACTIVE_ROUTE_DIRS)[0];
			const [short, dirStr] = only.split(":");
			const full = SHORT_TO_FULL.get(short.toUpperCase());
			if (full) params.set("LineRef", full);
			if (dirStr !== undefined) params.set("DirectionRef", String(dirStr));
		}
		try {
			const res = await fetch(`${BUS_API_BASE}/stops-monitoring?${params.toString()}`);
			if (res.ok) {
				const payload = await res.json();
				renderBusesFromSiri(payload);
				buildRoutesSidebar();
			}
		} catch (e) {
			// ignore per-batch errors
		}
		// Small delay between batches to smooth loading but keep close timing
		await new Promise((r) => setTimeout(r, 250));
	}
	setStatus(`Showing ${STOP_INDEX.size} stops`);
}
function getSelectedRouteIds() {
	// Convert ACTIVE_ROUTE_DIRS to full OBA route ids
	const shorts = new Set(Array.from(ACTIVE_ROUTE_DIRS).map((k) => k.split(":")[0].toUpperCase()));
	const ids = [];
	shorts.forEach((s) => {
		const full = SHORT_TO_FULL.get(s);
		if (full) ids.push(full);
	});
	return ids;
}

function directionAllowedForRoute(routeId, dir) {
	if (ACTIVE_ROUTE_DIRS.size === 0) return true; // no filters
	// find short for routeId
	const meta = ROUTE_REFS.byId.get(routeId);
	const short = meta && meta.shortName ? meta.shortName.toUpperCase() : null;
	if (!short) return false;
	return ACTIVE_ROUTE_DIRS.has(`${short}:${dir}`);
}

function vehicleMatchesFilters(mvj, routeLabel) {
	if (ACTIVE_ROUTE_DIRS.size === 0) return true;
	const short = String(routeLabel || "")
		.replace(/\s+/g, "")
		.toUpperCase();
	const dir = typeof mvj.DirectionRef === "number" ? mvj.DirectionRef : Number(mvj.DirectionRef);
	if (Number.isFinite(dir)) {
		return ACTIVE_ROUTE_DIRS.has(`${short}:${dir}`);
	}
	// If no dir available, allow if both directions are selected
	return ACTIVE_ROUTE_DIRS.has(`${short}:0`) && ACTIVE_ROUTE_DIRS.has(`${short}:1`);
}

function stopMatchesFilters(stop) {
	if (ACTIVE_ROUTE_DIRS.size === 0) return true;
	const routeIds = Array.isArray(stop.routeIds) ? stop.routeIds.map(String) : [];
	if (!routeIds.length) return false;
	// For each active pair, check if stop is served by that route id AND in that direction sequence
	for (const pair of ACTIVE_ROUTE_DIRS) {
		const [short, dirStr] = pair.split(":");
		const fullId = SHORT_TO_FULL.get(short);
		if (!fullId) continue;
		if (!routeIds.includes(fullId)) continue;
		const dir = Number(dirStr);
		// Ensure membership in the chosen direction sequence
		const seq = ROUTE_SEQ_CACHE.get(fullId);
		if (!seq) {
			// If we don't have the sequence yet, optimistically include; we'll refine on redraw
			return true;
		}
		const list = dir === 0 ? seq.dir0 : seq.dir1;
		if (Array.isArray(list) && list.includes(String(stop.id))) return true;
	}
	return false;
}

function buildRoutesSidebar() {
	const container = document.getElementById("routesList");
	if (!container) return;
	const routes = Array.from(ROUTE_REFS.byShort.keys()).sort((a, b) =>
		a.localeCompare(b, undefined, { numeric: true })
	);
	if (!routes.length) {
		container.innerHTML = `<div class="routes-empty">No routes found in view. Loading agency routes…</div>`;
		return;
	}
	const html = routes
		.map((short) => {
			const meta = ROUTE_REFS.byShort.get(short);
			const badge = routeBadge(short, meta);
			const id = ROUTE_REFS.byShort.get(short).id;
			const seq = ROUTE_SEQ_CACHE.get(id);
			const d0 = (seq && seq.dirNames && seq.dirNames[0]) || "Dir 0";
			const d1 = (seq && seq.dirNames && seq.dirNames[1]) || "Dir 1";
			const a0 = ACTIVE_ROUTE_DIRS.has(`${short}:${0}`) ? "active" : "";
			const a1 = ACTIVE_ROUTE_DIRS.has(`${short}:${1}`) ? "active" : "";
			return `
				<div class="route-row" data-short="${short}">
					<button class="route-badge-btn" data-action="toggle-route" data-short="${short}">${badge.html}</button>
					<div class="dir-buttons">
						<span class="dir-chip ${a0}" data-action="toggle-dir" data-short="${short}" data-dir="0">${d0}</span>
						<span class="dir-chip ${a1}" data-action="toggle-dir" data-short="${short}" data-dir="1">${d1}</span>
					</div>
				</div>`;
		})
		.join("");
	container.innerHTML = html;
	container.onclick = async (e) => {
		const t = e.target;
		if (!t || !t.dataset) return;
		if (t.dataset.action === "toggle-route" && t.dataset.short) {
			const s = t.dataset.short.toUpperCase();
			// Toggle both directions
			const has0 = ACTIVE_ROUTE_DIRS.has(`${s}:0`);
			const has1 = ACTIVE_ROUTE_DIRS.has(`${s}:1`);
			if (has0 || has1) {
				ACTIVE_ROUTE_DIRS.delete(`${s}:0`);
				ACTIVE_ROUTE_DIRS.delete(`${s}:1`);
			} else {
				ACTIVE_ROUTE_DIRS.add(`${s}:0`);
				ACTIVE_ROUTE_DIRS.add(`${s}:1`);
				// Ensure sequence cached to label directions properly
				const full = SHORT_TO_FULL.get(s);
				if (full) {
					try {
						await fetchRouteStopSequence(full);
					} catch {}
				}
			}
			// Rebuild to update active states
			buildRoutesSidebar();
			// Re-render view
			refresh();
		} else if (t.dataset.action === "toggle-dir" && t.dataset.short) {
			const s = t.dataset.short.toUpperCase();
			const d = Number(t.dataset.dir);
			const key = `${s}:${d}`;
			if (ACTIVE_ROUTE_DIRS.has(key)) ACTIVE_ROUTE_DIRS.delete(key);
			else ACTIVE_ROUTE_DIRS.add(key);
			// Ensure sequence cached
			const full = SHORT_TO_FULL.get(s);
			if (full) {
				try {
					await fetchRouteStopSequence(full);
				} catch {}
			}
			buildRoutesSidebar();
			refresh();
		}
	};
}

function cssEscapeId(id) {
	return String(id).replace(/[^A-Za-z0-9_\-:.]/g, "_");
}

function extractNumericStopId(obaId) {
	const s = String(obaId || "");
	const idx = s.indexOf("_");
	return idx >= 0 ? s.slice(idx + 1) : s;
}

// Attempt to derive a human short name from a full OBA route id
// Examples:
//  - "MTA NYCT_B63" -> "B63"
//  - "MTA NYCT_QM15" -> "QM15"
//  - "MTABC_Q50-SBS" -> "Q50-SBS"
//  - "MTA_BxM3" (if underscores missing) -> "BxM3"
function deriveShortFromRouteId(routeId) {
	if (!routeId) return null;
	const rid = String(routeId);
	// Prefer last underscore part if present
	if (rid.includes("_")) {
		return rid.split("_").pop();
	}
	// Else, take last whitespace-separated token
	const parts = rid.trim().split(/\s+/);
	return parts.length ? parts[parts.length - 1] : rid;
}

// Detect "Rush" keyword in destination-related fields
function hasRushKeyword(destName, destDisplay) {
	const check = (val) => {
		if (!val) return false;
		if (Array.isArray(val)) return val.some((x) => check(x));
		const s = String(val).toUpperCase();
		return s.includes("RUSH");
	};
	return check(destName) || check(destDisplay);
}

// Ensure we have at least some route references; if empty, fetch agency-wide routes
async function ensureSomeRoutesAvailable() {
	if (ROUTE_REFS.byShort.size > 0 || ROUTE_REFS.byId.size > 0) return;
	try {
		const res = await fetch(`${BUS_API_BASE}/routes-for-agency?agencyId=MTA`);
		if (!res.ok) return;
		const data = await res.json();
		const list = (data && data.data && data.data.list) || [];
		for (const r of list) {
			if (!r) continue;
			const id = String(r.id);
			const short = String(r.shortName || deriveShortFromRouteId(id) || "").toUpperCase();
			ROUTE_REFS.byId.set(id, r);
			if (short) {
				if (!ROUTE_REFS.byShort.has(short)) ROUTE_REFS.byShort.set(short, r);
				if (!SHORT_TO_FULL.has(short)) SHORT_TO_FULL.set(short, id);
			}
		}
	} catch (_) {
		// ignore
	}
}

async function loadStopArrivalsIntoPopup(stop) {
	const el = document.getElementById(`stop-${cssEscapeId(stop.id)}`);
	if (!el) return;
	const target = el.querySelector(".stop-arrivals");
	if (!target) return;
	target.textContent = "Loading arrivals...";
	try {
		const params = new URLSearchParams({ stopId: extractNumericStopId(stop.id), version: 2, MaximumStopVisits: 5 });
		const res = await fetch(`${BUS_API_BASE}/stop-monitoring?${params.toString()}`);
		if (!res.ok) throw new Error(`stop-monitoring ${res.status}`);
		const data = await res.json();
		const sm = data.Siri || data;
		const deliveries = (sm.ServiceDelivery && sm.ServiceDelivery.StopMonitoringDelivery) || [];
		const visits = deliveries.flatMap((d) => d.MonitoredStopVisit || []);
		const top3 = visits.slice(0, 3);
		if (!top3.length) {
			target.innerHTML = "No upcoming arrivals";
			return;
		}
		const fmtTime = (t) => {
			if (!t) return null;
			try {
				const dt = new Date(t);
				if (!isNaN(dt)) return dt.toLocaleTimeString();
			} catch {}
			return String(t);
		};
		const parseDate = (t) => {
			if (!t) return null;
			try {
				const d = new Date(t);
				return isNaN(d) ? null : d;
			} catch {
				return null;
			}
		};
		const fmtCountdown = (dt) => {
			if (!dt) return "";
			const diffMs = dt.getTime() - Date.now();
			const sign = diffMs < 0 ? -1 : 1;
			const ms = Math.abs(diffMs);
			const totalSec = Math.round(ms / 1000);
			const m = Math.floor(totalSec / 60);
			const s = totalSec % 60;
			if (sign < 0) return m > 0 ? `${m}m ${s}s ago` : `${s}s ago`;
			if (m === 0 && s <= 10) return "due";
			return m > 0 ? `in ${m}m ${s}s` : `in ${s}s`;
		};
		const items = top3.map((v) => {
			const mvj = v.MonitoredVehicleJourney || {};
			const mc =
				mvj.MonitoredCall ||
				(mvj.OnwardCalls && mvj.OnwardCalls.OnwardCall && mvj.OnwardCalls.OnwardCall[0]) ||
				{};
			const route = mvj.PublishedLineName || mvj.LineRef || "";
			const short = String(route).replace(/\s+/g, "").toUpperCase();
			const meta = ROUTE_REFS.byShort.get(short) || null;
			const fullId = meta && meta.id;
			const dir = mvj.DirectionRef;
			let dirLabel = dir ?? "?";
			const seq = fullId ? ROUTE_SEQ_CACHE.get(String(fullId)) : null;
			if (seq && seq.dirNames && (dir === 0 || dir === 1)) {
				dirLabel = seq.dirNames[dir] || dirLabel;
			}
			const occ = mvj.Occupancy || mvj.OccupancyPercentage || (mvj.Extensions && mvj.Extensions.Occupancy) || "";
			const feats = (mvj.VehicleFeatureRef && [].concat(mvj.VehicleFeatureRef).join(", ")) || "";
			const arr = fmtTime(mc.ExpectedArrivalTime || mc.AimedArrivalTime);
			const arrDisplay = arr ? ` · Arr: ${arr}` : "";
			const dep = fmtTime(mc.ExpectedDepartureTime || mc.AimedDepartureTime);
			const arrDt = parseDate(mc.ExpectedArrivalTime || mc.AimedArrivalTime);
			const depDt = parseDate(mc.ExpectedDepartureTime || mc.AimedDepartureTime);
			const countdown = arrDt ? fmtCountdown(arrDt) : depDt ? fmtCountdown(depDt) : "";
			const dist = mc.Extensions && mc.Extensions.Distances;
			const distStr =
				dist &&
				(dist.PresentableDistance ||
					(typeof dist.DistanceFromCall === "number" ? `${Math.round(dist.DistanceFromCall)} m` : ""));
			const dest = mvj.DestinationName || (mc.DestinationDisplay && mc.DestinationDisplay[0]) || "";
			return `<li>
				<strong>${route}</strong>
				${dest ? ` to <em>${dest}</em>` : ""}
				${dirLabel !== undefined ? ` <span title="Direction">(${dirLabel})</span>` : ""}
				${arrDisplay}
				${countdown ? ` <strong>${countdown}</strong>` : ""}
				${dep ? `, Dep: ${dep}` : ""}
				${distStr ? `, ${distStr}` : ""}
				${occ ? `, Occupancy: ${occ}` : ""}
				${feats ? `, Features: ${feats}` : ""}
			</li>`;
		});
		const servedRoutes = Array.isArray(stop.routeIds)
			? stop.routeIds
					.map((rid) => {
						const meta = ROUTE_REFS.byId.get(String(rid));
						return meta && meta.shortName ? meta.shortName : String(rid);
					})
					.join(", ")
			: "";
		target.innerHTML = `<div><em>Routes at this stop:</em> ${servedRoutes || "(unknown)"}</div><ol>${items.join(
			""
		)}</ol>`;
	} catch (e) {
		target.textContent = `Failed to load arrivals: ${e.message}`;
	}
}

function wireUI() {
	document.getElementById("refresh").addEventListener("click", () => refresh());
	const chk = document.getElementById("autoRefresh");
	chk.addEventListener("change", () => {
		if (chk.checked) {
			autoTimer = setInterval(refresh, 30000);
		} else if (autoTimer) {
			clearInterval(autoTimer);
			autoTimer = undefined;
		}
	});
	map.on("moveend", () => refresh());
	const toggle = document.getElementById("routesToggle");
	const sidebar = document.getElementById("sidebar");
	if (toggle && sidebar) {
		toggle.addEventListener("click", () => {
			sidebar.classList.toggle("open");
		});
	}
	const locateBtn = document.getElementById("locate");
	if (locateBtn && "geolocation" in navigator) {
		locateBtn.addEventListener("click", () => locateUser(true));
	}
}

document.addEventListener("DOMContentLoaded", () => {
	initMap();
	wireUI();
	// Try to get the user's location once on load and zoom there
	if ("geolocation" in navigator) {
		locateUser(false);
	}
	refresh();
	autoTimer = setInterval(refresh, 30000);
});

// Request user location; if center=true or first attempt, fit and refresh
function locateUser(center = true) {
	try {
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				const { latitude, longitude, accuracy } = pos.coords;
				const latlng = [latitude, longitude];
				if (!userLocationMarker) {
					userLocationMarker = L.circleMarker(latlng, {
						radius: 6,
						color: "#2563eb",
						weight: 2,
						fillColor: "#60a5fa",
						fillOpacity: 0.7,
					}).addTo(map);
				} else {
					userLocationMarker.setLatLng(latlng);
				}
				if (accuracy && accuracy > 0) {
					if (!userLocationCircle) {
						userLocationCircle = L.circle(latlng, {
							radius: accuracy,
							color: "#93c5fd",
							weight: 1,
							fillOpacity: 0.15,
						}).addTo(map);
					} else {
						userLocationCircle.setLatLng(latlng);
						userLocationCircle.setRadius(accuracy);
					}
				}
				if (center) {
					map.setView(latlng, Math.max(map.getZoom(), 15));
					refresh();
				}
			},
			(err) => {
				// Fail silently; user may deny permission
				console.warn("Geolocation error:", err && err.message);
			},
			{ enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
		);
	} catch (e) {
		// no-op
	}
}
