# Data sources

Every source, its licence, what it actually covers, and — just as usefully —
the sources that do not exist. All findings verified by live fetch on
**2026-09-05**; HTTP statuses are what was observed, not what was documented.

> ### Correction, and the method lesson behind it
>
> An earlier version of this document listed the **ACT as a dead end**. That was
> wrong. It was based on searching `data.act.gov.au` — a Socrata portal that
> returns only federated US Department of Energy data — and concluding no data
> existed. The ACT in fact publishes its full government-funded charger list as
> **HTML tables on a policy page**, which no portal search would ever surface.
>
> Re-checking the other four "dead ends" with that lesson in mind then found
> **Tasmania** publishing its ChargeSmart grant recipients the same way. That
> source is now ingested too, but only at town-level precision — see below.
>
> **The generalisable point: government open data is not always in the open-data
> portal.** Any survey that only queries portal APIs will under-report. Policy,
> programme and grant pages need checking too.

## Summary

| # | Source | Jurisdiction | Records | Licence | Key needed | Default |
|---|---|---|---|---|---|---|
| 1 | OpenStreetMap via Overpass | National | 1,590 | ODbL 1.0 | no | **on** |
| 2 | Transport for NSW | NSW | 1,958 | CC-BY 3.0 AU | no | **on** |
| 3 | Victoria DEECA (`dcav_site`) | VIC | 152 | CC-BY 4.0 | no | **on** |
| 4 | QLD Transport and Main Roads | QLD | 17 | CC-BY 4.0 | no | **on** |
| 5 | ACT Government (Climate Choices) | ACT | 34 | CC-BY 4.0 | no | **on** |
| 6 | Tasmania NRE (ChargeSmart grants) | TAS | 55 | CC-BY 4.0 | no | **on** ⚠️ town-level |
| 7 | Open Charge Map (`opendata=true`) | National | — | CC-BY 4.0 (subset) | **yes** | off |

Total ingested by default: **3,806 source records → 3,157 canonical sites**, of which
**3,102 are mappable** and **55 are town-level only** (excluded from the default
map view — see [Positional precision](#positional-precision)).

---

## 1. OpenStreetMap — Overpass API

The backbone: the only source with national coverage under a single licence.

- **Endpoint**: `POST https://overpass-api.de/api/interpreter`
  (mirror: `https://overpass.kumi.systems/api/interpreter`)
- **Query**: `amenity=charging_station` nodes and ways within the AU admin
  boundary, `out center tags` so polygon-mapped sites are not lost.
- **Observed**: HTTP 200, 1,555 nodes + 35 ways = **1,590 elements**.
- **Licence**: ODbL 1.0 — **share-alike, see below**.
- **Attribution**: `© OpenStreetMap contributors`, linked to
  `openstreetmap.org/copyright`.
- **Cadence**: continuous (community edits). Refresh **daily**.

Tag completeness across the 1,590 elements:

| Tag | Count |
|---|---|
| `operator` | 1,293 |
| `capacity` | 943 |
| `socket:type2_combo` (CCS2) | 785 |
| `fee` | 481 |
| `socket:chademo` | 429 |
| `access` | 408 |
| `name` | 324 |
| `opening_hours` | 263 |

**Strengths**: covers all eight jurisdictions; updated by people physically at
the site, so names, access and opening hours are better than government data.
**Weaknesses**: only 27–42% of the estimated national site count; tag coverage
is uneven; no status field for chargers (lifecycle prefixes are used instead).

### `out center` matters

35 sites are mapped as ways (car-park polygons) rather than nodes. A query
using plain `out` returns no coordinate for those, silently dropping them.

---

## 2. Transport for NSW — EV Charging Locations

The richest single dataset in the country, and the dirtiest.

- **Dataset**: `https://opendata.transport.nsw.gov.au/data/dataset/electric-vehicle-charging-stations-nsw`
- **Discovery**: CKAN `package_show?id=be1c4de4-4517-4bd0-8a09-2965ddfc7179`
- **Observed**: HTTP 200, **1,958 rows**. Dataset modified 2026-07-14; CSV
  resource last modified 2026-04-20.
- **Licence**: CC-BY 3.0 AU (portal states "Creative Commons Attribution").
- **Attribution**: `© State of New South Wales (Transport for NSW)`
- **Cadence**: periodic; months between republications. Refresh **weekly**.

### The filename changes — do not hardcode it

The CSV is served under a date-stamped filename (`ev_20251216.csv`). When TfNSW
republishes, that URL changes and a hardcoded fetch 404s. The adapter therefore
does a **two-stage fetch**: read the CKAN package metadata, pick the most
recently modified CSV resource, then fetch it. It also skips resources whose
name contains "Not updated" — the dataset carries two such historical files
that would otherwise win on sort order.

### Documented data quality

Every one of these is measured, and each drives a rule in `src/sources/nsw.js`:

| Issue | Extent | Handling |
|---|---|---|
| Unbuilt chargers marked `Charger_Type=Upcoming` | **98 rows** | `status: 'planned'`, excluded from the default map view |
| Empty `Station_name` | 1,438 / 1,958 (**73%**) | Display name derived from operator + suburb |
| Empty `OBJECTID` | 1,837 (**94%**) | Stable id synthesised by FNV-1a hash of identifying content |
| `Charger_rating` is a current type, not a rating (`"AC"`) | **522 rows** | Recorded as "no rating"; power stays `null`, never guessed |
| Multi-bank ratings (`"2x350kW & 2x175kW"`) | 85 rows | Parsed into plug groups |
| Operator aliasing (`"BP"` / `"BP Australia"`) | 32 / 28 | Folded to `BP Pulse` |
| Operator aliasing (`"Tesla"` / `"Tesla Motors"`) | 260 / 27 | Folded to `Tesla` |
| Empty street segment (`", Muswellbrook, 2333"`) | many | Locality filed as suburb, not street |
| Exact duplicate coordinates | 35 rows | Merged by the resolver |
| UTF-8 BOM on the header row | always | Stripped by the CSV reader |

No fee and no access field is published, so both stay `null`/`unknown`. **An
absent fee must never render as "free".**

---

## 3. Victoria — DEECA Government Funded Public EV Chargers

- **Dataset**: `https://discover.data.vic.gov.au/dataset/government-funded-public-ev-chargers`
- **Endpoint**: WFS `GetFeature` with `outputFormat=application/json` on
  `https://opendata.maps.vic.gov.au/geoserver/wfs`
- **Layer**: `open-data-platform:dcav_site`
- **Observed**: HTTP 200, **152 features**.
- **Licence**: CC-BY 4.0
- **Attribution**: `© State of Victoria (Department of Energy, Environment and Climate Action)`
- **Cadence**: monthly (updated 2026-06-13). Refresh **weekly**.

### Two traps

**Wrong workspace prefix.** `datavic:dcav_site` returns HTTP 400
`InvalidParameterValue`. The working prefix is `open-data-platform:`.

**Near-miss layers.** `nv1750_evcbcs` and `nv2005_evcbcs` match a naive search
for "evc" but are **Ecological Vegetation Class** datasets — vegetation
mapping, nothing to do with EV charging.

### Better quality than NSW

Victoria publishes structured plug types and power:

```
plug_type: "1 x CCS2, 1 x CHAdeMO"     (74 rows)
plug_type: "1 x CHAdeMO and 1 x CCS2/SAE" (18 rows)
chargers:  "3 x 22kW Charger"
```

Both `,` and `and` are used as separators, sometimes together. `CCS2/SAE` is
one CCS2 plug named with its SAE synonym, **not two connectors**.

### The `estimated_project_completion` trap

96 of 152 rows carry a value in this field, and the obvious reading — "populated
means not yet built" — is **wrong**. Most values are past dates describing
*completed* projects (`"31/07/2023"` ×22, `"10/10/2022"`, `"30 November 2023"`).
Treating any populated value as planned mislabelled 96 live sites as unbuilt.

The adapter parses the date and compares it to today, which reduces the count to
the **11** genuinely future-dated sites. Dates are **day-first** Australian
format, so `Date.parse()` cannot be used — `"31/07/2023"` is 31 July, and the
formats mix `DD/MM/YYYY`, `"December 2026"` and `"30 November 2023"`.

### Coverage caveat

Government-funded chargers only. Commercial networks that built in Victoria
without state funding are absent. **Never present this as a complete Victorian
inventory.**

The dataset includes a `plugshare_link` column. PlugShare is proprietary, so
that link is retained only as an outbound reference the publisher themselves
provided — never ingested as data.

---

## 4. Queensland — Transport and Main Roads

- **Dataset**: `https://data.gov.au/data/dataset/find-a-charging-station-electric-vehicle`
- **CSV**: `https://www.tmr.qld.gov.au/-/media/aboutus/corpinfo/Open%20data/findachargingev/csl_ev.csv`
- **Observed**: HTTP 200 → **17 records**.
- **Licence**: CC-BY 4.0
- **Attribution**: `© State of Queensland (Department of Transport and Main Roads)`

### Requires a browser User-Agent

With a default `curl`/Node user agent the endpoint returns **HTTP 403** with an
HTML error page. A naive pipeline parses that as a zero-row CSV and reports
"QLD dataset shrank to 0". Two defences:

1. The adapter sets a browser `User-Agent`.
2. A `validate` hook rejects HTML and any CSV lacking a `Latitude` column
   **before** the cache is written, so an error page cannot overwrite good data.

### 17 records, not 33

`wc -l` reports 34 lines, but the file has newlines inside quoted fields
(`"Toowoomba: 55km West, \nBrisbane: 92km East"`). The real record count is 17.
Any line-splitting CSV parser gets this wrong.

### Coverage caveat

Queensland Electric Super Highway sites only. Not a census of QLD charging.
The `Charging plugs available` column is **empty on every row**, so plug counts
stay `null` — recorded as a `data_gap` issue rather than treated as zero.

---

## 5. ACT Government — Climate Choices

The source that was originally, wrongly, recorded as absent.

- **Page**: `https://www.climatechoices.act.gov.au/transport-and-travel/zero-emissions-vehicles/public-ev-chargers-in-the-act`
- **Observed**: HTTP 200, 159,033 bytes. **74 chargers / 131 bays across 35 rows.**
- **Licence**: **CC-BY 4.0.** The ACT site's copyright page states its material
  is "available under a Creative Commons Attribution 4.0 licence, with the
  exception of any images, photographs, video recordings, sound recordings or
  branding, including the ACT Coat of Arms, the ACT Government logo and any
  other government logos or symbols".
- **Attribution**: `© Australian Capital Territory`
- **Cadence**: infrequent — edited as grants are delivered. Refresh **weekly**.

### Structure: HTML tables, not a dataset

Seven district accordions — Belconnen, Gungahlin, Inner North,
Inner South / East Canberra, Molonglo/Weston Creek, Woden Valley, Tuggeranong —
each holding one table:

| Number of chargers | Number of charging bays | Charger type | Plug type | Location |
|---|---|---|---|---|
| 2 | 4 | 22kW AC | Bring your own Type 1 or Type 2 | Sentinel Apartments 39 Benjamin Way, Belconnen |
| 1 | 2 | 150kW DC | CCS2 and CHAdeMO | Jamison Plaza Jamison Centre, Macquarie |

District names live in accordion `<button>` labels rather than headings, so the
adapter pairs each table with its district by document order.

### The parse validates itself

The page states its own totals: *"As of December 2025, 74 public EV chargers
with 131 charging bays have received ACT Government funding."* The adapter sums
its parsed rows and refuses the response unless they reconcile exactly.

That is what makes an HTML scrape trustworthy. A restructured page fails loudly
instead of silently yielding fewer rows, and an edit that changes a number
without changing the structure is caught too. Two tests tamper with the page in
both directions to prove it.

### No coordinates — this source needs geocoding

The ACT publishes addresses only. Every other source supplies lat/lng, so this
is the one source that requires a geocoding step. See
[Geocoding](#geocoding-act-only) below.

### Status is `unknown` by design

The tables list chargers that *"have received ACT Government funding"* — funding
is not delivery. Each district also carries a sentence like *"26 new
government-supported charging bays are on the way"*, and those figures do **not**
reconcile with the table rows:

| District | Table bays | "On the way" |
|---|---|---|
| Belconnen | 15 | 26 |
| Gungahlin | 16 | 4 |
| Inner North | 52 | 28 |
| Inner South / East Canberra | 20 | 24 |
| Molonglo/Weston Creek | 4 | 10 |
| Woden Valley | 16 | 10 |
| Tuggeranong | 8 | 16 |
| **Total** | **131** | **118** |

No consistent relationship, so the sentence cannot be used to classify rows.
Victoria's near-identical ambiguity mislabelled 96 live sites when guessed at,
so nothing is guessed here: **every ACT record is `status: 'unknown'`**, and
OpenStreetMap corroboration is allowed to upgrade it. Because the resolver
trusts `osm` above `act` for `status`, a site OSM confirms as operational is
reported as operational.

### Other honest limits

- **No operator per row.** The page's grants table names the recipients
  (ActewAGL, BP Pulse, ENGIE, Evie Networks, EVX, NRMA, SolarHub) but does not
  map them to sites. Inferring one would be fabrication, so `operator` is null.
- **Coverage caveat**: government-funded chargers only. The page states 300+
  public bays exist territory-wide, so 131 bays is roughly **44%** of ACT public
  charging.
- The page itself directs users to **PlugShare** for the full picture — a
  publisher acknowledging there is no complete official dataset.

---

## Geocoding

- **Service**: Nominatim, `https://nominatim.openstreetmap.org/search`
- **Results**: **34 of 35** ACT street addresses, and **42 of 42** Tasmanian
  town names, resolved. 77 cached entries total.
- **Cache**: `data/raw/geocode-cache.json`, committed to the repository.

Two sources need it, for different reasons and with different outcomes: the ACT
publishes street addresses (usable positions), Tasmania publishes town names
(inventory only). The geocoder is the same; what differs is the
`positionPrecision` each adapter asserts about the result.

### Why Nominatim and not a commercial geocoder

Nominatim is OpenStreetMap-derived, so its output carries **ODbL** — exactly the
licence this dataset already inherits from OSM. Adding it changes nothing about
what may be redistributed. A commercial geocoder would: Google's and Mapbox's
terms restrict storing geocodes and displaying them on a non-native basemap,
which is incompatible with publishing an open dataset. **The licence, not the
accuracy, is the deciding factor.**

Nominatim's usage policy is respected in code: one request per second maximum,
an identifying User-Agent, and results cached permanently so the ~35 lookups
happen once and never again. Offline rebuilds never touch the network.

### Geocoded coordinates are second-class, deliberately

A geocoded street address lands anywhere from a few metres to ~100 m from the
actual charging bay; a geocoded *town name* is kilometres out. See
[Positional precision](#positional-precision) for the full model. Two
consequences for street-level geocoding, both implemented:

1. `act` is ranked **last** for `lat`/`lng` in the per-field trust order, so a
   geocoded coordinate can never override a surveyed OSM position. On a merged
   ACT+OSM site the pin comes from OSM.
2. Every geocoded record carries `geocoded: true`, and the matcher treats two
   geocoded records as positionally uninformative relative to each other (see
   below).

### Two matcher bugs this source exposed

Both were real, both measured, both now regression-tested.

**A 0-metre pair was being rejected.** The ACT names *venues*
("Next Gen Canberra"); OSM elements without a `name` tag fall back to the
*operator* ("Exploren"). Those vocabularies never resemble each other, so the
name-conflict penalty fired on a pair sitting 0 m apart and blocked the merge.
Fixed by tracking whether a name is an operator fallback and skipping name
comparison when the two names describe different kinds of thing. This also
recovered 5 additional corroborated sites nationally, outside the ACT.

**Two distinct venues shared one coordinate.** The ACT lists "Mawson Club"
(10 Heard St) and "Southlands Shopping Centre" (12 Heard St) separately, and
Nominatim resolved both to the *identical* point. Between two geocoded records,
distance therefore carries no information — 0 m may mean "same site" or merely
"the geocoder could not tell these apart". Two geocoded records now require name
agreement to merge, which keeps them correctly separate.

### The one failure, left as a failure

"ANU School of Art & Design Repertory Lane, ANU Acton Campus" has no house
number, and the fallback variants ("ANU Acton Campus") do not resolve. The only
available fix would be a campus- or suburb-level centroid several hundred metres
from the actual charger. That record is therefore **dropped and reported**, not
placed at a guessed location — consistent with the rule that a wrong pin is
worse than a missing one.

---

## Positional precision

Not all coordinates are equal, and treating them as equal produces a map that
lies about where chargers are. Every record carries a `positionPrecision`:

| Precision | Meaning | Nominal error | Sources | On the map by default? |
|---|---|---|---|---|
| `surveyed` | The publisher supplied coordinates | ~10 m | OSM, NSW, VIC, QLD | ✅ yes |
| `geocoded_address` | Derived from a street address | ~100 m | ACT | ✅ yes, with a caveat |
| `geocoded_locality` | Derived from a **town name** | **~5 km** | TAS | ❌ **no — opt in** |

Four behaviours follow from a record being `geocoded_locality`, all enforced in
code rather than left to callers:

1. **Excluded from the default view.** `src/core/search.js` filters on precision
   before anything else. Callers opt in with `includeApproximate` (CLI:
   `--include-approximate`; API: `?includeApproximate=true`; web: a checkbox).
2. **Never merged with any other record.** A town centroid can easily fall
   within the matcher's 250 m ceiling of an unrelated charger — in a small town
   it very likely does — and merging on that basis would attach a funding record
   to the wrong site and drag its identity along. `resolve.scorePair()` returns
   a hard zero when either side is locality-precision, even for identical
   coordinates and identical names.
3. **Never returned by `/api/nearest`.** That endpoint is the one most likely to
   be trusted for navigation.
4. **Confidence is penalised** (−0.30, versus −0.10 for street-level geocoding),
   so a town-level record cannot score like a surveyed one just because its
   other fields are complete.

The UI reinforces it: town-level records render as a dashed hollow ring rather
than a pin, carry a "town-level position" badge in the list, and open with
*"This is not a charger location… the charger may be several kilometres away.
Use it to know a funded charger exists here, not to navigate to it."*

**Why ingest it at all?** Because "is there a government-funded charger in
Miena?" is a real question that no other open source answers for Tasmania. The
data is genuinely useful as an *inventory*; it is simply not a *position*.

---

## 6. Tasmania — NRE ChargeSmart Grants

⚠️ **Town-level only. Excluded from the default map view.**

- **Page**: `https://nre.tas.gov.au/environment/climate-change/climate-change-grant-programs/electric-vehicle-chargesmart-grants`
- **Observed**: HTTP 200. **55 located grant rows** across three funding rounds.
- **Licence**: CC-BY 4.0 — the Tasmanian Government's stated default. Recorded
  as `licenceVerified: false` because the ReCFIT copyright page sits behind
  Cloudflare and could not be read directly.
- **Attribution**: `© State of Tasmania (Department of Natural Resources and Environment)`
- **Cadence**: per grant round, years apart. Refresh **monthly**.

### Use the canonical URL

The commonly-cited `recfit.tas.gov.au/grants_programs/climate-change/chargesmart_grants`
URL **redirects, and the redirect path is behind Cloudflare** — it returns
HTTP 403 to any non-browser client, so a pipeline using it fails. The canonical
`nre.tas.gov.au` URL above returns HTTP 200 to an ordinary fetch with a browser
User-Agent.

### What is ingested, and what is not

The page carries six tables. **Only three publish a `Location` column:**

| Round | Category | Rows | Ingested |
|---|---|---|---|
| ChargeSmart 3 (2025) | mixed | 12 | ✅ |
| Fast charging (2021-22) | DC | 20 | ✅ |
| Destination charging (2021-22) | AC | 23 | ✅ |
| Fast charging (2018-19) | DC | 12 | ❌ no location column |
| Destination charging (2018-19) | AC | 12 | ❌ no location column |
| Workplace charging (2018-19) | AC | 11 | ❌ no location column |

The 2018-19 tables list only `Organisation | Region | Amount`. **No location is
published at all.** Some rows embed a place in the organisation name, but the
parenthetical is inconsistent — `"(Campbell Town)(two 350kW ultrafast charging
stations)"`, `"(Accommodation - Derby)"`, `"Energy ROI (Scottsdale Art Gallery
Cafe)"` — and 25 of the 38 are bare names like `"City of Hobart"` or
`"Ashgrove Cheese"`. Extracting a place from those is **inference, not data**, so
those rows are reported as a data gap and left out.

### The parse validates itself — financially

Every table ends with a `Total` row stating the round's total grant value, so
the parsed rows must sum to it. Verified 2026-09-05:

| Table | Parsed sum | Stated total |
|---|---|---|
| ChargeSmart 3 | $567,000 | $567,000 ✅ |
| Fast charging | $710,500 | $710,500 ✅ |
| Destination charging | $62,500 | $62,500 ✅ |

A mis-parse or an upstream content edit therefore fails loudly. Two tests tamper
the page in both directions — and each first asserts that the tamper actually
changed the *parsed* data, because both money figures also appear in the page's
prose, where a naive string replacement edits nothing that matters.

### Town names are ambiguous — the geocode is bbox-guarded

Tasmania shares town names with the mainland: **Richmond, Kingston, Exeter,
Longford, Sheffield, Cambridge, Derby, Waratah, Southport**. Appending
`", Tasmania, Australia"` to the query resolved all 42 unique towns correctly,
but the adapter additionally rejects any geocode landing outside Tasmania's
bounding box, so a future mainland match cannot silently place a Tasmanian
grant in New South Wales.

### Other honest limits

- **No power ratings and no plug types** are published for the located rows, so
  `maxPowerKw` is null. Connectors are emitted as `DCUnspecified` /
  `ACUnspecified` derived from the table's own category heading ("Fast
  charging" funded DC) — published classification, not a guess at CCS2.
- **Plug counts** come only from the two rows the page annotates
  `"(two chargers)"`.
- **Status is `unknown`** — grants are funding, not delivery, exactly as with
  the ACT.
- The operator field holds the **grantee**, which is often a council, hotel or
  business rather than a charging network.
- The page directs users to PlugShare for actual charger locations.

---

## 7. Open Charge Map — off by default

- **API**: `https://api.openchargemap.io/v3/poi`
- **Observed**: **HTTP 403 without an API key.** Keys are free (register an
  application at openchargemap.org).
- **Bulk export**: `https://github.com/openchargemap/ocm-export`
  (migrating from the deprecated `ocm-data`).
- **Rate limits**: OCM asks callers to debounce and to assess before exceeding
  **~10,000 requests/day**; self-host a mirror for heavier use.

### The licence trap — why `opendata=true` is pinned

OCM redistributes a **mix** of licences. From its terms:

> "Data contributed to us by our users which we then redistribute is licensed
> under a Creative Commons Attribution 4.0 International (CC BY 4.0)."

> "Data imported from 3rd party Data Providers is copyright the original Data
> Provider in each case and is **not** provided under the same terms as the
> user-contributed data detailed above."

And from the API documentation:

> "Data returned by the API has mixed licensing and applicable copyright
> attribution... If you require Open licensed data you currently must filter by
> `opendata=true` to return data marked specifically with Open Data licenses."

Ingesting **unfiltered** OCM into a redistributable database would mix
proprietary operator data into an openly-licensed product. The adapter therefore
hardcodes `opendata=true` and additionally drops any record whose
`DataProvider.IsOpenDataLicensed` is false — defence in depth, because a query
parameter can be edited but a policy check in the normaliser is harder to
bypass by accident.

OCM also requires per-record Data Provider attribution be **visible to end
users**:

> "Use of our API or data in an application or service requires that the
> appropriate Data Provider attribution (including license terms) be provided
> in a way which is visible the end user."

So `extra.dataProvider` is retained per record and rendered in the web UI.

---

## ODbL obligations

This is the single most consequential licence question in the project, because
it determines what you owe downstream.

OpenStreetMap's licence distinguishes two things:

- **Produced Work** — "where you take the OSM data and turn it into a finished
  work... a website or API service that delivers map tiles or where you are
  displaying a map as part of a larger work." You may license a Produced Work
  however you like. Attribution still required.
- **Derivative Database** — "any translation, adaptation, arrangement,
  modification, or any other alteration of the Database or of a Substantial
  part of the Contents."

The practical fork for a charger map:

| What you do | Classification | Share-alike? |
|---|---|---|
| Query Overpass live at request time, store nothing | Produced Work only | No |
| **Ingest OSM into your own store** (this project) | **Derivative Database** | **Yes** |

From the OSM legal FAQ:

> "Where you make our data or any Derivative Database available to others, it
> must continue to be licensed under the ODbL. This is often referred to as
> Share-Alike."

> "If you create a Produced Work, you can apply whatever terms you like to the
> Produced Work, but you must upon request offer recipients either a copy of
> your data and any Derivative Databases under the terms of the ODbL or the
> means of creating the Derivative Databases upon request."

**This project takes the Derivative Database path deliberately**, because
querying Overpass live for every user request would be both slow and abusive of
a donated public endpoint. The consequence is implemented rather than promised:

```bash
node bin/evmap.js export --format odbl --out compliance/
# or: GET /api/export/odbl
```

That bundle contains the derived database in three formats plus a
`LICENCE-NOTICE.txt` stating the recipient's rights and obligations. The
`dataset.json` artefact also carries the effective licence inline:

```json
"licence": {
  "effective": "ODbL 1.0 (share-alike inherited from OpenStreetMap)",
  "reason": "This artefact is a Derivative Database of OpenStreetMap data, so ODbL share-alike applies to the database as a whole."
}
```

### Required attribution wording

Per the OSMF attribution guidelines (adopted 2021-06-25), attribution must be to
"OpenStreetMap" and must make clear the data is under the Open Database Licence.
The historical forms `© OpenStreetMap contributors` and `© OpenStreetMap` are
acceptable. For an interactive map it must appear in a corner of the map, or
adjacent to it, or on a splash screen; it may be auto-dismissed after user
interaction or after 5 seconds.

The generated map satisfies this in the Leaflet attribution control, and the
full source list with licences is in the "Data sources & licences" dialog.

### Mixing CC-BY and ODbL

The government sources are CC-BY (attribution only, no share-alike). Combining
them with OSM into one database means the **combined database** is ODbL, while
the individual source records remain under their own terms. Both facts are
recorded: `dataset.licence` states the effective licence,
`dataset.attribution[]` lists each source's own licence.

---

## What open data cannot give you

Deliberate non-goals, documented so nobody goes looking:

**Live availability.** Whether a plug is free, occupied or broken right now.
There is no openly-licensed source. The credible paths are OCPI 2.2.1 roaming
feeds or per-operator agreements — both commercial/partnership arrangements, not
open data. Undocumented endpoints behind operator map apps exist but are not an
architecture: they break without notice and their terms rarely permit reuse.

**Pricing.** Essentially absent from open data. NSW and Victoria publish no fee
field at all. Tariffs also change often enough that a weekly-refreshed
aggregate would be misleading even if it existed.

**Reliability history.** Not published by anyone openly.

---

## Dead ends, re-checked

All five original "dead end" verdicts were reached by searching open-data
portals. After the ACT turned out to publish via a policy page instead, every
one was re-checked against transport / energy / climate policy and grant pages.
**One more source turned up.**

### Tasmania — resolved: now ingested, town-level only

Originally recorded as a dead end (portal search), then found publishing
ChargeSmart grant recipients as HTML tables, and now **ingested** — but at
town-level precision and excluded from the default map view. Full detail in
[section 6](#6-tasmania--nre-chargesmart-grants).

### South Australia — dead end

The SA Government awarded $12.35M to the RAA to build a statewide network
(530+ chargers at 140 stations). The government's own page carries only an
**indicative design map** and states site locations "will be confirmed as site
host agreements are finalised". Actual locations exist only on RAA's commercial
site behind an interactive Chargefox map, with addresses scattered across
individual press releases. No consolidated list on any `.gov.au` page.

### Western Australia — dead end, and not open anyway

WA publishes a "Western Australia electric vehicle charger map" page linking to
a single PDF. The PDF was downloaded (HTTP 200, 171 KB) and inspected: it is a
**JPEG-compressed image** (`DCTDecode`, no text streams), so it holds no
extractable locations. The Synergy / Horizon Power WA EV Network pages cite 110
charging points across 49 locations but direct users to Chargefox or PlugShare.

Note the licence too: WA's terms describe Crown-owned IP licensed for
**personal non-commercial use only** — no Creative Commons. So even had the data
been extractable, it would not be redistributable here.

### Northern Territory — dead end

`dipl.nt.gov.au/strategies/electric-vehicle` is explicit: *"To find existing EV
charging locations, go to the PlugShare website."* Grant schemes and policy are
documented; no charger locations are published anywhere on `nt.gov.au`.

### National bodies — unchanged

| Body | Finding |
|---|---|
| **ARENA** | Funds charger deployment; publishes no location dataset. |
| **AEMO** | No charger inventory data. |
| **Electric Vehicle Council** | Aggregate statistics only (*State of EVs*), no raw locations. |
| **Federal government** | No open national charger map. |
| **Data standards** | **No Australian charger-information data standard exists.** No NEVCIS or equivalent. The Consumer Data Right covers retail energy only. |

### Corrected jurisdiction tally

| Jurisdiction | Official charger data? | Ingested? |
|---|---|---|
| NSW | Yes — CKAN dataset | Yes |
| VIC | Yes — WFS | Yes |
| QLD | Yes — CSV | Yes |
| **ACT** | **Yes — HTML tables** | **Yes** |
| **TAS** | **Yes — HTML tables, town-level only** | **Yes**, flagged town-level and hidden by default |
| SA | No | — |
| WA | No (image PDF; non-commercial licence) | — |
| NT | No | — |

So **three of eight** jurisdictions publish nothing usable, not five. Mappable
coverage in SA, WA, NT and TAS still comes entirely from OpenStreetMap —
Tasmania's own data adds 55 searchable town-level records on top, but no pins.

### Local government

Some councils publish charging-bay data via ArcGIS Hub — City of Sydney and
others such as Wyndham, Merri-bek and Geelong. Licences vary and are often
unspecified. **City of Sydney EV Charging Bays** has no licence stated in its
harvest record and is therefore not ingested. Verify before adding any council
source. These are low-yield anyway: they duplicate state data and add
maintenance cost for tens of records.

---

## Coverage baselines

Used to measure completeness. No open source states the national total, so
these come from commercial trackers and industry reporting:

| Figure | Basis | Source | Date |
|---|---|---|---|
| 3,774 sites / 10,350 bays | networked sites | Carloop | Aug 2026 |
| ~5,881 locations | incl. non-networked, via PlugShare filters | EVlog | Jul 2026 |
| 1,272 fast-charging locations / 4,192 high-power plugs | fast/high-power only | EV Council, *State of EVs* | Sep 2025 |

Definitions of "public charging site" differ between trackers, so treat the
range, not any single number, as the target.

**This project's 3,102 mappable sites and 9,216 plugs is therefore roughly 82%
of sites and 89% of bays against the Carloop baseline** — and about 53% against EVlog's
looser definition. OpenStreetMap alone would be 27–42%.

The honest headline: **open data gets you most of the way, and you cannot close
the last fifth without commercial data or operator relationships.**
