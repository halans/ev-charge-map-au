# ev-charge-map-au

Maps every public EV charging site in Australia that appears in **openly-licensed
data**, and keeps it current.

One shared engine drives four surfaces: an ingest pipeline, a CLI, a read-only
HTTP API, and a single-file offline web map. Zero runtime dependencies.

```
3,806 source records  ->  3,157 canonical sites  ->  9,216 plugs
                          3,102 mappable  +  55 town-level (hidden by default)
                          649 merged duplicates
                          389 sites corroborated by 2+ independent sources
```

Measured on a real run, 2026-09-05. Against the best independent estimate of the
national total (~3,774 sites / 10,350 bays, Carloop, Aug 2026), open data alone
reaches roughly **82% of sites and 89% of bays** — far better than
OpenStreetMap alone, which covers 27–42%.

## What this is not

- **Not live availability.** There is no "is this plug free right now" data here,
  because none is openly licensed. See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md#what-open-data-cannot-give-you).
- **Not complete.** Roughly one in five Australian charging sites is absent from
  all open sources. Never present this as authoritative.
- **Not a product.** It is a working reference implementation: no accounts, no
  routing, no trip planning.

## Quick start

Requires Node 18+. No `npm install` step — there are no dependencies.

```bash
git clone <repo> && cd ev-charge-map-au

# Rebuild everything from the cached data that ships with the repo (no network):
node bin/evmap.js ingest --offline
node bin/evmap.js build
node test/run.js

# Or fetch fresh data from all six sources:
node bin/evmap.js ingest

# Serve the map and API:
node bin/evmap.js serve
# -> http://127.0.0.1:8787
```

`npm run all` does the offline ingest, build and test in one step.

## The data sources

Six sources, all openly licensed, none requiring an API key:

| Source | Coverage | Records | Licence |
|---|---|---|---|
| OpenStreetMap (Overpass) | National | 1,590 | ODbL 1.0 (share-alike) |
| Transport for NSW | NSW | 1,958 | CC-BY 3.0 AU |
| Victoria DEECA | VIC (govt-funded only) | 152 | CC-BY 4.0 |
| QLD Transport and Main Roads | QLD (Super Highway only) | 17 | CC-BY 4.0 |
| ACT Government (Climate Choices) | ACT (govt-funded only) | 34 | CC-BY 4.0 |
| Tasmania NRE (ChargeSmart grants) | TAS (grants, **town-level**) | 55 | CC-BY 4.0 |

Open Charge Map is supported but **off by default** — it needs a free API key,
and only its `opendata=true` subset is safely redistributable.

**SA, WA and NT publish no usable charger data.** Mappable coverage there comes
entirely from OpenStreetMap. There is no national charger dataset and no
Australian charger-information data standard.

**Tasmania is a special case.** It publishes its ChargeSmart grant recipients as
HTML tables, but located only to *town* — no street address. Those 55 records
are ingested and searchable, but marked `geocoded_locality` and **excluded from
the default map view**: a town centroid is roughly 5 km from wherever the
charger actually is. See [Positional precision](#positional-precision).

> ⚠️ **The ACT source is a lesson worth reading.** An earlier survey recorded
> the ACT as having no data, because it searched the ACT's open-data portal.
> The ACT publishes its charger list as HTML tables on a *policy page* instead.
> Government data is not always in the data portal — see
> [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md#act-government--climate-choices).

Full catalogue, licence terms and dead ends: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Positional precision

Not every coordinate means the same thing, and pretending otherwise produces a
map that lies. Each record declares how its position was obtained:

| Precision | Nominal error | Sources | Shown by default? |
|---|---|---|---|
| `surveyed` — publisher supplied coordinates | ~10 m | OSM, NSW, VIC, QLD | ✅ |
| `geocoded_address` — from a street address | ~100 m | ACT | ✅ |
| `geocoded_locality` — from a **town name** | **~5 km** | TAS | ❌ opt in |

Town-level records are **excluded from the default map, never merged with any
other record, never returned as "nearest", and confidence-penalised**. They stay
fully searchable, because "is there a funded charger in Miena?" is a real
question no other open source answers for Tasmania:

```bash
$ evmap search "Miena"
0 match(es)

$ evmap search "Miena" --include-approximate
2 match(es); showing 2 (sort: relevance)

Central Highlands Tasmania — Miena
  Central Highlands Tasmania · power unknown · DCUnspecified · TAS
  id=au-s419916-1467076-central-highla sources=tas confidence=0.237 STATUS=UNKNOWN  [TOWN-LEVEL POSITION]
```

The map renders them as dashed hollow rings behind a checkbox, and the detail
panel opens with *"This is not a charger location."*

## Licence of the output

⚠️ **The dataset this produces is ODbL, not permissive.**

Because the pipeline ingests OpenStreetMap into its own store, the result is an
ODbL **"Derivative Database"**, not merely a "Produced Work" — so share-alike
applies to the database as a whole, and you must offer it back under ODbL on
request. That obligation is implemented, not just documented:

```bash
node bin/evmap.js export --format odbl --out compliance/
# or: GET /api/export/odbl
```

The code itself is MIT. See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md#odbl-obligations).

## Keeping it up to date

The interesting half of the problem. Three mechanisms:

**1. Freshness is a per-field property, not a per-record one.** A built charger's
coordinates never change; its operational status changes constantly. One global
TTL is therefore wrong in both directions. Each field carries its own budget:

| Field | Budget | Why |
|---|---|---|
| `lat` / `lng` | 3,650 days | A built charger does not move |
| `status` | 30 days | Sites open and close; the most volatile field carried |
| `fee` | 30 days | Volatile, and rarely published at all |
| `operator` | 180 days | Networks get acquired |
| `connectors` | 180 days | Hardware gets upgraded |

The API exposes computed per-field staleness on `GET /api/sites/<id>`.

**2. Source-drift detection, for CI.** The most common way an aggregation
pipeline rots is silently: the fetch keeps returning HTTP 200 while the content
becomes useless. `evmap drift` re-ingests, compares against the last run, and
exits with a distinct code:

```
$ node bin/evmap.js drift --offline
[  ok  ] osm   1590 records, 0.0% parse-failure rate
[  ok  ] nsw   1958 records, 0.0% parse-failure rate
[  ok  ] vic   152 records, 0.0% parse-failure rate
[  ok  ] qld   17 records, 0.0% parse-failure rate

Overall: OK
```

It fails on a source returning zero records, on a >35% record-count swing, and
on a rising *parse-failure* rate. It deliberately ignores permanent upstream
data gaps — QLD's plug-count column is empty on all 17 rows, which is a fact
about the dataset, not drift, and alerting on it every run would train you to
ignore the alert.

**3. Geocoding is cached permanently, never repeated.** The ACT publishes
addresses rather than coordinates, so those records are geocoded through
Nominatim — chosen because it is OpenStreetMap-derived and therefore ODbL, the
licence this dataset already carries (a commercial geocoder would forbid storing
the result). The 35 lookups happen once, are committed to `data/raw/`, and are
never re-requested; offline rebuilds never touch the network. Geocoded
coordinates rank **last** for `lat`/`lng`, so they can never override a
surveyed OpenStreetMap position.

**4. Cached raw data with checksums.** Every fetch records a sha256, byte count
and timestamp in `data/cache/manifest.json`, and validation runs *before* the
cache is written so an HTML error page can never overwrite good data. The whole
dataset rebuilds offline from the shipped cache, and the test suite verifies the
on-disk checksums still match.

Recommended cadence: **daily** for OpenStreetMap, **weekly** for the government
datasets. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#freshness) for the
scheduling and hosting options.

## Why reconciliation is the hard part

NSW alone (1,958 rows) has more records than all-of-Australia OpenStreetMap
(1,590). Neither is a superset. Concatenating sources produces doubled pins;
naive coordinate rounding merges genuinely distinct chargers in the same
shopping-centre car park. The real data contains:

- 73% of TfNSW rows have **no station name at all**, and 94% have no usable key.
- `Charger_rating` mixes real ratings (`"22 kW"`), current types (`"AC"`, 522
  rows), and multi-bank strings (`"2x350kW & 2x175kW"`).
- The same operator appears as `"BP"` and `"BP Australia"`; `"Tesla"` and
  `"Tesla Motors"`.
- 98 TfNSW rows are **unbuilt** chargers, flagged only via `Charger_Type=Upcoming`.
- Tasmania publishes **no coordinates and no street addresses at all** — only a
  town name, which is an inventory, not a position.
- The ACT names **venues** ("Eastlake Football Club") while OpenStreetMap often
  names the **network** ("Exploren"). Comparing across those vocabularies scores
  near zero, which once rejected two records sitting 0 metres apart.

So the pipeline does spatial bucketing → weighted pair scoring → single-link
clustering → field-level merge by per-field source trust, retaining provenance
and conflicts. Every value on the map can be traced to the source that supplied
it, and disagreements are surfaced in the UI rather than hidden.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the matching algorithm and
the trust model.

## Commands

```
evmap ingest      Fetch all sources, resolve, write data/cache/dataset.json
evmap build       Generate the self-contained offline web map into web/
evmap serve       Start the read-only HTTP API + web map
evmap stats       Coverage statistics for the current dataset
evmap search      Search from the command line
evmap sources     List sources with licence, cadence and caveats
evmap drift       Re-ingest and compare against the last report (for CI)
evmap export      Write out CSV, GeoJSON, JSON or the ODbL bundle
```

Examples:

```bash
evmap search chargefox --state VIC --min-kw 150
evmap search --near "-33.8688,151.2093" --radius-km 3 --connector CCS2
evmap export --format geojson --out chargers.geojson
evmap stats --json
```

Exit codes: `0` ok · `1` drift warnings · `2` drift failures or source error ·
`3` usage error · `4` runtime error.

## Documentation

| Document | Contents |
|---|---|
| [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) | Every source, its licence, its caveats, and the dead ends |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Identity resolution, trust model, freshness, hosting |
| [docs/API.md](docs/API.md) | Endpoints, parameters, response schemas, error codes |
| [docs/BUILDING.md](docs/BUILDING.md) | Build, test, extend, add a source |
| [docs/RECREATING.md](docs/RECREATING.md) | Reproduce every artefact from scratch |

## Repository layout

```
bin/evmap.js          CLI entry point
src/core/             Shared engine — also inlined into the browser bundle
  csv.js              RFC-4180 reader/writer
  geo.js              Distance, bboxes, spatial bucketing, state inference
  normalise.js        Field cleaning: operators, power, connectors, dates
  resolve.js          Identity resolution + provenance-tracked merge
  search.js           THE query engine (CLI + API + web all call this)
src/sources/          One adapter per dataset, each declaring its own licence
src/fetch.js          Network, cache, checksums, offline mode, secret redaction
src/pipeline.js       Ingest orchestration, freshness budgets, drift detection
src/server.js         Read-only HTTP API (node:http only)
src/export.js         CSV / GeoJSON / JSON / ODbL compliance bundle
build/                Web build: bundles core into a single self-contained page
data/raw/             Cached upstream responses (shipped, checksummed)
data/cache/           Built dataset, ingest report, fetch manifest
test/                 210 tests, offline, incl. cross-surface equivalence
web/                  Generated output + vendored Leaflet
```

## Testing

```bash
$ node test/run.js
210/210 passed
```

Runs entirely offline against the shipped cache. Beyond unit coverage it
asserts the things that are easy to claim and easy to break:

- **Cross-surface equivalence** — eight queries run through core, through the
  real HTTP server, and through the browser bundle in a VM context; the result
  id lists must be identical. It also fails if the page ever starts filtering
  sites itself instead of calling the shared engine.
- **Adapters run against the real cached upstream files**, not fixtures.
  Synthetic fixtures would have passed happily while the Victorian status
  heuristic mislabelled 96 live sites as unbuilt.
- **Byte-identical exports** between the CLI module and the HTTP endpoint.

Tests marked `REGRESSION` encode defects actually found while building against
live data — see [docs/BUILDING.md](docs/BUILDING.md#bugs-this-suite-exists-to-prevent).

## Licence

Code: MIT. Data: ODbL 1.0 (inherited from OpenStreetMap) — see above.
