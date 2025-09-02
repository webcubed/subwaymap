// Global map instance and markers array
let leafletMap;
let trainLocationMarkers = [];
let routeLinesLayer; // Layer group to hold polylines per route
let ROUTE_EDGES = {}; // { [routeId]: [[stationA, stationB], ...] }
let LAST_ROUTE_LINES_CTX = null; // { trainsByStation, getLineColorFunc, allRoutesSeen }

// Approximate LIRR branch colors (based on MTA app visual cues)
const LIRR_BRANCH_COLORS = {
	babylon: "#2ecc71",
	"city terminal zone": "#95a5a6",
	"far rockaway": "#e67e22",
	hempstead: "#16a085",
	"long beach": "#f39c12",
	montauk: "#1abc9c",
	"oyster bay": "#00cc99",
	"port jefferson": "#2980b9",
	"port washington": "#e53935", // red per request
	ronkonkoma: "#e91e63",
	greenport: "#8e44ad",
	"west hempstead": "#00b894",
};

function normalizeLirrBranchName(name) {
	if (!name) return null;
	let s = String(name).toLowerCase();
	s = s.replace(/\(.*?\)/g, ""); // remove parentheses
	s = s.replace(/\b(branch|line)\b/gi, "");
	s = s.replace(/[\-–—]+/g, " ");
	s = s.replace(/\s+/g, " ").trim();
	return s;
}

function getLirrBranchColor(name) {
	const key = normalizeLirrBranchName(name);
	if (!key) return null;
	return LIRR_BRANCH_COLORS[key] || null;
}

// Create a div-based icon for a train vehicle labeled by its route id
function createTrainBadgeIcon(routeId, color, options = {}) {
	const label = (routeId || "").toString();
	const size = options.size || 22; // px
	const border = options.border || 2;
	const textColor = label.match(/[NQRWnqrw]/) ? "black" : "white";
	const shape = options.shape || "circle"; // "circle" or "rounded"
	const radiusCSS = shape === "circle" ? "50%" : "6px";
	const html = `
		<div style="
			width: ${size}px; height: ${size}px;
			background-color: ${color || "#555"};
			color: ${textColor};
			border: ${border}px solid #000; box-sizing: border-box;
			border-radius: ${radiusCSS};
			display: flex; align-items: center; justify-content: center;
			font-weight: 800; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
			font-size: ${Math.max(10, Math.round(size * 0.55))}px;
			line-height: 1;
			text-shadow: 0 0 2px rgba(0,0,0,0.3);
		">
			${label}
		</div>
	`;
	return L.divIcon({
		html,
		className: "train-badge-icon",
		iconSize: [size + border * 2, size + border * 2],
		iconAnchor: [Math.round((size + border * 2) / 2), Math.round((size + border * 2) / 2)],
		popupAnchor: [0, -Math.round((size + border * 2) / 2)],
	});
}

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

// Resolve a stopId to a human-friendly station name using loaded stations.json (with fallbacks)
function resolveStopName(stopId) {
	if (!stopId) return null;
	// Exact
	if (STATION_COORDINATES_DATA[stopId] && STATION_COORDINATES_DATA[stopId].name) {
		return STATION_COORDINATES_DATA[stopId].name;
	}
	// Try stripping suffix after space, hyphen, or colon
	const s = String(stopId);
	const splitters = [" ", "-", ":"];
	for (const sp of splitters) {
		const idx = s.indexOf(sp);
		if (idx > 0) {
			const base = s.slice(0, idx);
			if (STATION_COORDINATES_DATA[base] && STATION_COORDINATES_DATA[base].name) {
				return STATION_COORDINATES_DATA[base].name;
			}
		}
	}
	return null;
}

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

// Kick off loading edges eagerly as well
loadRouteEdgesJson();

function normalizeRouteId(routeId) {
	if (routeId === undefined || routeId === null) return null;
	return String(routeId).trim();
}

function isLikelySubwayRoute(routeId) {
	// True for typical subway route IDs (single letter/number and a few known multi-char)
	const up = String(routeId).toUpperCase();
	if (/^[A-Z]$/.test(up)) return true; // A, B, C, ...
	if (/^[1-7]$/.test(up)) return true; // 1..7
	const allowed = new Set(["SI", "GS", "FS", "H", "FX", "6X", "7X"]);
	return allowed.has(up);
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
			// Only circle markers support setStyle with radius
			if (typeof m.setStyle === "function") {
				if (m._isStopDot) {
					m.setStyle({ radius: computeStopDotRadius(z) });
				} else {
					const count = typeof m._routesCount === "number" ? m._routesCount : 1;
					m.setStyle({ radius: computeMarkerRadius(count, z) });
				}
			}
		});
		// Redraw route lines on zoom to update viewport-based filtering
		if (LAST_ROUTE_LINES_CTX) {
			const { trainsByStation, getLineColorFunc, routeIdToDisplay, drawOnlyNonSubway, limitToStationsInView } =
				LAST_ROUTE_LINES_CTX;
			drawRouteLines(trainsByStation, getLineColorFunc, routeIdToDisplay, {
				drawOnlyNonSubway,
				limitToStationsInView,
			});
		}
	});

	// Redraw lines when panning as well
	leafletMap.on("moveend", () => {
		if (LAST_ROUTE_LINES_CTX) {
			const { trainsByStation, getLineColorFunc, routeIdToDisplay, drawOnlyNonSubway, limitToStationsInView } =
				LAST_ROUTE_LINES_CTX;
			drawRouteLines(trainsByStation, getLineColorFunc, routeIdToDisplay, {
				drawOnlyNonSubway,
				limitToStationsInView,
			});
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

function computeStopDotRadius(zoom) {
	// Slightly larger dots for stops when vehicles are shown
	// z=10 -> 3, z=12 -> 4, z=14 -> 5, z>=16 -> 6
	const r = 2 + (zoom - 10) * 0.5;
	return Math.max(3, Math.min(6, Math.round(r)));
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

// Create a rectangular icon with colored left border for LIRR vehicles
function createLirrRectIcon(labelText, color, options = {}) {
	const height = options.height || 18;
	const padX = options.padX || 6;
	const border = options.border || 3; // left border thickness
	const fontSize = options.fontSize || 11;
	const text = (labelText || "").toString();
	const html = `
		<div style="
			height: ${height}px; line-height: ${height}px;
			background: rgba(255,255,255,0.95);
			color: #111; border: 1px solid #000; box-shadow: 0 1px 2px rgba(0,0,0,0.25);
			border-left: ${border}px solid ${color || "#555"};
			border-radius: 4px; padding: 0 ${padX}px; font-weight: 700;
			font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
			font-size: ${fontSize}px; white-space: nowrap;
		">${text}</div>
	`;
	const width = Math.max(64, Math.round(text.length * (fontSize * 0.58) + padX * 2 + border + 8));
	return L.divIcon({
		html,
		className: "train-lirr-icon",
		iconSize: [width, height + 2],
		iconAnchor: [Math.round(width / 2), Math.round((height + 2) / 2)],
		popupAnchor: [0, -Math.round((height + 2) / 2)],
	});
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

	// Group trains by station for line drawing; render vehicles at actual positions when available
	const trainsByStation = {};

	// Track all routes seen in the payload
	const allRoutesSeen = new Set();

	// Map routeId -> displayRoute (branch) when provided by backend (LIRR)
	const routeIdToDisplay = new Map();

	allTrainData.forEach((train) => {
		const rid = normalizeRouteId(train.routeId);
		if (rid) allRoutesSeen.add(rid);
		if (rid && train.displayRoute) {
			routeIdToDisplay.set(rid, train.displayRoute);
		}
		// Try to find station coordinates (support LIRR exact ids)
		let stationInfo = STATION_COORDINATES_DATA[train.stopId];
		if (!stationInfo) {
			// Subway parent station heuristic (drop last char) still useful for NYCT
			const parentStationId = train.stopId.length > 1 ? train.stopId.slice(0, -1) : train.stopId;
			const stationGenericId = train.stopId.substring(0, 3);
			stationInfo =
				STATION_COORDINATES_DATA[parentStationId] || STATION_COORDINATES_DATA[stationGenericId] || null;
		}
		if (!stationInfo) {
			// Additional heuristic: strip any suffix after space or hyphen (some commuter rail stop ids may include suffixes)
			const s = String(train.stopId);
			const idx = Math.max(s.indexOf(" "), s.indexOf("-"));
			if (idx > 0) {
				const base = s.slice(0, idx);
				stationInfo = STATION_COORDINATES_DATA[base] || null;
			}
		}

		// Always add to trainsByStation if we have a station (for lines)
		if (stationInfo) {
			const key = `${stationInfo.lat},${stationInfo.lng}`;
			if (!trainsByStation[key]) {
				trainsByStation[key] = { station: stationInfo, trains: [] };
			}
			trainsByStation[key].trains.push(train);
		}
	});

	// Prefer rendering actual vehicles if lat/lng is present; otherwise render station markers
	const vehicles = allTrainData.filter((t) => typeof t.lat === "number" && typeof t.lng === "number");
	if (vehicles.length) {
		vehicles.forEach((v) => {
			const route = v.routeId || "";
			const display = v.displayRoute || route;
			const lirrColor = v.displayRoute ? getLirrBranchColor(v.displayRoute) : null;
			const color = lirrColor || getLineColorFunc(route) || "#555555";
			const icon = v.displayRoute
				? createLirrRectIcon(display, color, { height: 18, fontSize: 11 })
				: createTrainBadgeIcon(route, color, { size: 18, shape: "circle" });
			const marker = L.marker([v.lat, v.lng], { icon });
			const ts = v.timestamp instanceof Date ? v.timestamp.toLocaleTimeString() : "";
			const nextName = v.stopId ? resolveStopName(v.stopId) : null;
			const nextLine = v.stopId ? `Next stop: ${nextName ? `${nextName} (${v.stopId})` : v.stopId}<br/>` : "";
			marker.bindPopup(
				`<div><strong>${display || "Train"}</strong><br/>Trip: ${
					v.tripId || "n/a"
				}<br/>${nextLine}Updated: ${ts}</div>`
			);
			marker.addTo(leafletMap);
			trainLocationMarkers.push(marker);
		});

		// Also render station markers so stops remain visible when vehicles are present (slightly larger, zoom-scaled)
		Object.values(trainsByStation).forEach(({ station, trains }) => {
			const routes = [...new Set(trains.map((t) => t.routeId))].sort();
			const primaryRoute = routes[0];
			const primaryDisplay = !isLikelySubwayRoute(primaryRoute)
				? (trains.find((t) => t.displayRoute) || {}).displayRoute || null
				: null;
			const color = primaryDisplay
				? getLirrBranchColor(primaryDisplay)
				: getLineColorFunc(primaryRoute) || "#888";
			const marker = L.circleMarker([station.lat, station.lng], {
				radius: computeStopDotRadius(leafletMap.getZoom()),
				fillColor: color,
				color: "#000",
				weight: 1,
				opacity: 1,
				fillOpacity: 0.8,
			});
			marker._isStopDot = true;
			const routeList = routes
				.map((route) => {
					const disp = routeIdToDisplay.get(route);
					const c = disp ? getLirrBranchColor(disp) : getLineColorFunc(route);
					return `<span style=\"background-color: ${c}; color: ${
						!disp && String(route).match(/[NQRWnqrw]/) ? "black" : "white"
					}; padding: 1px 4px; border-radius: 2px; margin: 1px; display: inline-block; font-weight: bold; font-size: 10px;\">${
						disp || route
					}</span>`;
				})
				.join(" ");
			const popupContent = `
	            <div>
	                <strong>${station.name}</strong><br>
	                <div style=\"margin: 4px 0;\">${routeList}</div>
	                <small>${trains.length} train update(s)</small>
	            </div>
	        `;
			marker.bindPopup(popupContent);
			marker.addTo(leafletMap);
			trainLocationMarkers.push(marker);
		});

		// When vehicles are visible, draw only non-subway (e.g., LIRR) lines and limit to stations-in-view-with-trains
		LAST_ROUTE_LINES_CTX = {
			trainsByStation,
			getLineColorFunc,
			allRoutesSeen,
			routeIdToDisplay,
			drawOnlyNonSubway: true,
			limitToStationsInView: true,
		};
		drawRouteLines(trainsByStation, getLineColorFunc, routeIdToDisplay, {
			drawOnlyNonSubway: true,
			limitToStationsInView: true,
		});
	} else {
		// Fallback to station markers when vehicle positions are not available
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
			marker._routesCount = routes.length;
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
	}

	// Draw connecting lines for stations by route only when vehicle positions are not shown
	try {
		const vehiclesShown = vehicles.length > 0;
		if (!vehiclesShown) {
			LAST_ROUTE_LINES_CTX = {
				trainsByStation,
				getLineColorFunc,
				allRoutesSeen,
				routeIdToDisplay,
				drawOnlyNonSubway: false,
				limitToStationsInView: false,
			};
			drawRouteLines(trainsByStation, getLineColorFunc, routeIdToDisplay, {
				drawOnlyNonSubway: false,
				limitToStationsInView: false,
			});
		} else {
			LAST_ROUTE_LINES_CTX = {
				trainsByStation,
				getLineColorFunc,
				allRoutesSeen,
				routeIdToDisplay,
				drawOnlyNonSubway: true,
				limitToStationsInView: true,
			};
			drawRouteLines(trainsByStation, getLineColorFunc, routeIdToDisplay, {
				drawOnlyNonSubway: true,
				limitToStationsInView: true,
			});
		}
	} catch (e) {
		console.warn("Failed to draw route polylines:", e.message);
	}

	console.log(`Mapped ${Object.keys(trainsByStation).length} stations with ${allTrainData.length} train updates`);
};

function drawRouteLines(trainsByStation, getLineColorFunc, routeIdToDisplay, options = {}) {
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
		// Include non-subway routes seen anywhere (e.g., LIRR) so we render their lines even with sparse updates
		const globalRoutes = (LAST_ROUTE_LINES_CTX && LAST_ROUTE_LINES_CTX.allRoutesSeen) || new Set();
		const nonSubwaySeen = new Set();
		globalRoutes.forEach((r) => {
			if (!isLikelySubwayRoute(r)) nonSubwaySeen.add(r);
		});
		let routesToDraw = new Set([...routesInView, ...nonSubwaySeen]);
		if (options.drawOnlyNonSubway) {
			// Restrict to non-subway when requested (keep LIRR visible even when vehicles are shown)
			routesToDraw = new Set([...routesToDraw].filter((r) => !isLikelySubwayRoute(r)));
		}

		routesToDraw.forEach((routeId) => {
			const edges = ROUTE_EDGES[routeId];
			if (!edges || !edges.length) return;
			const disp = routeIdToDisplay && routeIdToDisplay.get ? routeIdToDisplay.get(routeId) : null;
			const color = disp
				? getLirrBranchColor(disp)
				: (typeof getLineColorFunc === "function" ? getLineColorFunc(routeId) : "#555") || "#555";
			const subway = isLikelySubwayRoute(routeId);
			const maxDist = subway ? 8000 : 80000; // LIRR segments can be much longer
			edges.forEach(([a, b]) => {
				const sa = STATION_COORDINATES_DATA[a];
				const sb = STATION_COORDINATES_DATA[b];
				if (!sa || !sb) return;
				const pa = L.latLng(sa.lat, sa.lng);
				const pb = L.latLng(sb.lat, sb.lng);
				if (!bounds.contains(pa) || !bounds.contains(pb)) return;
				// When limiting, only draw edges whose endpoints are among the stations with trains for this route
				if (options.limitToStationsInView) {
					const allowed = routeStationsInView.get(routeId);
					if (!allowed || !(allowed.has(a) && allowed.has(b))) return;
				}
				if (distanceMeters(sa.lat, sa.lng, sb.lat, sb.lng) > maxDist) return;
				const poly = L.polyline(
					[
						[sa.lat, sa.lng],
						[sb.lat, sb.lng],
					],
					{ color, weight: 2, opacity: 0.6 }
				);
				poly.addTo(routeLinesLayer);

				// Optionally render tiny station dots for non-subway routes to make stops visible
				if (!subway) {
					L.circleMarker([sa.lat, sa.lng], {
						radius: 2,
						color: "#000",
						weight: 1,
						fillColor: color,
						fillOpacity: 0.9,
					}).addTo(routeLinesLayer);
					L.circleMarker([sb.lat, sb.lng], {
						radius: 2,
						color: "#000",
						weight: 1,
						fillColor: color,
						fillOpacity: 0.9,
					}).addTo(routeLinesLayer);
				}
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
