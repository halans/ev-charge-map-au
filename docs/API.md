# HTTP API reference

Read-only JSON API over the built dataset. Zero dependencies (`node:http`).

```bash
node bin/evmap.js serve --port 8787 --host 127.0.0.1
```

Every example below is **captured from a real run** against the dataset
generated 2026-09-05.

- All responses are `application/json; charset=utf-8` unless stated.
- `Access-Control-Allow-Origin: *` — the data is public and read-only.
- Only `GET`, `HEAD` and `OPTIONS` are accepted; anything else returns 405.
- Every query endpoint delegates to `src/core/search.js`, the same module the
  CLI and web page use, so results are identical across surfaces by
  construction (asserted in `test/equivalence.test.js`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness + dataset age. Works with no dataset built. |
| GET | `/api/meta` | Licences, attribution, freshness budgets, source list |
| GET | `/api/sites` | Search / filter / sort with facets |
| GET | `/api/sites/{id}` | One site with per-field staleness |
| GET | `/api/nearest` | N nearest operational sites to a point |
| GET | `/api/stats` | Counts and coverage statistics |
| GET | `/api/export/{format}` | `csv` · `geojson` · `json` · `odbl` |
| GET | `/` and `/*` | The generated web map from `web/` |

---

## GET /api/health

Deliberately does not require a dataset, so it is usable as a container probe.

```bash
curl http://127.0.0.1:8787/api/health
```

```json
{
  "status": "ok",
  "datasetGeneratedAt": "2026-09-05T07:49:01.009Z",
  "sites": 3157,
  "uptimeSeconds": 3
}
```

Returns **200** with `"status": "ok"`, or **503** with `"status": "no-dataset"`
when no dataset has been built.

---

## GET /api/sites

The main search endpoint.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `q` (or `text`) | string | Matches name, operator, network, suburb, street, postcode |
| `lat`, `lng` | number | Search centre. Adds `distanceM`/`distanceKm` and switches default sort to distance |
| `radiusKm` | number | Requires `lat` **and** `lng`, else 400 |
| `bbox` | string | `minLng,minLat,maxLng,maxLat` (GeoJSON order) |
| `states` (or `state`) | list | e.g. `NSW,VIC`. Case-insensitive |
| `operators` (or `operator`) | list | Canonical names, e.g. `Chargefox` |
| `connectors` (or `connector`) | list | `CCS2` `CHAdeMO` `Type2` `Type1` `CCS1` `TeslaProprietary` `ACUnspecified` `DCUnspecified` |
| `minPowerKw` / `min_kw` | number | Peak power floor |
| `maxPowerKw` / `max_kw` | number | Peak power ceiling |
| `speedBands` (or `speed`) | list | `ultra` `rapid` `fast` `medium` `slow` `trickle` `unknown` |
| `statuses` (or `status`) | list | Default `operational,unknown` |
| `includePlanned` | boolean | Adds `planned` to the status filter |
| `precisions` (or `precision`) | list | `surveyed` `geocoded_address` `geocoded_locality`. Default: the first two |
| `includeApproximate` | boolean | Adds `geocoded_locality` — town-level records, excluded by default |
| `minSources` | number | Corroboration floor — `2` means "confirmed by 2+ sources" |
| `minConfidence` | number | 0–1 |
| `sort` | string | `distance` `relevance` `power` `confidence` `name` |
| `limit` | number | Default 100, max 10,000 |
| `offset` | number | For paging |

Lists accept either form: `?states=NSW&states=VIC` and `?states=NSW,VIC` are
equivalent.

**Default status filter matters.** Planned/unbuilt sites are excluded unless you
ask for them — 98 TfNSW and 11 Victorian records describe chargers that do not
exist yet.

**Default precision filter matters more.** 55 Tasmanian records are located only
to a TOWN (±~5 km) because the source publishes no address. They are excluded
unless you pass `includeApproximate=true`, and they are **never** returned by
`/api/nearest`. Read `positionPrecision` on any site before treating its
coordinates as a location:

```bash
$ curl "…/api/sites?states=TAS" | jq '.total, .facets.positionPrecision'
77
{ "surveyed": 77 }

$ curl "…/api/sites?states=TAS&includeApproximate=true" | jq '.total, .facets.positionPrecision'
132
{ "surveyed": 77, "geocoded_locality": 55 }
```

**Default sort**: `distance` if `lat`/`lng` given, else `relevance` if `q`
given, else `power`. Ties break on `id`, so ordering is deterministic.

### Example

```bash
curl "http://127.0.0.1:8787/api/sites?q=chargefox&states=VIC&minPowerKw=150&limit=1"
```

```json
{
  "generatedAt": "2026-09-05T07:49:01.009Z",
  "total": 8,
  "returned": 1,
  "sort": "relevance",
  "facets": {
    "state": { "VIC": 8 },
    "connector": { "CCS2": 8, "CHAdeMO": 6, "Type2": 1 }
  },
  "attribution": [ "..." ],
  "sites": [
    {
      "id": "au-s367111-1422020-chargefox",
      "name": "Chargefox",
      "displayName": "Chargefox",
      "nameIsDerived": false,
      "operator": "Chargefox",
      "network": "Chargefox",
      "lat": -36.711126,
      "lng": 142.201977,
      "state": "VIC",
      "address": {
        "full": "126 Baillie St, HORSHAM VIC 3400",
        "street": "126 Baillie St",
        "suburb": "HORSHAM",
        "state": "VIC",
        "postcode": "3400"
      },
      "status": "operational",
      "access": "public",
      "fee": true,
      "openingHours": null,
      "website": null,
      "plugCount": 8,
      "maxPowerKw": 350,
      "speedBand": "ultra",
      "connectors": [
        { "standard": "CHAdeMO", "count": 4, "powerKw": 350, "sources": ["osm", "vic"] },
        { "standard": "CCS2",    "count": 4, "powerKw": 350, "sources": ["osm", "vic"] }
      ],
      "sourceCount": 2,
      "sources": [
        {
          "sourceId": "osm",
          "sourceRecordId": "node/8028020165",
          "fetchedAt": "2026-09-05T07:29:09.052Z",
          "url": "https://www.openstreetmap.org/node/8028020165"
        },
        {
          "sourceId": "vic",
          "sourceRecordId": "dcav:dcav_site.32",
          "fetchedAt": "2026-09-05T07:29:11.888Z",
          "url": "https://discover.data.vic.gov.au/dataset/government-funded-public-ev-chargers"
        }
      ],
      "provenance": {
        "name":       { "sourceId": "osm", "sourceRecordId": "node/8028020165", "fetchedAt": "2026-09-05T07:29:09.052Z" },
        "address":    { "sourceId": "vic", "sourceRecordId": "dcav:dcav_site.32", "fetchedAt": "2026-09-05T07:29:11.888Z" },
        "maxPowerKw": { "sourceId": "osm", "sourceRecordId": "node/8028020165", "fetchedAt": "2026-09-05T07:29:09.052Z" }
      },
      "conflicts": {
        "name":      [{ "sourceId": "vic", "value": "Horsham" }],
        "access":    [{ "sourceId": "vic", "value": "unknown" }],
        "plugCount": [{ "sourceId": "vic", "value": 4 }]
      },
      "spatialSpreadM": 45,
      "confidence": 0.65,
      "relevance": 13.5
    }
  ]
}
```

That single record shows the whole reconciliation model working: OpenStreetMap
and Victoria both describe this Horsham site, they sit **45 m apart**, they
disagree on the name (`"Chargefox"` vs `"Horsham"`) and the plug count (8 vs 4),
and every surviving value names the source it came from.

### Site object fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable across re-ingest |
| `name` | string \| null | **Published** name; null when no source publishes one |
| `displayName` | string | Always present — falls back to operator + suburb |
| `nameIsDerived` | boolean | True when `displayName` was constructed |
| `operator` / `network` | string \| null | Canonicalised (aliases folded) |
| `lat` / `lng` | number | From the most-trusted source, never a centroid |
| `state` | string | From address, else inferred from coordinates |
| `address` | object \| null | `full`, `street`, `suburb`, `state`, `postcode` |
| `status` | string | `operational` `planned` `construction` `decommissioned` `unknown` |
| `access` | string | `public` `restricted` `private` `unknown` |
| `fee` | boolean \| null | **`null` means unknown, not free** |
| `plugCount` | number \| null | |
| `maxPowerKw` | number \| null | Peak per-plug power |
| `speedBand` | string | Derived from `maxPowerKw` |
| `connectors[]` | array | `standard`, `count`, `powerKw`, `sources[]` |
| `sourceCount` | number | Distinct sources describing this site |
| `sources[]` | array | Per-source record ids, fetch times, upstream URLs |
| `provenance` | object | field → `{ sourceId, sourceRecordId, fetchedAt }` |
| `conflicts` | object | field → rejected values with their source |
| `spatialSpreadM` | number | Max disagreement between sources, in metres |
| `positionPrecision` | string | `surveyed` (~10 m) · `geocoded_address` (~100 m, ACT) · `geocoded_locality` (**~5 km, a town centroid — not the charger**, TAS) |
| `positionErrorMetres` | number | Nominal error for that precision |
| `geocoded` | boolean | True when the coordinate was derived rather than published. Prefer `positionPrecision`, which distinguishes street-level from town-level. |
| `confidence` | number | 0–1, explainable (see ARCHITECTURE.md) |
| `distanceM` / `distanceKm` | number | Only when `lat`/`lng` supplied |
| `relevance` | number | Only when `q` supplied |

**Read `fee: null` carefully.** NSW and Victoria publish no fee field at all, so
most sites are unknown. Rendering that as "free" would be wrong.

**Read `positionPrecision` before plotting.** A `geocoded_locality` record marks
a town, not a charger. Showing it as an ordinary pin would misrepresent the data
by kilometres.

---

## GET /api/sites/{id}

```bash
curl "http://127.0.0.1:8787/api/sites/au-s367111-1422020-chargefox"
```

Returns the full site plus computed per-field staleness:

```json
{
  "generatedAt": "2026-09-05T07:49:01.009Z",
  "site": { "...": "as above" },
  "staleness": {
    "status": {
      "field": "status",
      "ageDays": 0.01,
      "budgetDays": 30,
      "stale": false,
      "sourceId": "osm"
    },
    "lat": { "field": "lat", "ageDays": 0.01, "budgetDays": 3650, "stale": false, "sourceId": "osm" }
  }
}
```

Each field is aged against its own budget (see
[ARCHITECTURE.md](ARCHITECTURE.md#freshness)) — coordinates get 3,650 days,
`status` gets 30. Use this to label an individual value as possibly outdated
rather than stamping the whole record.

**404** `NOT_FOUND` if the id does not exist.

---

## GET /api/nearest

```bash
curl "http://127.0.0.1:8787/api/nearest?lat=-33.8688&lng=151.2093&n=3"
```

| Parameter | Required | Notes |
|---|---|---|
| `lat`, `lng` | yes | 400 if missing or non-numeric |
| `n` | no | Default 5, must be 1–100 |

Ignores all other filters, but **never returns planned sites** — the nearest
charger must be one that exists — and **never returns town-level records**,
because this is the endpoint most likely to be trusted for navigation. Results
are ascending by `distanceM`.

---

## GET /api/meta

Licence and provenance metadata, without the sites. Fetch this to render
attribution correctly.

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-09-05T07:49:01.009Z",
  "licence": {
    "effective": "ODbL 1.0 (share-alike inherited from OpenStreetMap)",
    "reason": "This artefact is a Derivative Database of OpenStreetMap data, so ODbL share-alike applies to the database as a whole.",
    "note": "Individual source records remain under their own licences, listed in attribution[]."
  },
  "attribution": [
    {
      "sourceId": "nominatim",
      "text": "Geocoding © OpenStreetMap contributors (Nominatim)",
      "licence": "ODbL 1.0",
      "licenceUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
      "shareAlike": true
    },
    {
      "sourceId": "osm",
      "text": "© OpenStreetMap contributors",
      "licence": "ODbL 1.0",
      "licenceUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
      "shareAlike": true
    }
  ],
  "freshnessBudgetDays": { "lat": 3650, "status": 30, "fee": 30 },
  "sources": [
    {
      "sourceId": "nsw",
      "name": "Transport for NSW — EV Charging Locations",
      "jurisdiction": "NSW",
      "licence": "CC-BY 3.0 AU",
      "recordCount": 1958,
      "issueRate": 0.3167,
      "structuralIssueRate": 0,
      "recommendedRefresh": "weekly",
      "coverageCaveat": null
    }
  ],
  "counts": { "sites": 3102, "merged": 649, "multiSourceSites": 389 }
}
```

---

## GET /api/stats

```json
{
  "generatedAt": "2026-09-05T07:49:01.009Z",
  "counts": {
    "sourceRecords": 3751,
    "sites": 3157,
    "mappableSites": 3102,
    "approximateSites": 55,
    "plannedSites": 113,
    "merged": 649,
    "multiSourceSites": 389,
    "sitesWithConflicts": 341,
    "pairsConsidered": 2974,
    "links": 796,
    "collisionsResolved": 0,
    "rejectedInvalidCoords": 0
  },
  "coverage": {
    "sites": 3157,
    "mappableSites": 3102,
    "approximateSites": 55,
    "estimatedPlugs": 9216,
    "byState": {
      "NSW": 1906, "VIC": 598, "QLD": 233, "WA": 103,
      "SA": 102, "TAS": 136, "ACT": 58, "NT": 21
    },
    "bySpeed": { "ultra": 146, "rapid": 153, "fast": 435, "medium": 76, "slow": 787, "trickle": 113, "unknown": 1392 },
    "bySourceCount": { "1": 2768, "2": 389 },
    "byPrecision": { "surveyed": 3069, "geocoded_address": 33, "geocoded_locality": 55 },
    "topOperators": [{ "operator": "Chargefox", "count": 449 }],
    "completeness": { "withName": 0.6319, "withPower": 0.5513, "withConnectors": 0.8694 }
  }
}
```

---

## GET /api/export/{format}

| Format | Content-Type | Notes |
|---|---|---|
| `csv` | `text/csv` | Flattened, with `#`-prefixed attribution header |
| `geojson` | `application/geo+json` | FeatureCollection with a `metadata` member carrying attribution |
| `json` | `application/json` | Full dataset including provenance |
| `odbl` | `application/json` | **Compliance bundle** — see below |

All set `Content-Disposition: attachment`. Byte-identical to the CLI's
`evmap export` output (asserted by test).

### The ODbL bundle

```bash
curl "http://127.0.0.1:8787/api/export/odbl" -o bundle.json
```

Returns a JSON envelope containing `LICENCE-NOTICE.txt`, `dataset.json`,
`dataset.csv` and `dataset.geojson`. This is **not a convenience feature** —
because the pipeline ingests OpenStreetMap into its own store, the result is an
ODbL Derivative Database and share-alike obliges the operator to offer it back
under ODbL on request. Exposing it as an endpoint makes compliance a command
rather than a promise. See
[DATA_SOURCES.md](DATA_SOURCES.md#odbl-obligations).

---

## Errors

Every failure returns the same envelope:

```json
{ "error": { "code": "BAD_QUERY", "message": "...", "detail": "..." } }
```

`code` values are stable strings, safe to switch on.

| Code | HTTP | Cause |
|---|---|---|
| `BAD_QUERY` | 400 | Invalid parameter — unknown `sort`, `radiusKm` without a centre, malformed `bbox`, unknown export format |
| `NOT_FOUND` | 404 | Unknown site id or unknown endpoint |
| `METHOD_NOT_ALLOWED` | 405 | Anything other than GET/HEAD/OPTIONS |
| `DATASET_UNAVAILABLE` | 503 | No dataset built — run `evmap ingest` |
| `INTERNAL` | 500 | Unhandled server error |

Real examples:

```bash
$ curl -s "http://127.0.0.1:8787/api/sites?sort=bogus"
{"error":{"code":"BAD_QUERY","message":"Unknown sort \"bogus\". Valid: distance, relevance, power, confidence, name"}}

$ curl -s "http://127.0.0.1:8787/api/sites?radiusKm=5"
{"error":{"code":"BAD_QUERY","message":"radiusKm requires both lat and lng"}}

$ curl -s "http://127.0.0.1:8787/api/sites/does-not-exist"
{"error":{"code":"NOT_FOUND","message":"No site with id \"does-not-exist\""}}
```

A radius query without a centre is rejected rather than silently returning the
whole country — a client bug should be loud.

## Using the engine directly

If you are in Node, skip HTTP:

```js
const pipeline = require('ev-charge-map-au/src/pipeline');
const search = require('ev-charge-map-au/src/core/search');

const dataset = pipeline.loadDataset();
const { total, results } = search.query(dataset.sites, {
  lat: -33.8688,
  lng: 151.2093,
  radiusKm: 5,
  connectors: ['CCS2'],
  minPowerKw: 50,
});
```

Identical results, no serialisation cost. `search.query` throws on invalid input
(the API maps those throws to `BAD_QUERY`).
