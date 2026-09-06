# Architecture

How the pipeline turns six inconsistent open datasets into one map, and how it
stays current.

## The shape of the problem

Two problems get conflated in EV-charger projects, and they have completely
different engineering answers:

| | Static site inventory | Live availability |
|---|---|---|
| Question | Where are the chargers? | Is this plug free right now? |
| Change rate | Weekly-ish | Seconds |
| Correct source | Aggregated open datasets | OCPI roaming feed / operator API |
| Freshness model | Scheduled ingest, cached | Request-time fetch, never persisted |
| Available openly? | **Yes** | **No** |

This project implements the left column only, by design. Mixing them produces a
system that is either too slow for availability or too expensive for inventory.
If live status is added later, it belongs as a **request-time overlay that is
never written into the dataset** — because a cached "available" is worse than no
answer at all.

## Data flow

```
                  ┌─────────────────────────────────────────┐
                  │  src/sources/*.js   (one per dataset)   │
                  │  declares: licence, cadence, requests,  │
                  │            validate, normalise          │
                  └──────────────────┬──────────────────────┘
                                     │
        ┌────────────────────────────▼─────────────────────────────┐
        │  src/fetch.js                                            │
        │  • tries mirrors in order                                │
        │  • VALIDATES before writing cache                        │
        │  • sha256 + bytes + timestamp -> manifest.json           │
        │  • redacts secrets from anything persisted               │
        │  • --offline rebuilds from data/raw with no network      │
        └────────────────────────────┬─────────────────────────────┘
                                     │  raw text / parsed JSON
        ┌────────────────────────────▼─────────────────────────────┐
        │  source.normalise()  ->  common record shape + issues[]  │
        │  (operators folded, power parsed, status classified)     │
        └────────────────────────────┬─────────────────────────────┘
                                     │  3,806 records
        ┌────────────────────────────▼─────────────────────────────┐
        │  src/core/resolve.js                                     │
        │  spatial bucket -> pair score -> cluster -> merge        │
        │  with per-FIELD source trust + provenance + conflicts    │
        └────────────────────────────┬─────────────────────────────┘
                                     │  3,157 canonical sites
        ┌────────────────────────────▼─────────────────────────────┐
        │  data/cache/dataset.json   (the single artefact)         │
        └───┬───────────────────┬──────────────────┬───────────────┘
            │                   │                  │
      ┌─────▼─────┐      ┌──────▼──────┐    ┌──────▼──────────────┐
      │ bin/evmap │      │ src/server  │    │ build/build-web.js  │
      │   (CLI)   │      │  (HTTP API) │    │ single-file web map │
      └─────┬─────┘      └──────┬──────┘    └──────┬──────────────┘
            └───────────────────┴──────────────────┘
                                │
                    all three call src/core/search.js
```

## One source of truth

The three consumer surfaces do **not** reimplement querying. Each calls
`src/core/search.js`:

- **CLI** — `require('../src/core/search')`
- **HTTP API** — same module, with URL parameters mapped to the query object
- **Web page** — `build/build-web.js` reads `src/core/{geo,normalise,search}.js`
  off disk at build time and inlines them **verbatim** behind a six-line
  CommonJS shim

That last one is the interesting case, because "the web page uses the same
logic" is an easy thing to claim and an easy thing to quietly break. Three
tests defend it:

1. `test/equivalence.test.js` asserts each core module appears in the bundle
   verbatim (whitespace-normalised), so an edited copy fails.
2. Eight representative queries run through core, through the real HTTP server,
   and through the bundle evaluated in a `node:vm` context; the returned id
   lists must match exactly.
3. A guard test fails if `build/app.js` ever calls `SITES.filter(...)` directly
   instead of routing through the engine.

The web build is ~2.6 MB: 144 KiB vendored Leaflet, 32 KiB core bundle, and the
rest the inlined dataset. It works from `file://` with no server.

## Identity resolution

The hard part. Three sources describing the same physical charging site produce
records with different names, coordinates tens of metres apart, and inconsistent
connector counts. Neither over- nor under-merging is acceptable:

- **Under-merge** → doubled pins at the same location; inflated site counts.
- **Over-merge** → the Tesla Supercharger and the Chargefox unit in the same
  shopping-centre car park collapse into one wrong record.

### Step 1 — candidate generation

All-pairs comparison over 3,806 records is 7.2M comparisons. Instead, records
are bucketed into a ~250 m grid (`geo.cellKey`), and each record is compared
only against its own cell and the eight neighbours (`geo.neighbourKeys`), so
clusters straddling a boundary are still found. On the real dataset this reduces
the work to **2,974 pair comparisons**.

### Step 2 — pair scoring

`resolve.scorePair()` returns a score in [0,1] plus human-readable `reasons`,
so any merge decision can be audited.

| Signal | Weight | Rationale |
|---|---|---|
| Distance | up to +0.60, linear to 0 at 250 m | Primary signal; hard ceiling at 250 m |
| Operator agrees | +0.25 | Strong positive |
| Operator conflicts | **−0.30** | Strong negative — different networks are different sites |
| Name similarity ≥ 0.5 | up to +0.20 | Jaccard over meaningful tokens |
| Name similarity ≤ 0.12 | −0.15 | Actively contradictory |
| Postcode agrees | +0.05 | Weak corroboration |

Link threshold: **0.55**. Below 30 m with no active conflict the score floors at
0.80, because at that distance sparse fields should not block a merge.

Name similarity cannot be the primary signal: **73% of TfNSW rows have no name
at all.** Generic tokens (`ev`, `charger`, `station`, `carpark`) are stripped
before comparison so "EV Charging Station" and "EV Charger Site" don't look
similar merely for being generic.

### Step 3 — clustering

Single-link union-find with path compression over the linked pairs. Real result:
3,806 records → 3,157 clusters, **649 merged**, **389 sites corroborated by two
or more independent sources**. 55 of those clusters are town-level records that
are structurally barred from merging (below).

### Step 4 — merge with per-field trust

Sources are trusted **per field**, not overall, because their strengths differ:

| Field | Trust order | Why |
|---|---|---|
| `name` | osm → act → vic → nsw → qld | Surveyed on the ground; the ACT publishes real venue names; government name fields are mostly empty |
| `operator` | nsw → vic → qld → osm | Derived from funding/deployment records (the ACT publishes none) |
| `lat` / `lng` | osm → nsw → vic → qld → **act** → **tas** | Community-corrected against imagery; geocoded sources rank last, coarsest of all last |
| `connectors` | vic → act → nsw → osm → qld | Victoria and the ACT publish structured plug types |
| `plugCount` | act → vic → nsw → osm → qld | The ACT states bay counts explicitly |
| `status` | nsw → qld → vic → osm → **act** → **tas** | Only some sources publish build status; act and tas report funding, not delivery, so both are always `unknown` |
| `access` / `fee` | osm → act → nsw → vic → qld | NSW and VIC publish neither |

**Every enabled source must appear in every field order it can supply.**
`pickField` ranks an unlisted source last, so an omission silently demotes it.
That had actually happened to `vic` — it was missing from all of these lists and
therefore ranked last everywhere, despite publishing the best-structured
connector data of any source.

Every chosen value records its origin in `site.provenance[field]`, and rejected
alternatives are kept in `site.conflicts[field]` and shown in the UI. **341
sites have at least one field where sources disagree** — surfacing that is more
honest than silently picking one.

#### Coordinates: trusted source, not centroid

Averaging two coordinates that disagree by 80 m puts the pin in the middle of a
road — confidently wrong in a *third* location neither source claimed. The merge
takes the most-trusted source's coordinate verbatim and records
`spatialSpreadM`; the UI warns when it exceeds 60 m.

#### Names are not always comparable

Sources name different *kinds* of thing. The ACT names venues
("Eastlake Football Club"); OpenStreetMap elements with no `name` tag fall back
to the operator ("Evie Networks", "bp pulse", "Exploren"). Token similarity
across those two vocabularies is always near zero, so a naive matcher reads the
mismatch as evidence of two different sites.

Measured consequence: an ACT record and an OSM record sitting **0 metres apart**
scored 0.45 and were not merged, purely because "Next Gen Canberra" does not
resemble "Exploren". The fix is `describesVenue()` — a name is only compared
when it actually describes the place, not when it is an operator fallback or a
repeat of the operator field. Name comparison is skipped otherwise, and the
30-metre certainty floor is no longer blocked by an incomparable name.

This corrected 5 additional cross-source merges nationally, outside the ACT.

#### Positional precision is a graded, first-class property

A coordinate's meaning depends on how it was obtained, so every record declares
`positionPrecision`:

| Precision | Nominal error | Sources |
|---|---|---|
| `surveyed` | ~10 m | OSM, NSW, VIC, QLD |
| `geocoded_address` | ~100 m | ACT |
| `geocoded_locality` | **~5 km** | TAS |

The graded form matters because a boolean `geocoded` flag cannot express the
difference between "a street address, so within ~100 m" and "a town name, so
somewhere in these 20 km²". Conflating them would either exclude the ACT's
usable positions or admit Tasmania's unusable ones.

**A locality-precision record never merges with anything.** `scorePair()`
returns a hard zero when either side is town-level — even for identical
coordinates and identical names. The reason is specific: in a small town the
centroid very likely falls within the 250 m matching ceiling of a real charger,
and merging on that basis would attach a funding record to an unrelated site and
drag its identity along. There is no distance at which a town centroid is
evidence of identity.

It is also excluded from the default search results, barred from
`/api/nearest`, ranked last for `lat`/`lng`, and penalised 0.30 in confidence
(versus 0.10 for street-level geocoding).

#### Geocoded coordinates carry less information

A record whose coordinate was geocoded from a street address (currently only the
ACT) is marked `geocoded: true`, and the matcher treats it differently in two
ways:

1. It is ranked last for `lat`/`lng`, so a merged site keeps the surveyed
   position.
2. **Between two geocoded records, distance is not evidence.** The ACT lists
   "Mawson Club" (10 Heard St) and "Southlands Shopping Centre" (12 Heard St)
   as separate venues, and the geocoder resolved both to the *identical* point.
   A 0-metre separation there means "the geocoder could not tell these apart",
   not "same site". Two geocoded records therefore require name agreement to
   merge.

The net effect for the ACT is deliberate **under-merging**: of 34 ACT records,
24 are more than 250 m from any OSM charger (genuinely absent from OSM) and only
one merges. Geocoding error legitimately prevents confident matching for the
rest, and under-merging — a duplicate pin — is the safer failure than inventing
a merge.

#### Connectors: maximum asserted count

When sources disagree on plug counts, the higher figure wins. Under-reporting is
the common failure mode (a source that knows about 4 plugs is more likely
complete than one that knows about 2).

### Step 5 — stable IDs

IDs must survive re-ingest, so they cannot be array indices or hashes of the
whole record (which change whenever any field changes). They derive from
4-decimal rounded geography (~11 m) plus the canonical operator:

```
au-s352633-1411830-evie-networks
```

Both inputs are stable for a physical installation. Collisions are suffixed
(`-2`, `-3`) and counted in the ingest stats.

### Confidence

`site.confidence` in [0,1], deliberately explainable rather than learned:
corroboration (up to 0.6 for 3+ distinct sources) + completeness of the fields a
driver needs (0.25) + having connector data (0.15) − 0.05 per conflicting field.

## Freshness

**The core thesis: freshness is a property of a field, not of a record.**

A charger's coordinates never change once built. Its operational status changes
whenever a site opens or closes. Applying one TTL to both either wastes fetch
budget re-verifying coordinates or serves a stale status for a decommissioned
site. `pipeline.FIELD_FRESHNESS_BUDGET_DAYS`:

```
lat / lng      3650    a built charger does not move
address         730
name            365
website         365
operator        180    networks get acquired
network         180
connectors      180    hardware gets upgraded
plugCount       180
maxPowerKw      180
openingHours     90
status           30    the most volatile field carried
fee              30    volatile, and rarely published at all
```

`pipeline.fieldStaleness()` computes age against budget, and
`GET /api/sites/<id>` returns a `staleness` object per field, so a UI can label
a specific value as possibly outdated instead of stamping a whole record.

### Ingest cadence

Driven by each source's declared `recommendedRefresh`:

| Source | Upstream cadence | Refresh |
|---|---|---|
| OpenStreetMap | continuous | daily |
| Transport for NSW | months between republications | weekly |
| Victoria DEECA | monthly | weekly |
| QLD TMR | infrequent | weekly |
| Open Charge Map | continuous | daily |

A daily run costs four HTTP requests and about 25 seconds. There is no reason
to poll harder; the government sources change on a scale of months.

### Drift detection

The realistic failure mode is not a fetch error — it is a source that keeps
returning HTTP 200 while its content quietly becomes useless. `evmap drift`
re-ingests, compares against the previous report, and classifies each source:

| Condition | Level |
|---|---|
| Source errored | **fail** |
| Zero records returned | **fail** (always — never treated as a legitimate change) |
| Record count moved ≥35% | **fail** |
| Record count moved ≥10% | warn |
| Parse-failure rate ≥75% absolute | **fail** |
| Parse-failure rate rose ≥25 points | **fail** |
| Parse-failure rate rose ≥10 points | warn |
| Otherwise | ok |

Exit codes: `0` ok, `1` warn, `2` fail. A failing run **does not update the
saved baseline**, so a bad run cannot become the new normal.

#### Structural vs cosmetic issues

Getting this right required a design change during the build. Issues raised by
adapters are classified by `kind`:

| kind | Meaning | Counts toward drift? |
|---|---|---|
| `rejected` | Record unusable (bad coordinates) | **yes** |
| `parse_failure` | A field no longer parses | **yes** |
| `data_gap` | Upstream simply does not publish the field | no |
| `status_flag` | Site is planned/unbuilt — information, not error | no |
| `policy` | Deliberately skipped (licensing) | no |

Drift uses the **structural** rate only. The reason is concrete: all 17 QLD
records raise "plug count column empty", so its *raw* issue rate is 100% on
every single run. Against the raw rate, QLD failed the drift check every time —
a permanent false alarm that trains an operator to ignore the tool. TfNSW
similarly sits at a permanent ~32% raw rate because of its 522 `"AC"` ratings.
Both have a **0% structural rate**. The signal is now movement in parse
failures, which is what actually indicates a schema change.

### Change feed

`data/cache/ingest-report.json` records per-source counts, issue rates and
checksums per run. Because canonical IDs are stable, diffing the site id sets
between two runs yields appeared/disappeared sites — the basis for an
"N chargers added this week" feed. A disappearance should be treated as a
*suspicion*, not a fact: a site missing from one refresh is more often a
publisher hiccup than a decommissioning.

### Geocode caching

The ACT's addresses are geocoded once and the results committed to
`data/raw/geocode-cache.json`. This is not an optimisation — it is what keeps
three guarantees intact: offline rebuilds never need the network, a donated
public service is never re-queried, and the dataset stays reproducible. The
cache records the address, the query variants attempted, the timestamp, and the
result (including `null` for a genuine failure, which is distinct from an
address never queried).

### Cache integrity

Every fetch writes `{ url, fetchedAt, sha256, bytes, previousSha256, changed }`
to `data/cache/manifest.json`, with API keys stripped. Validation happens
**before** the write, so a 403 HTML page can never replace good cached data; if
all mirrors fail, the pipeline falls back to the existing cache and says so.
`--offline` rebuilds everything from `data/raw`, and the test suite verifies the
on-disk checksums still match the manifest.

## Handling planned sites

98 TfNSW rows and 11 Victorian rows describe chargers that **do not exist yet**.
Shipping them as live sites sends drivers to empty car parks.

They are kept in the dataset (they are genuinely useful — "coming soon") but
flagged `status: 'planned'`, and `search.js` excludes them unless
`includePlanned` is set. `search.nearest()` never returns them. The web UI shows
them only behind an explicit toggle, dashed-outline, with a "not yet built"
warning in the detail panel.

## Hosting

The output is a static artefact, so the cheapest deployment is genuinely cheap:

**Static-only** (recommended). Run `ingest` + `build` on a schedule in CI
(GitHub Actions cron), commit or upload `web/`, serve from any CDN or static
host. There is no server, no database, and no per-request cost. `web/index.html`
is fully self-contained, so it also works offline and from `file://`.

**With the API.** `evmap serve` is a single Node process holding the dataset in
memory (~5 MB). No database. Horizontal scaling is trivial because it is
read-only, and `/api/health` reports dataset age for a load-balancer check.

Suggested CI:

```yaml
- run: node bin/evmap.js drift        # exit 2 fails the build
- run: node bin/evmap.js build
- run: node test/run.js
```

Map tiles are the one recurring cost consideration. The build points at
`tile.openstreetmap.org`, which is fine for development and low traffic but is a
donated service with a usage policy — for production traffic, use a commercial
tile provider or self-host. When tiles are unreachable the page falls back to a
canvas scatter plot so search stays usable.

## Deliberate omissions

- **No clustering library.** At low zoom the map thins markers to one per grid
  cell, keeping the highest-powered site in each, using the same `geo.cellKey`
  as the resolver. Adequate at 3,000 points and keeps the zero-dependency rule.
- **No database.** 3,102 sites is 5 MB of JSON. A database would add operational
  burden and buy nothing until the dataset is orders of magnitude larger.
- **No write API.** User corrections should go **upstream to OpenStreetMap**,
  where they benefit everyone and flow back on the next ingest. A private
  correction store would fork from the sources and rot.
- **No geocoder.** Search matches suburb and postcode from the data itself.
  Adding one would introduce a licensing dependency for marginal gain.
