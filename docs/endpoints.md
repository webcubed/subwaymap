## Text endpoints (plain text responses)

These endpoints return human-readable strings (text/plain) with arrivals summarized for nearby transit. They are available at both the root and under `/api`, e.g. `/preliminary` and `/api/preliminary`.

### GET /preliminary?lat={lat}&lon={lon}

-   Purpose: Broad, lightweight summary for the area around the provided coordinates.
-   What it returns (as a single string):
    -   Subway: For the nearest subway station, each line’s next 2 arrivals. Times in 24-hour format with countdowns.
    -   Bus: Up to two nearest bus stops (often opposing directions). For each stop, next 2 arrivals per route.
    -   LIRR: Only if within 1 mile (≈1609 m) and on the Port Washington branch; shows the next 2 arrivals.
-   Data sources: MTA GTFS-realtime (Subway + LIRR), OneBusAway and SIRI (Bus).
-   Notes:
    -   Bus endpoints require an MTA BusTime API key (env var `MTA_API_KEY`). If unavailable or upstream fails, the Bus section may be omitted.
    -   Subway/LIRR do not require an API key.
    -   Times are rendered in 24-hour format (HH:mm) and include a countdown like “(16 min)” or “(1 hr 1 min)”.

Example response (text):

Subway:
7 to 34 St-Hudson Yards @ Flushing Main St at 19:30 (16 min) & 19:35 (21 min)
Bus:
Q28 to RUSH Flushing @ Crocheron and 168th St at 19:16 (2 min) & 19:20 (6 min)
Q28 to RUSH Bay Terrace @ Crocheron and 168th St at 19:18 (4 min) & 19:20 (6 min)
LIRR:
To Penn Station @ Broadway at 19:30 (16 min) & 20:00 (46 min)
To Port Washington @ Broadway at 19:45 (31 min) & 20:15 (1 hr 1 min)

Parameters:

-   lat (required): latitude
-   lon (required): longitude

HTTP details:

-   Method: GET
-   Content-Type: text/plain

---

### GET /nearby?lat={lat}&lon={lon}

-   Purpose: Precise, detailed summary at very close range. Chooses the single closest item among bus stop, subway station, or LIRR station and provides more details.
-   What it returns (as a single string):
    -   Exactly one section (Bus/Subway/LIRR) for the closest entity within ~150 m.
    -   Next 3 arrivals for that entity, with line, destination, stop/station name, 24-hour times, and countdowns.
    -   If the closest is a subway station with multiple lines, each line appears with its own 3 arrivals. Similarly for a bus stop with multiple routes.
-   Data sources: MTA GTFS-realtime (Subway + LIRR), OneBusAway and SIRI (Bus).
-   Notes:
    -   Bus requires `MTA_API_KEY`; if unavailable, bus results will not be included.
    -   Unlike `/preliminary`, `/nearby` includes all LIRR branches (not limited to Port Washington) if LIRR is the closest.

Example response (text):

Subway:
7 to 34 St-Hudson Yards @ Flushing Main St at 19:30 (16 min) & 19:35 (21 min) & 19:41 (27 min)
7 to Times Sq-42 St @ Flushing Main St at 19:32 (18 min) & 19:38 (24 min) & 19:45 (31 min)

Parameters:

-   lat (required): latitude
-   lon (required): longitude

HTTP details:

-   Method: GET
-   Content-Type: text/plain

---

### GET /nearby/subway?lat={lat}&lon={lon}

-   Purpose: Subway-only variant of nearby. Always returns the nearest subway station regardless of distance, with the next 3 arrivals per line.
-   What it returns (as a single string): Lines like "7 to 34 St-Hudson Yards @ Flushing Main St at 19:30 (16 min) & 19:35 (21 min) & 19:41 (27 min)" for each line serving the nearest station.
-   Notes: No distance gating; if the nearest station is far, it still returns that station.

### GET /nearby/bus?lat={lat}&lon={lon}

-   Purpose: Bus-only variant of nearby. Always returns the single nearest bus stop regardless of distance, with the next 3 arrivals per route/destination.
-   Notes:
    -   Requires `MTA_API_KEY`.
    -   If BusTime is unavailable, returns an empty string.

### GET /nearby/lirr?lat={lat}&lon={lon}

-   Purpose: LIRR-only variant of nearby. Always returns the nearest LIRR station regardless of distance, with the next 3 arrivals (all branches).
-   Notes: Unlike `/preliminary`, there’s no branch restriction; shows whichever trips stop at that station.

Operational notes

-   These endpoints rely on a generated `frontend/stations.json` (and static GTFS) to resolve station locations and map station → platform stop_ids for subway.
-   If the bus key is missing or upstream APIs are unavailable, the affected section will be omitted, but other sections still return when possible.

---

## Legacy JSON endpoints

-   **/by-location?lat=[latitude]&lon=[longitude]**  
     Returns the 5 stations nearest the provided lat/lon pair.

```javascript
{
    "data": [
        {
            "N": [
                {
                    "route": "6",
                    "time": "2014-08-29T14:00:55-04:00"
                },
                {
                    "route": "6X",
                    "time": "2014-08-29T14:10:30-04:00"
                },
                ...
            ],
            "S": [
                {
                    "route": "6",
                    "time": "2014-08-29T14:04:14-04:00"
                },
                {
                    "route": "6",
                    "time": "2014-08-29T14:11:07-04:00"
                },
                ...
            ],
            "hasData": true,
            "id": 123,
            "location": [
                40.725606,
                -73.9954315
            ],
            "name": "Broadway-Lafayette St / Bleecker St",
            "routes": [
                "6X",
                "6"
            ],
            "stops": {
                "637": [
                    40.725915,
                    -73.994659
                ],
                "D21": [
                    40.725297,
                    -73.996204
                ]
            }
        },
        {
            "N": [
                {
                    "route": "6X",
                    "time": "2014-08-29T14:09:30-04:00"
                },
                {
                    "route": "6",
                    "time": "2014-08-29T14:13:30-04:00"
                },
                ...
            ],
            "S": [
                {
                    "route": "6",
                    "time": "2014-08-29T14:05:14-04:00"
                },
                {
                    "route": "6",
                    "time": "2014-08-29T14:12:07-04:00"
                },
                ...
            ],
            "hasData": true,
            "id": 124,
            "location": [
                40.723315,
                -73.9974215
            ],
            "name": "Spring St / Prince St",
            "routes": [
                "6X",
                "6"
            ],
            "stops": {
                "638": [
                    40.722301,
                    -73.997141
                ],
                "R22": [
                    40.724329,
                    -73.997702
                ]
            }
        },
        ...
    ],
    "updated": "2014-08-29T15:27:27-04:00"
}
```

-   **/by-route/[route]**  
     Returns all stations on the provided train route.

```javascript
{
    "data": [
        {
            "N": [
                {
                    "route": "6X",
                    "time": "2014-08-29T14:01:54-04:00"
                },
                {
                    "route": "5",
                    "time": "2014-08-29T14:04:35-04:00"
                },
                {
                    "route": "4",
                    "time": "2014-08-29T14:07:00-04:00"
                },
                ...
            ],
            "S": [
                {
                    "route": "6",
                    "time": "2014-08-29T14:01:53-04:00"
                },
                {
                    "route": "4",
                    "time": "2014-08-29T14:04:52-04:00"
                },
                ...
            ],
            "hasData": true,
            "id": 12,
            "location": [
                40.804138,
                -73.937594
            ],
            "name": "125 St",
            "routes": [
                "6X",
                "5",
                "4",
                "6"
            ],
            "stops": {
                "621": [
                    40.804138,
                    -73.937594
                ]
            }
        },
        {
            "N": [
                {
                    "route": "5",
                    "time": "2014-08-29T14:07:05-04:00"
                },
                {
                    "route": "4",
                    "time": "2014-08-29T14:09:30-04:00"
                },
                ...
            ],
            "S": [
                {
                    "route": "4",
                    "time": "2014-08-29T14:02:22-04:00"
                },
                {
                    "route": "5",
                    "time": "2014-08-29T14:03:36-04:00"
                },
                ...
            ],
            "hasData": true,
            "id": 123,
            "location": [
                40.813224,
                -73.929849
            ],
            "name": "138 St - Grand Concourse",
            "routes": [
                "5",
                "4"
            ],
            "stops": {
                "416": [
                    40.813224,
                    -73.929849
                ]
            }
        },
        ...
    ],
    "updated": "2014-08-29T15:25:27-04:00"
}
```

-   **/by-id/[id],[id],[id]...**  
     Returns the stations with the provided IDs, in the order provided. IDs should be comma separated with no space characters.

-   **/routes**  
     Lists available routes.

```javascript
{
    "data": [
        "S",
        "L",
        "1",
        "3",
        "2",
        "5",
        "4",
        "6",
        "6X"
    ],
    "updated": "2014-08-29T15:09:57-04:00"
}
```
