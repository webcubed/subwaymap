// Global map instance and markers array
let leafletMap;
let trainLocationMarkers = [];
let routeLinesLayer; // Layer group to hold polylines per route
let ROUTE_EDGES = {}; // { [routeId]: [[stationA, stationB], ...] }
let LAST_ROUTE_LINES_CTX = null; // { trainsByStation, getLineColorFunc }

// Fallback minimal stations; at runtime we'll try to load stations.json generated from GTFS
let STATION_COORDINATES_DATA = {
	// Times Square area
	A27: { lat: 40.755417, lng: -73.986664, name: "Times Sq-42 St (A,C,E)" },
	R16: { lat: 40.755417, lng: -73.986664, name: "Times Sq-42 St (N,Q,R,W)" },
	127: { lat: 40.755417, lng: -73.986664, name: "Times Sq-42 St (1,2,3)" },
	901: { lat: 40.755417, lng: -73.986664, name: "Times Sq-42 St (7)" },
	725: { lat: 40.755417, lng: -73.986664, name: "Times Sq-42 St (S)" },

	// Grand Central
	631: { lat: 40.752769, lng: -73.979187, name: "Grand Central-42 St" },

	// Union Square
	R20: { lat: 40.735736, lng: -73.990568, name: "14 St-Union Sq (N,Q,R,W)" },
	L08: { lat: 40.735736, lng: -73.990568, name: "14 St-Union Sq (L)" },
	635: { lat: 40.735736, lng: -73.990568, name: "14 St-Union Sq (4,5,6)" },

	// Herald Square
	D17: { lat: 40.749719, lng: -73.987823, name: "34 St-Herald Sq (B,D,F,M)" },
	R17: { lat: 40.749719, lng: -73.987823, name: "34 St-Herald Sq (N,Q,R,W)" },

	// Wall Street area
	R27: { lat: 40.706821, lng: -74.008834, name: "Whitehall St-South Ferry (R,W)" },
	R25: { lat: 40.704817, lng: -74.013408, name: "Rector St (R,W)" },

	// Brooklyn Bridge
	R29: { lat: 40.708359, lng: -74.003967, name: "Bowling Green (R,W)" },
	142: { lat: 40.713065, lng: -73.996379, name: "Fulton St (4,5,6)" },

	// More stations - you can add many more from the GTFS data
	D21: { lat: 40.730019, lng: -73.991013, name: "W 4 St-Washington Sq" },
	A32: { lat: 40.720595, lng: -74.007107, name: "Chambers St (A,C)" },
	R30: { lat: 40.720595, lng: -74.007107, name: "Chambers St (R,W)" },
};

// Try to load stations.json (generated from GTFS stops) and replace the fallback map.
async function loadStationsJson() {
	try {
		const res = await fetch("stations.json", { cache: "no-cache" });
		if (!res.ok) return;
		const data = await res.json();
		// Expect { [stop_id]: { lat, lng, name } }
		if (data && typeof data === "object" && Object.keys(data).length) {
			STATION_COORDINATES_DATA = data;
			console.log(`Loaded ${Object.keys(data).length} stations from stations.json`);
		}
	} catch (e) {
		// ignore, will use fallback
	}
}

// Kick off loading eagerly
loadStationsJson();

// Try to load route_edges.json (generated from GTFS stop_times & trips) for proper adjacency
async function loadRouteEdgesJson() {
	try {
		const res = await fetch("route_edges.json", { cache: "no-cache" });
		if (!res.ok) return;
		const data = await res.json();
		if (data && typeof data === "object") {
			ROUTE_EDGES = data;
			console.log(`Loaded route edges for ${Object.keys(data).length} routes`);
		}
	} catch (e) {
		// ignore; we'll fall back to naive sorting
	}
}

loadRouteEdgesJson();

function normalizeRouteId(routeId) {
	if (!routeId) return null;
	let up = String(routeId)
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
	// Map express variants like 7X, 6X, 5X to base route
	if (/^[0-9][A-Z]$/.test(up) && up.endsWith("X")) {
		up = up.slice(0, -1);
	}
	// Skip likely grouped IDs like 'ACE'. Allow known multi-char like SI, GS, FS, H
	const allowedMulti = new Set(["SI", "GS", "FS", "H"]);
	if (up.length > 2 && !allowedMulti.has(up)) return null;
	return up;
}

function initLeafletMap(mapId) {
	// Create map centered on NYC
	leafletMap = L.map(mapId).setView([40.7589, -73.9851], 12);

	// Add tile layer
	L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
		attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
		maxZoom: 18,
		minZoom: 10,
	}).addTo(leafletMap);

	// Initialize a layer for route connection lines
	routeLinesLayer = L.layerGroup().addTo(leafletMap);

	// Adjust marker sizes on zoom to avoid dots looking huge when zooming out
	leafletMap.on("zoomend", () => {
		const z = leafletMap.getZoom();
		trainLocationMarkers.forEach((m) => {
			const count = m._routesCount || 1;
			const radius = computeMarkerRadius(count, z);
			m.setStyle({ radius });
		});
		// Redraw route lines on zoom to update viewport-based filtering
		if (LAST_ROUTE_LINES_CTX) {
			const { trainsByStation, getLineColorFunc } = LAST_ROUTE_LINES_CTX;
			drawRouteLines(trainsByStation, getLineColorFunc);
		}
	});

	// Redraw lines when panning as well
	leafletMap.on("moveend", () => {
		if (LAST_ROUTE_LINES_CTX) {
			const { trainsByStation, getLineColorFunc } = LAST_ROUTE_LINES_CTX;
			drawRouteLines(trainsByStation, getLineColorFunc);
		}
	});

	return leafletMap;
}

function computeMarkerRadius(routesCount, zoom) {
	// Base size by number of routes seen at the station
	const base = Math.min(8 + routesCount * 2, 15);
	// Scale by zoom so markers get smaller when zooming out
	// At z=10 => 0.5, z=12 => ~0.67, z=14 => ~0.83, z>=16 => 1.0
	const scale = Math.max(0.5, Math.min(1.0, 0.25 + (zoom - 10) * 0.125));
	return Math.round(base * scale);
}

function distanceMeters(lat1, lon1, lat2, lon2) {
	const R = 6371000; // meters
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

// Update map with train locations
window.updateMapWithTrainLocations = function (allTrainData, getLineColorFunc) {
	if (!leafletMap) return;

	// Clear existing markers
	trainLocationMarkers.forEach((marker) => leafletMap.removeLayer(marker));
	trainLocationMarkers = [];

	// Clear existing polylines
	if (routeLinesLayer) {
		routeLinesLayer.clearLayers();
	}

	// Group trains by station for better visualization
	const trainsByStation = {};

	allTrainData.forEach((train) => {
		// Try to find station coordinates
		const parentStationId = train.stopId.length > 1 ? train.stopId.slice(0, -1) : train.stopId;
		const stationGenericId = train.stopId.substring(0, 3);

		let stationInfo =
			STATION_COORDINATES_DATA[train.stopId] ||
			STATION_COORDINATES_DATA[parentStationId] ||
			STATION_COORDINATES_DATA[stationGenericId];

		if (stationInfo) {
			const key = `${stationInfo.lat},${stationInfo.lng}`;
			if (!trainsByStation[key]) {
				trainsByStation[key] = {
					station: stationInfo,
					trains: [],
				};
			}
			trainsByStation[key].trains.push(train);
		}
	});

	// Create markers for each station with trains
	Object.values(trainsByStation).forEach(({ station, trains }) => {
		const routes = [...new Set(trains.map((t) => t.routeId))].sort();
		const primaryRoute = routes[0];

		const marker = L.circleMarker([station.lat, station.lng], {
			radius: computeMarkerRadius(routes.length, leafletMap.getZoom()),
			fillColor: getLineColorFunc(primaryRoute) || "#555555",
			color: "#000",
			weight: 2,
			opacity: 1,
			fillOpacity: 0.8,
		});
		// Keep the route count on the marker for zoom-based sizing
		marker._routesCount = routes.length;

		// Create popup content
		const routeList = routes
			.map(
				(route) =>
					`<span style="background-color: ${getLineColorFunc(route)}; color: ${
						route.match(/[NQRWnqrw]/) ? "black" : "white"
					}; padding: 2px 6px; border-radius: 3px; margin: 1px; display: inline-block; font-weight: bold;">${route}</span>`
			)
			.join(" ");

		const popupContent = `
            <div>
                <strong>${station.name}</strong><br>
                <div style="margin: 5px 0;">${routeList}</div>
                <small>${trains.length} train update(s)</small>
            </div>
        `;

		marker.bindPopup(popupContent);
		marker.addTo(leafletMap);
		trainLocationMarkers.push(marker);
	});

	// Draw connecting lines for stations by route
	try {
		LAST_ROUTE_LINES_CTX = { trainsByStation, getLineColorFunc };
		drawRouteLines(trainsByStation, getLineColorFunc);
	} catch (e) {
		console.warn("Failed to draw route polylines:", e.message);
	}

	console.log(`Mapped ${Object.keys(trainsByStation).length} stations with ${allTrainData.length} train updates`);
};

function drawRouteLines(trainsByStation, getLineColorFunc) {
	if (!leafletMap || !routeLinesLayer) return;
	routeLinesLayer.clearLayers();

	// Determine which routes have trains in the current viewport
	const bounds = leafletMap.getBounds();
	const routesInView = new Set();
	const stationIdByLatLng = new Map();
	// Build reverse index once
	Object.entries(STATION_COORDINATES_DATA).forEach(([id, info]) => {
		stationIdByLatLng.set(`${info.lat},${info.lng}`, id);
	});
	// Map of routeId -> Set of stationIds in view that currently have trains of that route
	const routeStationsInView = new Map();
	Object.values(trainsByStation).forEach(({ station, trains }) => {
		const p = L.latLng(station.lat, station.lng);
		if (!bounds.contains(p)) return;
		const key = `${station.lat},${station.lng}`;
		const sid = stationIdByLatLng.get(key);
		if (!sid) return;
		const seen = new Set();
		trains.forEach((t) => {
			const r = normalizeRouteId(t.routeId);
			if (!r || seen.has(r)) return;
			seen.add(r);
			routesInView.add(r);
			if (!routeStationsInView.has(r)) routeStationsInView.set(r, new Set());
			routeStationsInView.get(r).add(sid);
		});
	});

	if (ROUTE_EDGES && Object.keys(ROUTE_EDGES).length) {
		routesInView.forEach((routeId) => {
			const edges = ROUTE_EDGES[routeId];
			if (!edges || !edges.length) return;
			const color = (typeof getLineColorFunc === "function" ? getLineColorFunc(routeId) : "#555") || "#555";
			edges.forEach(([a, b]) => {
				const sa = STATION_COORDINATES_DATA[a];
				const sb = STATION_COORDINATES_DATA[b];
				if (!sa || !sb) return;
				// Only draw if both endpoints currently have trains of this route in view
				const set = routeStationsInView.get(routeId);
				if (!set || !set.has(a) || !set.has(b)) return;
				const pa = L.latLng(sa.lat, sa.lng);
				const pb = L.latLng(sb.lat, sb.lng);
				if (!bounds.contains(pa) || !bounds.contains(pb)) return;
				if (distanceMeters(sa.lat, sa.lng, sb.lat, sb.lng) > 8000) return;
				const poly = L.polyline(
					[
						[sa.lat, sa.lng],
						[sb.lat, sb.lng],
					],
					{ color, weight: 2, opacity: 0.6 }
				);
				poly.addTo(routeLinesLayer);
			});
		});
	} else {
		// Fallback: naive left-to-right sort of observed stations within bounds
		const routeStations = new Map();
		Object.values(trainsByStation).forEach(({ station, trains }) => {
			const p = L.latLng(station.lat, station.lng);
			if (!bounds.contains(p)) return;
			const seenRoutes = new Set(trains.map((t) => normalizeRouteId(t.routeId)).filter(Boolean));
			seenRoutes.forEach((routeId) => {
				if (!routeStations.has(routeId)) routeStations.set(routeId, new Map());
				const key = `${station.lat},${station.lng}`;
				routeStations.get(routeId).set(key, [station.lat, station.lng]);
			});
		});
		routeStations.forEach((coordMap, routeId) => {
			const coords = Array.from(coordMap.values());
			if (coords.length < 2) return;
			coords.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
			const color = (typeof getLineColorFunc === "function" ? getLineColorFunc(routeId) : "#555") || "#555";
			const poly = L.polyline(coords, { color, weight: 2, opacity: 0.6 });
			poly.addTo(routeLinesLayer);
		});
	}
}
