# Building, testing and extending

## Requirements

Node 18 or newer. **No `npm install`** — there are no runtime or dev
dependencies. Everything uses Node built-ins plus one vendored browser library
(Leaflet, committed under `web/vendor/`).

## Commands

```bash
node bin/evmap.js ingest --offline   # rebuild from the shipped cache, no network
node bin/evmap.js ingest             # fetch fresh from all six sources
node bin/evmap.js build              # generate web/index.html
node test/run.js                     # 285 tests, fully offline
node bin/evmap.js serve              # API + map on 127.0.0.1:8787

npm run all                          # ingest:offline && build && test
```

## The build in full

```
$ node bin/evmap.js ingest
[osm] OpenStreetMap (Overpass API)
  → osm-au-chargers.json: fetching https://overpass-api.de/api/interpreter
  ✓ osm-au-chargers.json: 563153 bytes, sha256 51b2493fad10 (unchanged)
  1590 records normalised, 0 issues (48ms)

[nsw] Transport for NSW — EV Charging Locations
  → nsw-package.json: fetching https://opendata.transport.nsw.gov.au/data/api/3/action/package_show?id=be1c4de4-4517-4bd0-8a09-2965ddfc7179
  ✓ nsw-package.json: 7413 bytes, sha256 9f8e4e253338 (unchanged)
  → nsw-ev.csv: fetching .../download/ev_20251216.csv
  ✓ nsw-ev.csv: 283030 bytes, sha256 42397310a411 (unchanged)
  1958 records normalised, 620 issues (2062ms)

[vic] Victoria DEECA — Government Funded Public EV Chargers
  → vic-dcav.json: fetching https://opendata.maps.vic.gov.au/geoserver/wfs?...typeNames=open-data-platform%3Adcav_site&outputFormat=application%2Fjson
  ✓ vic-dcav.json: 108744 bytes, sha256 8dfe1063dbb0 (unchanged)
  152 records normalised, 11 issues (1209ms)

[qld] QLD Transport and Main Roads — Find a charging station (QESH)
  → qld-ev.csv: fetching https://www.tmr.qld.gov.au/-/media/aboutus/corpinfo/Open%20data/findachargingev/csl_ev.csv
  ✓ qld-ev.csv: 3798 bytes, sha256 6bee7c7e9c90 (unchanged)
  17 records normalised, 17 issues (196ms)

[act] ACT Government — Public EV chargers (Climate Choices)
  → act-chargers.html: fetching https://www.climatechoices.act.gov.au/transport-and-travel/zero-emissions-vehicles/public-ev-chargers-in-the-act
  ✓ act-chargers.html: 159033 bytes, sha256 c4e0a11b7d2f (unchanged)
  geocode: 35 addresses — 35 cached, 0 fetched, 1 unresolved
  34 records normalised, 35 issues (212ms)

[tas] Tasmania NRE — Electric Vehicle ChargeSmart Grants
  → tas-chargesmart.html: fetching https://nre.tas.gov.au/environment/climate-change/climate-change-grant-programs/electric-vehicle-chargesmart-grants
  ✓ tas-chargesmart.html: 333367 bytes, sha256 a19c7f4b2e08 (unchanged)
  geocode: 42 addresses — 42 cached, 0 fetched, 0 unresolved
  55 records normalised, 111 issues (198ms)

Resolving 3806 records into canonical sites…

3806 source records -> 3157 canonical sites (649 merged, 389 corroborated by 2+ sources)
```

Then:

```
$ node bin/evmap.js build
Bundling core modules for the browser…
  inlined 3 core modules (36.8 KiB)
  vendored Leaflet (144.1 KiB js, 14.5 KiB css)
  wrote index.html with 3157 sites

Built 2 file(s) into web
  index.html  3009.8 KiB
  sites.json  2764.1 KiB
```

Outputs:

| Path | Contents |
|---|---|
| `data/raw/*` | Cached upstream responses, verbatim |
| `data/cache/manifest.json` | Per-file url, timestamp, sha256, byte count |
| `data/raw/geocode-cache.json` | Address → coordinate cache (committed, so offline rebuilds work) |
| `data/cache/dataset.json` | The canonical dataset (~5 MB) |
| `data/cache/ingest-report.json` | Per-source counts, issue rates, coverage |
| `web/index.html` | Single self-contained page (works from `file://`) |
| `web/sites.json` | Slim dataset for external consumers |

## How the web build works

`build/build-web.js` does **not** contain a copy of the search logic. It reads
`src/core/{geo,normalise,search}.js` off disk and inlines them verbatim behind a
six-line CommonJS shim:

```js
var __evmapModules = {};
function __evmapRequire(p) { /* ... */ }
__evmapModules['search'] = (function () {
  var module = { exports: {} };
  var require = __evmapRequire;
  /* ...src/core/search.js, verbatim... */
  return module.exports;
})();
```

`build/app.js` then calls `__evmapRequire('search').query(...)`. Change a
matching rule in `src/core/` and the web page changes with it on the next build.
Three tests fail if that ever stops being true — see below.

The page is deliberately one file so it can be opened without a server and
archived as a single artefact. Map **tiles** still need network (inherent to any
tiled map); when they fail the page switches to a canvas scatter plot so search
stays usable offline.

### Re-vendoring Leaflet

```bash
curl -sL -o web/vendor/leaflet.js  https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
curl -sL -o web/vendor/leaflet.css https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
```

Committed on purpose: no CDN dependency at runtime.

## Testing

```
$ node test/run.js
ev-charge-map-au test suite
==========================================================

csv
  ✓ parses a simple table
  ✓ strips a UTF-8 BOM (REGRESSION: TfNSW ships one on the header row)
  ...
----------------------------------------------------------
285/285 passed

Completed in 1.9s
```

The runner is `test/run.js`; `test/harness.js` is a ~100-line
describe/it/assert implementation. Exit code 0 on pass, 1 on any failure.

| File | Covers |
|---|---|
| `test/core.test.js` | CSV, geo, normalisation, resolution, search |
| `test/sources.test.js` | Each adapter **against the real cached upstream files** |
| `test/pipeline.test.js` | Fetch/cache/checksums, freshness, drift, CLI exit codes |
| `test/equivalence.test.js` | Cross-surface equivalence, API contract, exports |

Three properties worth knowing about:

**Adapters are tested against real data, not fixtures.** Synthetic fixtures
would have passed happily while the Victorian status heuristic mislabelled 96
live sites as unbuilt. The trade-off is that some assertions are ranges
(`atLeast(1800)`) rather than exact counts, so a legitimate upstream update
does not break the build.

**Cross-surface equivalence is actually verified.** Eight queries run through
core, through a live HTTP server, and through the browser bundle evaluated in a
`node:vm` context; the returned id lists must be identical. Plus a guard test
that fails if `build/app.js` starts filtering `SITES` itself.

**Exports are compared byte-for-byte** between the CLI module and the HTTP
endpoint.

### Bugs this suite exists to prevent

Tests tagged `REGRESSION` encode defects found while building against live data
on 2026-09-05. They are the highest-value tests in the file:

| Bug | What went wrong |
|---|---|
| VIC status inversion | A populated `estimated_project_completion` was read as "not yet built". 96 of 152 rows carry a value, mostly **past** dates on completed projects. Mislabelled 96 live sites; correct answer is 11. |
| Day-first dates | `"31/07/2023"` is 31 July. `Date.parse()` reads it as invalid or US-style. |
| QLD record count | `wc -l` says 34, the real count is 17 — newlines inside quoted CSV fields. |
| QLD 403 as data | Without a browser User-Agent the endpoint returns an HTML error page, which a lenient parser reads as a zero-row CSV. |
| Negative-latitude CLI args | `--near "-33.8688,151.2093"` was parsed as a boolean flag because the value starts with `-`. Every Australian latitude is negative. |
| `process.exit()` truncating stdout | `evmap export --format geojson > out.json` produced a file cut off at ~146 KB. Fixed by setting `process.exitCode` and letting the stream drain. |
| CCS mislabelled as AC | Open Charge Map's `"CCS (Type 2)"` collapses to `"ccstype2"`, which contains `"type2"` — a Type-2-first check turned a 350 kW DC plug into a slow AC socket. |
| Operator alias lookup | Aliases were stored raw but looked up normalised, so `"n/a"` never matched (`operatorKey` yields `"n a"`). |
| Drift false positives | An absolute issue-rate threshold failed QLD on every run, because all 17 records have an empty plug-count column forever. Drift now measures **structural** parse failures only. |
| UTF-8 BOM | TfNSW ships one on the header row, making the first column name `"﻿OBJECTID"`. |
| **ACT recorded as a dead end** | The conclusion came from searching the ACT's open-data portal. The ACT publishes its charger list as HTML tables on a *policy* page. Government data is not always in the data portal — the same re-check then found Tasmania publishing the same way. |
| **Name vocabularies compared across sources** | The ACT names venues ("Next Gen Canberra"); OSM without a `name` tag falls back to the operator ("Exploren"). The name-conflict penalty rejected a pair sitting **0 m apart**. Fixed by `describesVenue()`; recovered 5 more merges nationally. |
| **Geocoder collapsed two venues** | "Mawson Club" (10 Heard St) and "Southlands Shopping Centre" (12 Heard St) geocoded to the *identical* coordinate. Two geocoded records now need name agreement to merge, since distance carries no information between them. |
| **ACT district figures off by one** | The "N bays are on the way" lookback took the *first* regex match in the window, so every district was attributed the previous district's number. |
| `vic` silently ranked last | Victoria was missing from every per-field trust list, and `pickField` ranks unlisted sources last — so the source with the best-structured connector data lost every tie. |
| **`includeApproximate` ignored over HTTP** | The CLI and core honoured it; `queryFromParams` never mapped it, so town-level records were unreachable through the API. The equivalence test missed it because its case list did not cover the parameter — a reminder that such a test only guarantees the cases you enumerate. |
| **Vacuous tamper tests** | Two "rejects a tampered page" tests edited a string that appears in the page's *prose* rather than a table cell, so validation was never actually exercised. The tamper tests now assert the tamper changed the PARSED data first. |
| **ACT district figures off by one** (again) | See above — the same lookback pattern in the Tasmanian adapter takes the nearest preceding heading deliberately. |
| Stale Overpass mirror | The fallback mirror returned **HTTP 200 with 1,493 elements** against the primary's 1,590 — not truncated, no `remark`, but its database was 43 days behind. A silent 6% coverage loss, *below* the record-count drift threshold. Now caught by validating `osm3s.timestamp_osm_base`. |
| Overpass 406 | The endpoint rejected our descriptive User-Agent when no `Accept` header was sent; curl with the same query succeeded. The fetch layer now always sends `Accept`. |

## Adding a data source

Write one module in `src/sources/` and register it. Nothing else changes — the
pipeline, CLI, API and web build all iterate the registry.

```js
'use strict';
const geo = require('../core/geo');
const nrm = require('../core/normalise');

const id = 'sa'; // short, stable; appears in provenance and CLI flags

const meta = {
  id,
  name: 'South Australia — Public EV Chargers',
  jurisdiction: 'SA',
  licence: 'CC-BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: '© Government of South Australia',
  attributionRequired: true,
  shareAlike: false,
  homepage: 'https://data.sa.gov.au/...',
  changeCadence: 'monthly',
  recommendedRefresh: 'weekly',
  coverageCaveat: null,        // state it if coverage is partial
};

function requests() {
  return [{
    key: 'sa-chargers.json',   // filename under data/raw/
    urls: ['https://...'],     // tried in order (mirrors)
    format: 'json',            // 'json' | 'text'
    headers: {},               // e.g. a browser UA if the host demands one
    validate: (parsed) => {    // runs BEFORE the cache is written
      if (!parsed || !Array.isArray(parsed.features)) return 'not a FeatureCollection';
      if (!parsed.features.length) return 'zero features';
      return null;             // null = valid
    },
    // Optional two-stage fetch: return further requests from the response.
    // then: (parsed) => [{ key: 'sa-data.csv', urls: [parsed.downloadUrl], format: 'text' }],
  }];
}

function normalise(raw, ctx = {}) {
  const fetchedAt = ctx.fetchedAt || new Date().toISOString();
  const records = [];
  const issues = [];

  for (const [index, row] of (raw.features || []).entries()) {
    const lat = Number(row.lat);
    const lng = Number(row.lng);
    const recordId = `sa:${row.id || index}`;

    if (!geo.isValidLatLng(lat, lng) || !geo.isInAustralia(lat, lng)) {
      issues.push({ sourceId: id, sourceRecordId: recordId, kind: 'rejected',
                    issue: 'missing or invalid coordinates' });
      continue;
    }

    records.push({
      sourceId: id,
      sourceRecordId: recordId,      // stable across re-ingest
      sourceUrl: meta.homepage,
      fetchedAt,
      lat, lng,
      name: nrm.cleanText(row.name),
      operator: nrm.normaliseOperator(row.operator),
      network: null,
      address: nrm.parseAddress(row.address),
      connectors: [],                 // [{ standard, count, powerKw }]
      plugCount: null,
      maxPowerKw: nrm.parsePowerRating(row.power).maxKw,
      status: nrm.normaliseStatus(row.status),
      access: nrm.normaliseAccess(row.access),
      fee: nrm.normaliseFee(row.fee),  // null when unknown — NEVER false
      openingHours: null,
      website: null,
      extra: {},                       // source-specific, kept for QA
    });
  }

  return { records, issues };
}

module.exports = { id, meta, requests, normalise };
```

Then in `src/sources/index.js`:

```js
const sa = require('./sa');
const DEFAULT_SOURCES = [osm, nsw, vic, qld, sa];
const ALL_SOURCES = [osm, nsw, vic, qld, sa, ocm];
```

### Rules for adapters

1. **Licence first.** If you cannot state the licence and required attribution,
   do not add the source. Unspecified is not the same as permissive.
2. **`fee: null` means unknown.** Never coerce a missing fee to `false`; the UI
   must not imply a paid charger is free.
3. **Never invent a value.** If a rating is unparseable, leave the field null and
   push a `parse_failure` issue. Guessing corrupts the merge silently.
4. **Classify every issue** with a `kind` (`rejected`, `parse_failure`,
   `data_gap`, `status_flag`, `policy`). Drift depends on it —
   [ARCHITECTURE.md](ARCHITECTURE.md#structural-vs-cosmetic-issues).
5. **Stable `sourceRecordId`.** If upstream has no usable key, hash the
   identifying content (see `nsw.syntheticId`) rather than using the row index.
6. **Validate before caching.** An HTML error page must never overwrite good
   data.
7. **State coverage caveats** in `meta.coverageCaveat`. "Government-funded only"
   is essential context, and it surfaces in the UI and the ODbL bundle.
8. **Add adapter tests against the real cached file**, following the pattern in
   `test/sources.test.js`.

### If your source has no coordinates

Set `requiresGeocoding: true` and `geocodeRegion` in `meta`, and export an
`addressesToGeocode(raw)` function returning the address strings. The pipeline
warms the geocode cache in one throttled pass before calling `normalise()`, and
your `normalise()` reads coordinates with `geocoder.fromCache(address)`.

Rules that are not optional:

1. **Rank your source last for `lat`/`lng`** in `resolve.DEFAULT_FIELD_TRUST`.
   A geocoded coordinate must never override a surveyed one.
2. **Set `geocoded: true` on every record.** The matcher relies on it to avoid
   merging two venues the geocoder collapsed onto one point.
3. **Drop, don't guess.** `fromCache` returns `undefined` (never queried) or
   `null` (queried, no result). Either way, reject the record with an issue
   rather than placing it at a suburb centroid.
4. **Declare the precision honestly.** Set `positionPrecision` on every record:
   `geocoded_address` for a street address (~100 m, usable), or
   `geocoded_locality` for a town name (~5 km, NOT a location). Locality
   records are auto-excluded from the default view, barred from merging and
   from `/api/nearest`, and confidence-penalised — you get that behaviour for
   free by labelling the data truthfully. Tasmania is the worked example.
5. **Guard ambiguous place names.** Nine Tasmanian town names also exist on the
   mainland. Appending the region to the query fixed all 42, but the adapter
   still rejects any geocode outside the state's bounding box, because relying
   on the geocoder getting it right is not a guarantee.

### Tuning the matcher

Thresholds are in `resolve.MATCH` and overridable per call:

```js
resolve.resolve(records, { scoreThreshold: 0.6, maxDistanceM: 150 });
```

Check the effect on the real dataset, not in the abstract:

```bash
node bin/evmap.js ingest --offline --json | head -30
# watch: merged, multiSourceSites, sitesWithConflicts
```

Raising `scoreThreshold` under-merges (doubled pins); lowering it over-merges
(distinct chargers in one car park collapse). `scorePair()` returns `reasons`
for debugging a specific pair:

```js
const { score, distanceM, reasons } = resolve.scorePair(recordA, recordB);
console.log(score, distanceM, reasons);
// 0.83 12 [ 'distance 12m (+0.57)', 'operator match "Tesla" (+0.25)', ... ]
```

## Enabling Open Charge Map

Off by default (needs a free key). Register an application at
openchargemap.org, then:

```bash
export OCM_API_KEY=your-key-here
node bin/evmap.js ingest --sources osm,nsw,vic,qld,ocm
```

The adapter pins `opendata=true` and drops any record whose provider is not
flagged open-licensed. **Do not remove that filter** — unfiltered OCM mixes
proprietary operator data into what is otherwise a redistributable database.
Keys are redacted from the manifest and all logs.

## CI

```yaml
- run: node bin/evmap.js drift     # exit 2 fails the build
- run: node bin/evmap.js build
- run: node test/run.js
```

Exit codes: `0` ok · `1` drift warnings · `2` drift failures or a source error ·
`3` usage error · `4` runtime error. Distinct codes let CI treat a genuine
schema break differently from a wobble in record counts.

## Code conventions

- **Zero runtime dependencies.** Node built-ins only. Vendor browser libraries.
- **`src/core/` must not use Node built-ins** — those modules are inlined into
  the browser bundle. No `fs`, no `path`, no `require('crypto')`.
- **Comments explain *why*, with the measurement.** `// 522 rows state "AC"
  where a rating belongs` is useful; `// parse the rating` is not. Every
  defensive rule should be traceable to real data so a future maintainer can
  tell a necessary guard from superstition.
- **Fail loudly on bad input.** A radius query with no centre throws rather than
  returning the whole country.
- **No secrets in anything persisted.** `fetch.redactUrl` strips declared
  secrets and common key parameter names.
