// Optimized NYC Subway Real-Time Map
class SubwayMap {
    constructor() {
        this.trainData = [];
        this.map = null;
        this.trainMarkers = [];
        this.subwayLines = {};
        this.lastUpdated = null;
        this.isLoading = false;
        this.init();
    }

    async init() {
        console.log('⚡ Initializing FAST NYC Subway Map...');
        this.initMap();
        this.loadSubwayRoutesSync(); // Synchronous for speed
        this.setupEventListeners();
        await this.fetchTrainData();
        this.startAutoRefresh();
    }

    initMap() {
        this.map = L.map('map', {
            preferCanvas: true, // Use canvas for better performance
            renderer: L.canvas()
        }).setView([40.7589, -73.9851], 11);
        
        // Faster tile layer
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap, © CARTO',
            maxZoom: 16, // Reduced max zoom for performance
            minZoom: 10,
            updateWhenIdle: true,
            updateWhenZooming: false
        }).addTo(this.map);

        console.log('⚡ Fast map initialized');
    }

    loadSubwayRoutesSync() {
        console.log('🛤️ Loading essential subway routes...');
        
        // Only load major trunk lines for speed
        const essentialRoutes = {
            '4': {
                coordinates: [
                    [40.889248, -73.898583], [40.827994, -73.925831], [40.804138, -73.937594],
                    [40.768247, -73.959222], [40.752769, -73.979187], [40.735736, -73.990568],
                    [40.713065, -73.996379], [40.708359, -74.003967], [40.693626, -73.985834]
                ]
            },
            '6': {
                coordinates: [
                    [40.848828, -73.891394], [40.827994, -73.925831], [40.804138, -73.937594],
                    [40.779492, -73.944073], [40.768247, -73.959222], [40.752769, -73.979187],
                    [40.735736, -73.990568], [40.722301, -73.989344], [40.718092, -74.008811]
                ]
            },
            'N': {
                coordinates: [
                    [40.775036, -73.912034], [40.756081, -73.929849], [40.755417, -73.986664],
                    [40.749719, -73.987823], [40.735736, -73.990568], [40.720595, -74.007107],
                    [40.690545, -73.975776], [40.684359, -73.977666], [40.577422, -73.977181]
                ]
            },
            'L': {
                coordinates: [
                    [40.669986, -73.885802], [40.678340, -73.899232], [40.698931, -73.943832],
                    [40.714575, -73.958131], [40.730328, -74.000271], [40.742554, -74.004131]
                ]
            },
            'A': {
                coordinates: [
                    [40.851695, -73.904834], [40.827994, -73.925831], [40.787995, -73.972323],
                    [40.774013, -73.981472], [40.755417, -73.986664], [40.750373, -73.991057],
                    [40.730019, -73.991013], [40.720595, -74.007107], [40.713065, -73.996379]
                ]
            }
        };
        
        // Draw only essential lines
        Object.entries(essentialRoutes).forEach(([lineId, routeData]) => {
            const lineColor = this.getLineColor(lineId);
            
            const routeLine = L.polyline(routeData.coordinates, {
                color: lineColor,
                weight: 3, // Thinner for performance
                opacity: 0.8,
                smoothFactor: 2
            }).addTo(this.map);
            
            this.subwayLines[lineId] = {
                line: routeLine,
                coordinates: routeData.coordinates
            };
        });
        
        console.log(`⚡ Loaded ${Object.keys(this.subwayLines).length} essential subway lines`);
    }

    setupEventListeners() {
        const refreshBtn = document.getElementById('refresh-btn');
        refreshBtn.addEventListener('click', () => {
            if (!this.isLoading) {
                this.fetchTrainData();
            }
        });
    }

    async fetchTrainData() {
        if (this.isLoading) return;
        
        this.isLoading = true;
        const refreshBtn = document.getElementById('refresh-btn');
        const loadingMsg = document.getElementById('loading-message');
        const lastUpdated = document.getElementById('last-updated');
        
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Refreshing...';
        loadingMsg.textContent = 'Fetching optimized train data...';
        loadingMsg.style.display = 'block';

        try {
            const startTime = Date.now();
            console.log('⚡ Fast-fetching train data...');
            
            const response = await fetch('/api/mta/feeds/all');
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const feedsData = await response.json();
            const fetchTime = Date.now() - startTime;
            
            // Fast processing - limit data
            this.trainData = this.processFastTrainPositions(feedsData);
            
            this.lastUpdated = new Date();
            
            console.log(`⚡ Fast-processed ${this.trainData.length} trains in ${fetchTime}ms`);
            
            this.updateUI();
            this.updateTrainPositionsFast();
            
        } catch (error) {
            console.error('❌ Error:', error);
            loadingMsg.textContent = `Error: ${error.message}`;
            lastUpdated.textContent = `Error: ${error.message}`;
        } finally {
            this.isLoading = false;
            refreshBtn.disabled = false;
            refreshBtn.textContent = 'Refresh Data';
        }
    }

    processFastTrainPositions(feedsData) {
        const processedTrains = [];
        const maxTrainsPerRoute = 15; // Limit for performance
        const routeCounts = {};
        
        feedsData
            .filter(feed => feed.data && !feed.error)
            .forEach(feed => {
                feed.data.forEach(train => {
                    // Skip if we have enough trains for this route
                    if ((routeCounts[train.routeId] || 0) >= maxTrainsPerRoute) {
                        return;
                    }
                    
                    const lineData = this.subwayLines[train.routeId];
                    if (lineData && train.stopId) {
                        const position = this.estimateFastTrainPosition(train, lineData);
                        if (position) {
                            processedTrains.push({
                                ...train,
                                estimatedLat: position.lat,
                                estimatedLng: position.lng
                            });
                            
                            routeCounts[train.routeId] = (routeCounts[train.routeId] || 0) + 1;
                        }
                    }
                });
            });
        
        return processedTrains;
    }

    estimateFastTrainPosition(train, lineData) {
        // Super fast position estimation
        const coordinates = lineData.coordinates;
        if (!coordinates || coordinates.length === 0) return null;
        
        // Simple hash-based positioning for consistent placement
        let hash = 0;
        for (let i = 0; i < train.tripId.length; i++) {
            hash = ((hash << 5) - hash + train.tripId.charCodeAt(i)) & 0xffffffff;
        }
        
        const positionIndex = Math.abs(hash) % coordinates.length;
        const coord = coordinates[positionIndex];
        
        return {
            lat: coord[0] + (Math.random() - 0.5) * 0.001, // Smaller random offset
            lng: coord[1] + (Math.random() - 0.5) * 0.001
        };
    }

    updateTrainPositionsFast() {
        // Clear existing markers efficiently
        this.trainMarkers.forEach(marker => this.map.removeLayer(marker));
        this.trainMarkers.length = 0; // Fast array clear

        // Group trains by route for batch processing
        const trainsByRoute = {};
        this.trainData.forEach(train => {
            if (!trainsByRoute[train.routeId]) {
                trainsByRoute[train.routeId] = [];
            }
            trainsByRoute[train.routeId].push(train);
        });

        // Create markers in batches
        Object.entries(trainsByRoute).forEach(([routeId, trains]) => {
            const lineColor = this.getLineColor(routeId);
            
            trains.slice(0, 10).forEach((train) => { // Limit to 10 trains per route
                if (train.estimatedLat && train.estimatedLng) {
                    // Simplified marker creation
                    const marker = L.circleMarker([train.estimatedLat, train.estimatedLng], {
                        radius: 6,
                        fillColor: lineColor,
                        color: '#fff',
                        weight: 1,
                        opacity: 1,
                        fillOpacity: 0.9
                    });
                    
                    // Simplified popup
                    marker.bindPopup(`
                        <div style="text-align: center;">
                            <strong>${routeId} Train</strong><br>
                            Trip: ${train.tripId}<br>
                            Stop: ${train.stopId}
                        </div>
                    `);
                    
                    marker.addTo(this.map);
                    this.trainMarkers.push(marker);
                }
            });
        });
        
        console.log(`⚡ Fast-updated ${this.trainMarkers.length} train markers`);
    }

    updateUI() {
        const lastUpdated = document.getElementById('last-updated');
        const loadingMsg = document.getElementById('loading-message');
        
        if (this.lastUpdated) {
            lastUpdated.innerHTML = `Updated: ${this.lastUpdated.toLocaleTimeString()} <span class="status-indicator"></span>`;
        }
        
        if (this.trainData.length > 0) {
            loadingMsg.style.display = 'none';
        }
        
        this.updateTrainListFast();
    }

    updateTrainListFast() {
        const trainList = document.getElementById('train-list');
        trainList.innerHTML = '';
        
        if (this.trainData.length === 0) {
            trainList.innerHTML = '<p style="text-align: center; color: #666;">No train data</p>';
            return;
        }

        // Fast grouping
        const trainsByRoute = {};
        this.trainData.forEach(train => {
            if (!trainsByRoute[train.routeId]) {
                trainsByRoute[train.routeId] = 0;
            }
            trainsByRoute[train.routeId]++;
        });

        // Fast display
        Object.entries(trainsByRoute)
            .sort(([routeA], [routeB]) => routeA.localeCompare(routeB))
            .forEach(([routeId, count]) => {
                const element = document.createElement('div');
                element.className = 'train-item';
                element.style.borderLeftColor = this.getLineColor(routeId);
                
                const sanitizedRouteId = routeId.replace(/[^a-zA-Z0-9]/g, '');
                
                element.innerHTML = `
                    <div class="train-line-icon line-${sanitizedRouteId}">${routeId}</div>
                    <div class="train-details">
                        <strong>Line ${routeId}</strong>
                        <p>${count} trains tracked</p>
                    </div>
                `;
                
                // Focus on line click
                element.style.cursor = 'pointer';
                element.addEventListener('click', () => this.focusOnLine(routeId));
                
                trainList.appendChild(element);
            });
    }

    focusOnLine(routeId) {
        const lineData = this.subwayLines[routeId];
        if (lineData && lineData.coordinates.length > 0) {
            const bounds = L.latLngBounds(lineData.coordinates);
            this.map.fitBounds(bounds, { padding: [20, 20] });
        }
    }

    getLineColor(line) {
        const colors = {
            '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
            '4': '#00933C', '5': '#00933C', '6': '#00933C',
            '7': '#B933AD',
            'A': '#0039A6', 'C': '#0039A6', 'E': '#0039A6',
            'B': '#FF6319', 'D': '#FF6319', 'F': '#FF6319', 'M': '#FF6319',
            'G': '#6CBE45',
            'J': '#996633', 'Z': '#996633',
            'L': '#A7A9AC',
            'N': '#FCCC0A', 'Q': '#FCCC0A', 'R': '#FCCC0A', 'W': '#FCCC0A',
            'S': '#808183'
        };
        return colors[line.toUpperCase()] || '#666666';
    }

    startAutoRefresh() {
        // Longer interval for better performance
        setInterval(() => {
            if (!this.isLoading) {
                console.log('⚡ Auto-refresh (optimized)...');
                this.fetchTrainData();
            }
        }, 45000); // 45 seconds
        
        console.log('⚡ Optimized auto-refresh enabled (45s)');
    }
}

// Initialize optimized app
document.addEventListener('DOMContentLoaded', () => {
    console.log('⚡ Starting OPTIMIZED NYC Subway Map...');
    new SubwayMap();
});