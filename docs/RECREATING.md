# Recreating every artefact from scratch

How to reproduce this repository's outputs, verify the shipped cache, and
rebuild with no network access at all.

## What ships in the repo

| Path | Reproducible? | How |
|---|---|---|
| `data/raw/*` | Yes, from the network | `evmap ingest` |
| `data/raw/geocode-cache.json` | Yes, from the network (once) | `evmap ingest` — then never re-queried |
| `data/cache/manifest.json` | Yes | written by every ingest |
| `data/cache/dataset.json` | **Yes, offline** | `evmap ingest --offline` |
| `data/cache/ingest-report.json` | **Yes, offline** | same command |
| `web/index.html` | **Yes, offline** | `evmap build` |
| `web/sites.json` | **Yes, offline** | same command |
| `web/vendor/leaflet.*` | Yes, from the network | see below |

The upstream responses are committed on purpose, so a recipient can rebuild and
run the full test suite **without network access** and without depending on
government portals still being up.

## Full offline rebuild

Requires only Node 18+.

```bash
cd ev-charge-map-au

node bin/evmap.js ingest --offline    # dataset from data/raw, no network
node bin/evmap.js build               # web/index.html from the dataset
node test/run.js                      # 285/285 must pass
```

Or in one step:

```bash
npm run all
```

Expected result:

```
3806 source records -> 3157 canonical sites (649 merged, 389 corroborated by 2+ sources)
...
285/285 passed
```

If the counts differ, the cache in `data/raw` has changed — see verification
below.

## Verifying the shipped cache

Every cached file has a recorded sha256. The test suite checks them, and you can
check by hand:

```bash
node -e '
const fs=require("fs"), crypto=require("crypto"), path=require("path");
const m=JSON.parse(fs.readFileSync("data/cache/manifest.json","utf8"));
let bad=0;
for (const [key, entry] of Object.entries(m.entries)) {
  const file=path.join("data/raw", key);
  if (!fs.existsSync(file)) { console.log("MISSING", key); bad++; continue; }
  const actual=crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const ok = actual === entry.sha256;
  if (!ok) bad++;
  console.log(ok?"ok  ":"BAD ", key, entry.bytes+"b", entry.fetchedAt);
}
process.exit(bad?1:0);'
```

Real output:

```
ok   osm-au-chargers.json 563153b 2026-09-05T08:02:41.187Z
ok   nsw-package.json 7413b 2026-09-05T07:57:18.618Z
ok   nsw-ev.csv 283030b 2026-09-05T07:57:20.154Z
ok   vic-dcav.json 108744b 2026-09-05T08:01:22.694Z
ok   qld-ev.csv 3798b 2026-09-05T07:57:21.518Z
```

The equivalent assertion lives in `test/pipeline.test.js` ("manifest checksums
match the files actually on disk").

## Refreshing from upstream

```bash
node bin/evmap.js ingest
```

Six HTTP requests (seven including NSW's CKAN metadata call), about 30 seconds.
The 77 geocode lookups (35 ACT addresses + 42 Tasmanian towns) only happen on
the very first run — after that the committed cache serves them and no geocoding
requests are made.
Each fetch reports whether the content changed:

```
  ✓ osm-au-chargers.json: 563153 bytes, sha256 51b2493fad10 (CHANGED)
  ✓ nsw-ev.csv: 283030 bytes, sha256 42397310a411 (unchanged)
```

Then rebuild the page and re-run the tests:

```bash
node bin/evmap.js build && node test/run.js
```

### After a refresh, check drift first

```bash
node bin/evmap.js drift
```

```
[  ok  ] osm   1590 records, 0.0% parse-failure rate
[  ok  ] nsw   1958 records, 0.0% parse-failure rate
[  ok  ] vic   152 records, 0.0% parse-failure rate
[  ok  ] qld   17 records, 0.0% parse-failure rate

Overall: OK
```

`drift` deliberately **does not update the saved baseline when it fails**, so a
broken upstream run cannot silently become the new normal. Exit codes: `0` ok,
`1` warnings, `2` failures.

## Recreating the raw fetches by hand

Useful for debugging an adapter, or verifying independently that a source
returns what the adapter claims.

### OpenStreetMap (Overpass)

```bash
curl -s -X POST "https://overpass-api.de/api/interpreter" \
  --data-urlencode 'data=[out:json][timeout:280];
area["ISO3166-1"="AU"][admin_level=2]->.a;
(
  node["amenity"="charging_station"](area.a);
  way["amenity"="charging_station"](area.a);
);
out center tags;' \
  -o data/raw/osm-au-chargers.json
```

Count elements:

```bash
node -e 'console.log(JSON.parse(require("fs").readFileSync("data/raw/osm-au-chargers.json","utf8")).elements.length)'
# 1590
```

`out center` is required — 35 sites are mapped as ways and have no coordinate
without it.

### Transport for NSW (two-stage)

Never hardcode the CSV URL; the filename is date-stamped and changes on
republication.

```bash
# 1. Resolve the current CSV resource
curl -s "https://opendata.transport.nsw.gov.au/data/api/3/action/package_show?id=be1c4de4-4517-4bd0-8a09-2965ddfc7179" \
  -o data/raw/nsw-package.json

# 2. Pick the newest CSV that is not marked "Not updated"
node -e '
const pkg=require("./data/raw/nsw-package.json");
const r=pkg.result.resources
  .filter(x=>String(x.format).toUpperCase()==="CSV" && !/not updated/i.test(x.name||""))
  .sort((a,b)=>String(b.last_modified||b.created).localeCompare(String(a.last_modified||a.created)));
console.log(r[0].url);'

# 3. Fetch it
curl -sL "<url from step 2>" -o data/raw/nsw-ev.csv
```

### Victoria (WFS)

```bash
curl -s "https://opendata.maps.vic.gov.au/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=open-data-platform:dcav_site&outputFormat=application/json" \
  -o data/raw/vic-dcav.json

node -e 'console.log(JSON.parse(require("fs").readFileSync("data/raw/vic-dcav.json","utf8")).features.length)'
# 152
```

The workspace prefix must be `open-data-platform:` — `datavic:dcav_site`
returns HTTP 400.

### Queensland (requires a browser User-Agent)

```bash
curl -sL \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" \
  -H "Accept: text/csv,*/*" \
  "https://www.tmr.qld.gov.au/-/media/aboutus/corpinfo/Open%20data/findachargingev/csl_ev.csv" \
  -o data/raw/qld-ev.csv
```

Without the User-Agent you get HTTP 403 and an HTML page. Verify the real record
count (17, not the 34 that `wc -l` reports):

```bash
node -e 'const c=require("./src/core/csv");console.log(c.parse(require("fs").readFileSync("./data/raw/qld-ev.csv","utf8")).length)'
# 17
```

### ACT (HTML page)

```bash
curl -sL \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" \
  "https://www.climatechoices.act.gov.au/transport-and-travel/zero-emissions-vehicles/public-ev-chargers-in-the-act" \
  -o data/raw/act-chargers.html
```

Verify the parse reconciles with the totals the page states about itself — this
is the check that makes an HTML scrape trustworthy:

```bash
node -e '
const act=require("./src/sources/act");
const raw=require("fs").readFileSync("data/raw/act-chargers.html","utf8");
console.log("stated:", JSON.stringify(act.statedTotals(raw)));
console.log("validate:", act.requests()[0].validate(raw) || "PASS");'
# stated: {"asOf":"December 2025","chargers":74,"bays":131}
# validate: PASS
```

### Tasmania (HTML page — use the canonical URL)

```bash
curl -sL \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" \
  "https://nre.tas.gov.au/environment/climate-change/climate-change-grant-programs/electric-vehicle-chargesmart-grants" \
  -o data/raw/tas-chargesmart.html
```

**Do not use `recfit.tas.gov.au/grants_programs/climate-change/chargesmart_grants`** —
it redirects, and the redirect path is behind Cloudflare, returning HTTP 403 to
any non-browser client.

Verify the parse reconciles against each table's stated grant total:

```bash
node -e '
const tas=require("./src/sources/tas");
const raw=require("fs").readFileSync("data/raw/tas-chargesmart.html","utf8");
tas.findLocationTables(raw).forEach(t=>{
  const sum=t.rows.reduce((a,r)=>a+(tas.parseMoney(r[r.length-1])||0),0);
  console.log(t.heading.slice(0,40).padEnd(42), "parsed $"+sum, "stated $"+t.statedTotal, sum===t.statedTotal?"OK":"MISMATCH");
});
console.log("validate:", tas.requests()[0].validate(raw) || "PASS");'
# Chargesmart 3 2025 - Successful grant re  parsed $567000 stated $567000 OK
# Fast charging - successful grant applica  parsed $710500 stated $710500 OK
# Destination charging - successful grant   parsed $62500 stated $62500 OK
# validate: PASS
```

### Verifying the geocode cache

```bash
node -e 'console.log(JSON.stringify(require("./src/geocode").cacheStats()))'
# {"total":77,"resolved":76,"unresolved":1}
```

77 entries: 35 ACT street addresses (34 resolved) and 42 Tasmanian town names
(all 42 resolved).

The single unresolved address is "ANU School of Art & Design Repertory Lane,
ANU Acton Campus" — it has no house number and no resolvable fallback. That
record is deliberately dropped rather than pinned to a campus centroid.

To re-geocode from scratch, delete `data/raw/geocode-cache.json` and run an
online ingest. It takes about 90 seconds (77 lookups, throttled to one request
per second per Nominatim's usage policy).

### Open Charge Map (optional, needs a key)

```bash
export OCM_API_KEY=your-key
curl -s "https://api.openchargemap.io/v3/poi?output=json&countrycode=AU&opendata=true&maxresults=10000&key=$OCM_API_KEY" \
  -o data/raw/ocm-au.json
```

`opendata=true` is mandatory. Without it the response mixes licences and is not
redistributable.

## Re-vendoring Leaflet

```bash
curl -sL -o web/vendor/leaflet.js  https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
curl -sL -o web/vendor/leaflet.css https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
```

Expected sizes: 147,552 and 14,806 bytes for 1.9.4. Committed deliberately so
the built page has no CDN dependency.

## Recreating the export artefacts

```bash
node bin/evmap.js export --format csv     --out dist/ev-chargers-au.csv
node bin/evmap.js export --format geojson --out dist/ev-chargers-au.geojson
node bin/evmap.js export --format json    --out dist/ev-chargers-au.json
node bin/evmap.js export --format odbl    --out dist/odbl-bundle.json
```

Verify the GeoJSON is complete (this is the export that used to truncate at
~146 KB when the CLI called `process.exit()` before stdout drained):

```bash
node -e 'const j=JSON.parse(require("fs").readFileSync("dist/ev-chargers-au.geojson","utf8"));console.log(j.features.length)'
# 3157   (3102 mappable + 55 town-level)
```

## Reproducibility guarantees

- **Deterministic.** Two ingests over the same cache produce identical site id
  lists — asserted by test. Sites are sorted by canonical id, so diffs between
  runs are meaningful.
- **Stable ids.** Derived from rounded geography plus operator, not from record
  order, so ids survive re-ingest and can be linked to externally.
- **Timestamps are the only variance.** `generatedAt` and `fetchedAt` change
  every run, so `dataset.json` is not byte-identical between runs even when the
  data is unchanged. Compare `counts` and site ids, not file hashes.

## Environment

Verified on:

```
$ node --version
v24.14.1
```

Minimum supported is Node 18 (needs global `fetch` and `AbortController`). No
platform-specific code; no shell dependencies beyond `curl` for the manual
fetches above.

## Troubleshooting

**`No dataset at data/cache/dataset.json`** — run `node bin/evmap.js ingest
--offline` first.

**`--offline requested but no cached file at data/raw/<x>`** — the cache is
incomplete. Run one online `ingest`, or restore the missing file. NSW needs
*both* `nsw-package.json` and `nsw-ev.csv` because of its two-stage fetch.

**QLD reports zero records** — almost certainly the User-Agent. The adapter's
`validate` hook should catch this and refuse to overwrite the cache; if you
fetched by hand, check whether the file is HTML.

**Victoria returns HTTP 400** — wrong workspace prefix. Use
`open-data-platform:dcav_site`.

**Overpass times out or returns 429** — it is a donated public service under
load. The adapter falls back to `overpass.kumi.systems`, then to your own
cache. **Do not retry in a tight loop**; repeated probing during development
earned a sustained 429 from the primary endpoint.

**Overpass returns 406 Not Acceptable** — send an explicit `Accept` header.
Observed 2026-09-05: the endpoint rejected our descriptive User-Agent when no
`Accept` was present, while the identical query succeeded from curl. The fetch
layer now always sends one; see `src/fetch.js`.

**"mirror database is N days stale — refusing a degraded mirror"** — working as
intended. The fallback mirror's OSM database was 43 days behind the primary's
and returned **HTTP 200 with 1,493 elements against the primary's 1,590** — a
silent 6% coverage loss with no truncation and no `remark`. The adapter now
checks `osm3s.timestamp_osm_base` and refuses anything older than 7 days,
preferring your own cache over fresh-but-worse data. If both endpoints are
unavailable, wait rather than lowering the threshold.

**Cached file checksum differs from the manifest** — someone edited
`data/raw` by hand. Offline mode warns and proceeds; re-fetch to get back to a
known state.

**A source's record count moved a lot** — that may be legitimate. Check
`data/cache/ingest-report.json` for the per-source `issueKinds` breakdown before
assuming breakage, and see
[ARCHITECTURE.md](ARCHITECTURE.md#drift-detection).
