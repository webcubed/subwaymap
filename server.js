const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const app = express();
const PORT = process.env.PORT || 3000;

// MTA Feed URLs - Prioritized by importance
const MTA_FEEDS = {
  '1234567': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  'nqrw': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
  'bdfm': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  'ace': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'l': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l'
  // Removed less critical feeds for speed: g, jz, si
};

// Optimized cache with compression
let feedCache = new Map();
let lastCacheUpdate = new Map();
const CACHE_DURATION = 45000; // 45 seconds - longer cache
const MAX_TRAINS_PER_ROUTE = 20; // Limit trains per route

// Enable CORS
app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    feeds: Object.keys(MTA_FEEDS),
    cacheSize: feedCache.size,
    memoryUsage: process.memoryUsage()
  });
});

// Optimized feed data processing - MUCH faster
function processFeedDataOptimized(feed, feedId) {
  const startTime = Date.now();
  const trains = [];
  const seenTrips = new Set();
  
  // Process only first 100 entities for speed
  const entitiesToProcess = feed.entity.slice(0, 100);
  
  for (const entity of entitiesToProcess) {
    if (!entity.tripUpdate || !entity.tripUpdate.trip?.routeId) continue;
    
    const tripUpdate = entity.tripUpdate;
    const routeId = tripUpdate.trip.routeId;
    const tripId = tripUpdate.trip.tripId;
    
    // Skip duplicate trips
    if (seenTrips.has(tripId)) continue;
    seenTrips.add(tripId);
    
    // Get only the next stop (first stop update)
    const nextStop = tripUpdate.stopTimeUpdate[0];
    if (!nextStop) continue;
    
    const arrivalTime = nextStop.arrival?.time ? Number(nextStop.arrival.time) : null;
    const departureTime = nextStop.departure?.time ? Number(nextStop.departure.time) : null;
    
    if (arrivalTime || departureTime) {
      trains.push({
        tripId,
        routeId,
        stopId: nextStop.stopId,
        arrival: arrivalTime ? new Date(arrivalTime * 1000) : null,
        departure: departureTime ? new Date(departureTime * 1000) : null,
        delay: nextStop.arrival?.delay || 0,
        feedId
      });
    }
    
    // Limit trains per route for performance
    const routeCount = trains.filter(t => t.routeId === routeId).length;
    if (routeCount >= MAX_TRAINS_PER_ROUTE) {
      continue;
    }
  }
  
  const processingTime = Date.now() - startTime;
  console.log(`⚡ Fast-processed feed ${feedId}: ${trains.length} trains in ${processingTime}ms`);
  
  return trains;
}

// Check if cache is still valid
function isCacheValid(feedId) {
  const lastUpdate = lastCacheUpdate.get(feedId);
  if (!lastUpdate) return false;
  
  const cacheAge = Date.now() - lastUpdate;
  return cacheAge < CACHE_DURATION;
}

// Optimized all feeds endpoint
app.get('/api/mta/feeds/all', async (req, res) => {
  try {
    console.log('🚀 Fast-fetching MTA feeds...');
    const startTime = Date.now();
    
    // Check cache first for all feeds
    const cachedFeeds = [];
    const feedsToFetch = [];
    
    Object.keys(MTA_FEEDS).forEach(feedId => {
      if (isCacheValid(feedId) && feedCache.has(feedId)) {
        cachedFeeds.push({
          feedId,
          data: feedCache.get(feedId),
          cached: true
        });
      } else {
        feedsToFetch.push(feedId);
      }
    });
    
    console.log(`📦 Using ${cachedFeeds.length} cached feeds, fetching ${feedsToFetch.length} fresh`);
    
    // Fetch only non-cached feeds with timeout
    const freshFeeds = await Promise.allSettled(
      feedsToFetch.map(async (feedId) => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout
          
          const response = await fetch(MTA_FEEDS[feedId], {
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          
          const buffer = await response.buffer();
          const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
          const processedData = processFeedDataOptimized(feed, feedId);
          
          // Update cache
          feedCache.set(feedId, processedData);
          lastCacheUpdate.set(feedId, Date.now());
          
          return {
            feedId,
            data: processedData,
            cached: false
          };
        } catch (error) {
          console.error(`❌ Feed ${feedId} failed: ${error.message}`);
          return {
            feedId,
            error: true,
            details: error.message
          };
        }
      })
    );
    
    // Combine cached and fresh data
    const allFeeds = [...cachedFeeds];
    
    freshFeeds.forEach(result => {
      if (result.status === 'fulfilled' && !result.value.error) {
        allFeeds.push(result.value);
      }
    });
    
    const totalTime = Date.now() - startTime;
    const totalTrains = allFeeds.reduce((sum, feed) => sum + (feed.data?.length || 0), 0);
    
    console.log(`✅ Optimized response: ${totalTrains} trains in ${totalTime}ms`);
    
    res.json(allFeeds);
    
  } catch (error) {
    console.error('💥 Critical error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch feeds', 
      details: error.message
    });
  }
});

// Single feed endpoint (optimized)
app.get('/api/mta/feed/:feedId', async (req, res) => {
  try {
    const feedId = req.params.feedId;
    const feedUrl = MTA_FEEDS[feedId];
    
    if (!feedUrl) {
      return res.status(404).json({ error: 'Feed not found' });
    }

    // Check cache first
    if (isCacheValid(feedId) && feedCache.has(feedId)) {
      return res.json(feedCache.get(feedId));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    
    const response = await fetch(feedUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const buffer = await response.buffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
    const processedData = processFeedDataOptimized(feed, feedId);
    
    // Update cache
    feedCache.set(feedId, processedData);
    lastCacheUpdate.set(feedId, Date.now());
    
    res.json(processedData);
  } catch (error) {
    console.error(`❌ Error fetching feed ${req.params.feedId}:`, error.message);
    res.status(500).json({ 
      error: 'Failed to fetch feed data', 
      details: error.message
    });
  }
});

// Memory cleanup endpoint
app.post('/api/debug/cleanup', (req, res) => {
  // Clear old cache entries
  const now = Date.now();
  const expiredFeeds = [];
  
  lastCacheUpdate.forEach((timestamp, feedId) => {
    if (now - timestamp > CACHE_DURATION * 2) {
      feedCache.delete(feedId);
      lastCacheUpdate.delete(feedId);
      expiredFeeds.push(feedId);
    }
  });
  
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
  
  res.json({ 
    message: 'Cleanup completed',
    expiredFeeds,
    cacheSize: feedCache.size,
    memoryUsage: process.memoryUsage()
  });
});

// Cache status endpoint
app.get('/api/debug/cache', (req, res) => {
  const cacheInfo = Array.from(feedCache.keys()).map(feedId => ({
    feedId,
    dataPoints: feedCache.get(feedId)?.length || 0,
    lastUpdate: lastCacheUpdate.has(feedId) ? 
      new Date(lastCacheUpdate.get(feedId)).toISOString() : 'never',
    isValid: isCacheValid(feedId),
    ageMs: lastCacheUpdate.has(feedId) ? Date.now() - lastCacheUpdate.get(feedId) : null
  }));
  
  res.json({
    cacheStatus: cacheInfo,
    cacheDuration: CACHE_DURATION,
    totalCachedFeeds: feedCache.size,
    memoryUsage: process.memoryUsage()
  });
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Optimized startup
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Optimized NYC Subway Map Server');
  console.log(`📍 Port: ${PORT}`);
  console.log(`⚡ Performance Mode: ON`);
  console.log(`📦 Cache Duration: ${CACHE_DURATION / 1000}s`);
  console.log(`🚇 Max trains per route: ${MAX_TRAINS_PER_ROUTE}`);
  console.log(`💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  console.log('✅ Fast server ready!');
});