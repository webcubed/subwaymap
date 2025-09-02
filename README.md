# NYC Subway Real-Time Map

A modern web application that displays real-time NYC subway train locations using the MTA's GTFS-realtime feeds.

## Features

-   🚇 Real-time train data from all MTA subway lines
-   🗺️ Interactive map showing train locations
-   📱 Responsive design for mobile and desktop
-   🔄 Auto-refresh every 30 seconds
-   🎨 Color-coded subway lines
-   ⚡ No API key required (uses free MTA feeds)

## Quick Start

### Prerequisites

-   Node.js (version 14 or higher)
-   npm or yarn

### Installation

1. Clone the repository:

```bash
git clone https://github.com/dantraynor/subwaymap.git
cd subwaymap
```

2. Switch to the new branch:

```bash
git checkout feature/nodejs-realtime-website
```

3. Install backend dependencies:

```bash
cd backend
npm install
```

4. Start the development server:

```bash
npm run dev
```

5. Open your browser and go to:

```text
http://localhost:3000
```

If you don't immediately see many station markers, the app will attempt to fetch the GTFS static feed and generate `frontend/stations.json` on first run. You can also generate it manually with:

```bash
cd backend
npm run fetch:stops
```

## Project Structure

```text
subwaymap/
├── backend/
│   ├── api/
│   │   └── mta.js          # MTA API routes
│   ├── package.json        # Backend dependencies
│   └── server.js           # Express server
├── frontend/
│   ├── index.html          # Main HTML file
│   ├── style.css           # Styling
│   ├── script.js           # Main app logic
│   └── map.js              # Map functionality
├── .gitignore
└── README.md
```

## API Endpoints

-   `GET /api/mta/feeds/all` - Get all real-time train data
-   `GET /api/mta/feed/:feedId` - Get specific feed data

Available feed IDs:

-   `1234567` - Lines 1,2,3,4,5,6,7
-   `ace` - Lines A,C,E
-   `bdfm` - Lines B,D,F,M
-   `g` - Line G
-   `jz` - Lines J,Z
-   `l` - Line L
-   `nqrw` - Lines N,Q,R,W
-   `si` - Staten Island Railway

## Development

### Running in Development Mode

```bash
cd backend
npm run dev
```

This uses `nodemon` to automatically restart the server when files change.

### Adding More Stations

The map now automatically generates `frontend/stations.json` from the MTA GTFS static feed (`stops.txt`). On startup, the backend will try to download and extract stations. You can re-generate anytime:

```bash
cd backend
npm run fetch:stops
```

Optional: You can override the GTFS source via env var `GTFS_STATIC_URL` or flag `--url`.

## Deployment

### Production Build

```bash
cd backend
npm start
```

### Environment Variables

Create a `.env` file in the root directory if needed:

```env
PORT=3000
NODE_ENV=production
```

## Technologies Used

-   **Backend**: Node.js, Express.js
-   **Frontend**: Vanilla JavaScript, HTML5, CSS3
-   **Map**: Leaflet.js
-   **Data**: MTA GTFS-realtime feeds
-   **Protocol Buffers**: gtfs-realtime-bindings

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Data Sources

-   Real-time data: [MTA GTFS-realtime feeds](https://api.mta.info/#/subwayRealTimeFeeds)
-   Static data: [MTA GTFS static feeds](https://new.mta.info/developers)

## Troubleshooting

### Common Issues

1. **No train data showing**: Check the browser console for API errors
2. **Map not loading**: Ensure you have an internet connection for map tiles
3. **Server won't start**: Make sure port 3000 is available

### API Rate Limits

The MTA feeds are free but may have rate limits. The app refreshes every 30 seconds which should be well within limits.
