const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
// Silence dotenv's informational logs
if (!process.env.DOTENV_LOG_LEVEL) {
	process.env.DOTENV_LOG_LEVEL = "none";
}
require("dotenv").config();

const mtaRoutes = require("./api/mta");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API routes
app.use("/api/mta", mtaRoutes);

// Serve static files from the frontend directory
app.use(express.static(path.join(__dirname, "../frontend")));

// SPA fallback: after static and API routes, send index.html for non-API requests
app.use((req, res, next) => {
	if (req.path && req.path.startsWith("/api/")) return next();
	res.sendFile(path.join(__dirname, "../frontend", "index.html"));
});

app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
	// Best-effort: Ensure stations.json exists; generate it if missing.
	const stationsJsonPath = path.join(__dirname, "../frontend/stations.json");
	try {
		if (!fs.existsSync(stationsJsonPath)) {
			console.log("stations.json not found; attempting to fetch GTFS static stops...");
			const scriptPath = path.join(__dirname, "./scripts/fetch_stops.js");
			// Spawn a child process to run the script without blocking server start.
			const { spawn } = require("child_process");
			const child = spawn(process.execPath, [scriptPath], { stdio: "inherit" });
			child.on("exit", (code) => {
				if (code === 0) {
					console.log("stations.json generated successfully.");
				} else {
					console.warn("stations.json generation failed with code", code);
				}
			});
		}
	} catch (err) {
		console.warn("Failed to ensure stations.json:", err.message);
	}
});
