const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
// Silence dotenv's informational logs
if (!process.env.DOTENV_LOG_LEVEL) {
	process.env.DOTENV_LOG_LEVEL = "none";
}
require("dotenv").config({ path: path.join(__dirname, ".env") });

const mtaRoutes = require("./api/mta");
const busRoutes = require("./api/bus");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API routes
app.use("/api/mta", mtaRoutes);
app.use("/api/bus", busRoutes);

// Serve static files from the frontend directory
app.use(express.static(path.join(__dirname, "../frontend")));

// Pretty routes for additional pages
app.get(["/bus", "/bus/", "/buses", "/buses/"], (req, res) => {
	res.sendFile(path.join(__dirname, "../frontend", "bus.html"));
});

// SPA fallback: after static and API routes, send index.html for non-API requests
app.use((req, res, next) => {
	if (req.path && req.path.startsWith("/api/")) return next();
	res.sendFile(path.join(__dirname, "../frontend", "index.html"));
});

app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
	// Best-effort: Ensure stations.json exists; generate it if missing.
	const stationsJsonPath = path.join(__dirname, "../frontend/stations.json");
	const routeEdgesPath = path.join(__dirname, "../frontend/route_edges.json");
	try {
		if (!fs.existsSync(stationsJsonPath) || !fs.existsSync(routeEdgesPath)) {
			if (!fs.existsSync(stationsJsonPath)) {
				console.log("stations.json not found; attempting to fetch GTFS static stops...");
			} else {
				console.log("route_edges.json not found; attempting to generate from GTFS...");
			}
			const scriptPath = path.join(__dirname, "./scripts/fetch_stops.js");
			// Spawn a child process to run the script without blocking server start.
			const { spawn } = require("child_process");
			const child = spawn(process.execPath, [scriptPath], { stdio: "inherit" });
			child.on("exit", (code) => {
				if (code === 0) {
					console.log("GTFS artifacts generated successfully (stations.json and possibly route_edges.json).");
				} else {
					console.warn("GTFS artifacts generation failed with code", code);
				}
			});
		}
	} catch (err) {
		console.warn("Failed to ensure stations.json:", err.message);
	}
});
