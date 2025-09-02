const BUS_API_BASE = "/api/bus";

let map;
let stopMarkersLayer;
let busMarkersLayer;
let autoTimer;
let currentRenderId = 0; // used to abort in-flight renders when refreshing/moving

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
		maxCount: 1000,
	});
	const res = await fetch(`${BUS_API_BASE}/stops-for-bounds?${params.toString()}`);
	if (!res.ok) throw new Error(`stops-for-bounds ${res.status}`);
	return res.json();
}

function routeBadge(route) {
	const rush = /X|RUSH/i.test(route);
	const color = rush ? "#7e22ce" : "#0ea5e9";
	const text = route.replace(/\s+/g, "");
	return `<span style="display:inline-block;padding:2px 6px;border-radius:10px;background:${color};color:white;font-weight:600;font-size:11px;">${text}</span>`;
}

function clearLayers() {
	stopMarkersLayer.clearLayers();
	busMarkersLayer.clearLayers();
}

async function refresh() {
	try {
		const renderId = ++currentRenderId;
		setStatus("Loading stops...");
		clearLayers();
		const data = await fetchStopsInView();
		const stops = (data && data.data && data.data.list) || [];
		const stopIds = await renderStopsChunked(stops, renderId);

		// If a new refresh started during rendering, abort
		if (renderId !== currentRenderId) return;

		if (stopIds.length) {
			setStatus("Loading arrivals...");
			const params = new URLSearchParams({
				stopIds: stopIds.slice(0, 50).join(","),
				MaximumStopVisits: 3,
				version: 2,
				StopMonitoringDetailLevel: "minimum",
			});
			const res = await fetch(`${BUS_API_BASE}/stops-monitoring?${params.toString()}`);
			if (res.ok) {
				const m = await res.json();
				renderBusesFromSiri(m);
			}
		}
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
			const id = String(s.code || s.id || "")
				.replace(/^.*_/, "")
				.trim();
			if (id) stopIds.push(id);
			const marker = L.circleMarker([s.lat, s.lon], {
				radius: 4,
				color: "#111827",
				weight: 1,
				fillColor: "#22c55e",
				fillOpacity: 0.9,
			}).bindPopup(`<strong>${s.name || "Stop"}</strong><br/>ID: ${s.code || s.id}`);
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
				const veh = mvj.VehicleLocation;
				const lat = veh && veh.Latitude;
				const lon = veh && veh.Longitude;
				if (!lat || !lon) return;
				// Marker label: only the route badge (no extra text)
				const html = `${routeBadge(String(route))}`;
				const icon = L.divIcon({
					className: "bus-icon",
					html,
					iconSize: [40, 18],
					iconAnchor: [20, 9],
				});
				const marker = L.marker([lat, lon], { icon });

				// Build a richer popup with additional info from SIRI, when available
				const mc =
					mvj.MonitoredCall ||
					(mvj.OnwardCalls && mvj.OnwardCalls.OnwardCall && mvj.OnwardCalls.OnwardCall[0]) ||
					{};
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
				// MonitoredCall info (next stop ETA and distance)
				if (mc.StopPointName) details.push(`<div><strong>Next stop:</strong> ${mc.StopPointName}</div>`);
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
}

document.addEventListener("DOMContentLoaded", () => {
	initMap();
	wireUI();
	refresh();
	autoTimer = setInterval(refresh, 30000);
});
