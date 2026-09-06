'use strict';
/**
 * Source adapter: Tasmania — Electric Vehicle ChargeSmart Grants (NRE Tas).
 *
 * https://nre.tas.gov.au/environment/climate-change/climate-change-grant-programs/electric-vehicle-chargesmart-grants
 *
 * ================================================================
 * READ THIS FIRST: these coordinates are TOWN CENTROIDS
 * ================================================================
 * Tasmania publishes a `Location` column containing a TOWN NAME — "Miena",
 * "Coles Bay", "Cradle Mountain" — and nothing finer. No street address, no
 * coordinates. Geocoding a town name yields the town's centroid, which for a
 * charger is hundreds of metres to kilometres out.
 *
 * So every record here is `positionPrecision: 'geocoded_locality'`, which has
 * three consequences enforced elsewhere in the codebase:
 *   1. EXCLUDED from the default map view and API results (src/core/search.js).
 *      Callers opt in with `includeApproximate`.
 *   2. NEVER merged with another record (src/core/resolve.js). A town centroid
 *      can land within the 250 m matching ceiling of an unrelated charger, and
 *      merging on that basis would attach a funding record to the wrong site.
 *   3. Ranked LAST for lat/lng, and never returned by `/api/nearest`.
 *
 * What this source IS good for: answering "is there a government-funded
 * charger in this town?" — which is genuine, searchable information that
 * appears in no other open dataset for Tasmania.
 *
 * ================================================================
 * WHAT IS AND IS NOT INGESTED
 * ================================================================
 * The page carries six tables. Only THREE have a `Location` column:
 *   - "Chargesmart 3 2025"                    12 rows
 *   - "Fast charging" (2021-22)               20 rows
 *   - "Destination charging" (2021-22)        23 rows
 *                                          = 55 rows ingested
 *
 * The other three (the 2018-19 round: Fast, Destination, Workplace — 38 rows)
 * list only `Organisation | Region | Amount`. **No location is published at
 * all.** Some rows embed a place in the organisation name, but inconsistently
 * and ambiguously — "(Campbell Town)(two 350kW ultrafast charging stations)",
 * "(Accommodation - Derby)", "Energy ROI (Scottsdale Art Gallery Cafe)" — and
 * 25 of the 38 are bare organisation names like "City of Hobart" or "Ashgrove
 * Cheese". Extracting a location from those is inference, not data, so those
 * rows are reported as a data gap and NOT ingested.
 *
 * ================================================================
 * SELF-VALIDATING PARSE
 * ================================================================
 * Each table ends with a "Total" row stating the round's total grant value.
 * The adapter sums the parsed rows and reconciles against it — verified
 * 2026-09-05: $567,000, $710,500 and $62,500 all match exactly. A restructured
 * page or a mis-parsed row therefore fails loudly instead of silently yielding
 * fewer records.
 *
 * ================================================================
 * FETCH NOTE
 * ================================================================
 * The commonly-cited `recfit.tas.gov.au/grants_programs/...` URL redirects, and
 * that redirect path is behind Cloudflare — it returns HTTP 403 to any
 * non-browser client. The canonical `nre.tas.gov.au` URL used here returns
 * HTTP 200 to a normal fetch with a browser User-Agent.
 *
 * Licence: CC-BY 4.0 (the Tasmanian Government's stated default; the ReCFIT
 * copyright page itself sits behind Cloudflare and could not be read directly,
 * so this is recorded as the stated default rather than a verified quote).
 */

const geo = require('../core/geo');
const nrm = require('../core/normalise');
const geocoder = require('../geocode');

const id = 'tas';

const meta = {
  id,
  name: 'Tasmania NRE — Electric Vehicle ChargeSmart Grants',
  jurisdiction: 'TAS',
  licence: 'CC-BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: '© State of Tasmania (Department of Natural Resources and Environment)',
  attributionRequired: true,
  shareAlike: false,
  homepage:
    'https://nre.tas.gov.au/environment/climate-change/climate-change-grant-programs/electric-vehicle-chargesmart-grants',
  changeCadence: 'per grant round (years apart)',
  recommendedRefresh: 'monthly',
  coverageCaveat:
    'ChargeSmart grant recipients only, located to TOWN level with no street address. Excluded from the default map view; not a charger location.',
  requiresGeocoding: true,
  geocodeRegion: 'Tasmania, Australia',
  /** Declares that this source cannot produce mappable coordinates. */
  positionPrecision: nrm.POSITION_PRECISION.GEOCODED_LOCALITY,
  licenceVerified: false,
  notes:
    'HTML table scrape. Town-level positions only. 38 further rows publish no location and are not ingested.',
};

const PAGE_URL = meta.homepage;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

/** Tasmania's bounding box, used to reject ambiguous geocodes. */
const TAS_BBOX = { minLat: -43.8, maxLat: -39.2, minLng: 143.7, maxLng: 148.6 };

/* ------------------------------------------------------------------ *
 * HTML helpers
 * ------------------------------------------------------------------ */

/** Decode the entities this page actually uses, including numeric ones. */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hx) => String.fromCharCode(parseInt(hx, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&rsquo;|&#8217;/gi, '’');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTable(tableHtml) {
  return [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
    .map((tr) => [...tr[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((c) => stripTags(c[0])))
    .filter((cells) => cells.length > 1);
}

/** Parse "$50,000" -> 50000. */
function parseMoney(raw) {
  const m = /\$\s*([\d,]+)/.exec(String(raw || ''));
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

/** Is this the table's summary row rather than a grant? */
function isTotalRow(cells) {
  return /^total$/i.test(String(cells[0] || '').trim());
}

/**
 * Find the grant tables that actually publish a location, pairing each with
 * its round heading.
 */
function findLocationTables(html) {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => ({
    html: m[0],
    pos: m.index,
  }));

  const out = [];
  for (const table of tables) {
    const rows = parseTable(table.html);
    const header = rows[0] || [];
    const locationIndex = header.findIndex((h) => /^location$/i.test(h));
    if (locationIndex === -1) continue; // 2018-19 tables publish no location

    const before = html.slice(Math.max(0, table.pos - 3000), table.pos);
    const headings = [...before.matchAll(/<h[2-4][^>]*>([\s\S]{0,200}?)<\/h[2-4]>/gi)];
    const heading = headings.length ? stripTags(headings[headings.length - 1][1]) : null;

    const body = rows.slice(1);
    out.push({
      heading,
      header,
      locationIndex,
      rows: body.filter((r) => !isTotalRow(r)),
      statedTotal: (() => {
        const t = body.find(isTotalRow);
        return t ? parseMoney(t[t.length - 1]) : null;
      })(),
    });
  }
  return out;
}

/** Count the tables that publish no location, for honest reporting. */
function findLocationlessTables(html) {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  const out = [];
  for (const t of tables) {
    const rows = parseTable(t);
    const header = rows[0] || [];
    if (header.some((h) => /^location$/i.test(h))) continue;
    if (!header.some((h) => /^organisation$/i.test(h))) continue;
    out.push({ header, rows: rows.slice(1).filter((r) => !isTotalRow(r)) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Field parsing
 * ------------------------------------------------------------------ */

/**
 * The grant category, taken from the table heading. This is published
 * classification, not inference: a "Fast charging" grant funded DC charging.
 * @returns {'fast'|'destination'|'workplace'|null}
 */
function grantCategory(heading) {
  const h = String(heading || '').toLowerCase();
  if (/fast charging/.test(h)) return 'fast';
  if (/destination charging/.test(h)) return 'destination';
  if (/workplace charging/.test(h)) return 'workplace';
  return null;
}

/**
 * Connectors implied by the grant category. Deliberately unspecified
 * standards — the page states no plug types, so claiming CCS2 would be
 * fabrication. "Fast" grants funded DC; "destination" grants funded AC.
 */
function connectorsFromCategory(category, powerKw) {
  if (category === 'fast') {
    return [{ standard: nrm.CONNECTORS.DC_UNSPECIFIED, count: null, powerKw: powerKw || null }];
  }
  if (category === 'destination' || category === 'workplace') {
    return [{ standard: nrm.CONNECTORS.AC_UNSPECIFIED, count: null, powerKw: powerKw || null }];
  }
  return [];
}

/**
 * Split a `Location` value into its town and any parenthetical qualifier.
 * Observed: "St Helens (Upgrade)", "Shearwater (Port Sorell)".
 */
function parseLocation(raw) {
  const text = stripTags(raw);
  if (!text) return { town: null, qualifier: null };
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(text);
  if (m) return { town: m[1].trim(), qualifier: m[2].trim() };
  return { town: text, qualifier: null };
}

/**
 * Recover a plug count from an organisation name.
 * The page writes "(two chargers)" for the two rows that funded a pair, which
 * is published information rather than a guess.
 */
function parseChargerCount(organisation) {
  const text = String(organisation || '').toLowerCase();
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const m = /\((one|two|three|four|five|\d+)\s+chargers?\)/.exec(text);
  if (!m) return null;
  return words[m[1]] || parseInt(m[1], 10) || null;
}

/** Strip trailing parenthetical notes from an organisation name. */
function cleanOrganisation(raw) {
  return (
    nrm.cleanText(
      String(raw || '')
        .replace(/\((?:one|two|three|four|five|\d+)\s+chargers?\)/gi, '')
        .replace(/\s+/g, ' ')
    ) || null
  );
}

/* ------------------------------------------------------------------ *
 * Adapter interface
 * ------------------------------------------------------------------ */

function requests() {
  return [
    {
      key: 'tas-chargesmart.html',
      urls: [PAGE_URL],
      format: 'text',
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,*/*' },
      /**
       * Validate before caching. The strongest check available is financial:
       * each table states its own grant total, so the parsed rows must sum to
       * it. That catches a mis-parse and a content edit alike.
       */
      validate: (text) => {
        if (!/chargesmart/i.test(text)) {
          return 'page does not look like the ChargeSmart grants page';
        }
        const tables = findLocationTables(text);
        if (tables.length === 0) {
          return 'no grant tables with a Location column found (page restructured?)';
        }
        if (tables.length !== 3) {
          return `expected 3 tables with a Location column, found ${tables.length}`;
        }

        let rowTotal = 0;
        for (const t of tables) {
          if (!t.rows.length) return `table "${t.heading}" has no data rows`;
          const summed = t.rows.reduce((a, r) => a + (parseMoney(r[r.length - 1]) || 0), 0);
          if (t.statedTotal === null) {
            return `table "${t.heading}" has no stated total to reconcile against`;
          }
          if (summed !== t.statedTotal) {
            return (
              `table "${t.heading}": parsed grants sum to $${summed} but the page ` +
              `states $${t.statedTotal} — parse is wrong or the page changed`
            );
          }
          rowTotal += t.rows.length;
        }
        if (rowTotal < 40) return `only ${rowTotal} located grant rows found, expected ~55`;
        return null;
      },
    },
  ];
}

/** Town names needing geocoding. */
function addressesToGeocode(raw) {
  const out = [];
  for (const table of findLocationTables(raw)) {
    for (const row of table.rows) {
      const { town } = parseLocation(row[table.locationIndex]);
      if (town) out.push(town);
    }
  }
  return [...new Set(out)];
}

function normalise(raw, ctx = {}) {
  const fetchedAt = ctx.fetchedAt || new Date().toISOString();
  const records = [];
  const issues = [];

  const tables = findLocationTables(raw);

  // Report the rows that publish no location at all, so the gap is visible in
  // the ingest report rather than looking like a parse failure.
  const locationless = findLocationlessTables(raw);
  const locationlessRows = locationless.reduce((a, t) => a + t.rows.length, 0);
  if (locationlessRows) {
    issues.push({
      sourceId: id,
      sourceRecordId: 'tas:locationless',
      kind: 'data_gap',
      issue:
        `${locationlessRows} grant rows (the 2018-19 round) publish no Location column — ` +
        'not ingested, because extracting a place from an organisation name is inference',
    });
  }

  for (const table of tables) {
    const category = grantCategory(table.heading);
    const round = nrm.cleanText(table.heading);

    table.rows.forEach((row, rowIndex) => {
      const organisationRaw = row[0];
      const { town, qualifier } = parseLocation(row[table.locationIndex]);
      const region = nrm.cleanText(row[table.locationIndex + 1]);
      const amount = parseMoney(row[row.length - 1]);
      const organisation = cleanOrganisation(organisationRaw);

      const recordId = `tas:${nrm.slug(round || 'round', 20)}:${nrm.slug(
        `${organisationRaw}-${town || rowIndex}`,
        40
      )}`;

      if (!town) {
        issues.push({
          sourceId: id,
          sourceRecordId: recordId,
          kind: 'rejected',
          issue: `row has no location ("${row[table.locationIndex]}")`,
        });
        return;
      }

      const fix = geocoder.fromCache(town);
      if (fix === undefined) {
        issues.push({
          sourceId: id,
          sourceRecordId: recordId,
          kind: 'rejected',
          issue: `town "${town}" not in the geocode cache — run an online ingest to populate it`,
        });
        return;
      }
      if (!fix) {
        issues.push({
          sourceId: id,
          sourceRecordId: recordId,
          kind: 'rejected',
          issue: `geocoding found no coordinate for town "${town}"`,
        });
        return;
      }

      /**
       * Reject a geocode that landed outside Tasmania.
       *
       * Necessary because several Tasmanian town names exist elsewhere in
       * Australia — Richmond, Kingston, Exeter, Longford, Sheffield — and a
       * mainland match would put a Tasmanian grant in the wrong state.
       */
      if (
        !geo.isValidLatLng(fix.lat, fix.lng) ||
        fix.lat < TAS_BBOX.minLat ||
        fix.lat > TAS_BBOX.maxLat ||
        fix.lng < TAS_BBOX.minLng ||
        fix.lng > TAS_BBOX.maxLng
      ) {
        issues.push({
          sourceId: id,
          sourceRecordId: recordId,
          kind: 'rejected',
          issue:
            `geocode for "${town}" resolved outside Tasmania (${fix.lat},${fix.lng}) — ` +
            'ambiguous town name matched the mainland',
        });
        return;
      }

      // Funding, not delivery — same reasoning as the ACT source.
      issues.push({
        sourceId: id,
        sourceRecordId: recordId,
        kind: 'status_flag',
        issue: 'status unknown: the page reports grant funding, not delivery',
      });

      issues.push({
        sourceId: id,
        sourceRecordId: recordId,
        kind: 'data_gap',
        issue: `town-level position only ("${town}") — not a charger location`,
      });

      const plugCount = parseChargerCount(organisationRaw);

      records.push({
        sourceId: id,
        sourceRecordId: recordId,
        sourceUrl: PAGE_URL,
        fetchedAt,
        lat: fix.lat,
        lng: fix.lng,
        // The name that is actually useful here is the grantee plus the town,
        // because the position is only the town anyway.
        name: organisation ? `${organisation} — ${town}` : town,
        // The grantee is the closest thing to an operator the page publishes.
        // Many are councils or businesses rather than charging networks, so
        // normaliseOperator passes them through unchanged.
        operator: nrm.normaliseOperator(organisation),
        network: null,
        address: { full: `${town}, TAS`, street: null, suburb: town, state: 'TAS', postcode: null },
        connectors: connectorsFromCategory(category, null),
        plugCount,
        maxPowerKw: null, // the page states no power ratings for located rows
        status: 'unknown',
        access: 'unknown',
        fee: null,
        openingHours: null,
        website: null,
        /** The whole point: this is a town centroid, not a charger position. */
        positionPrecision: nrm.POSITION_PRECISION.GEOCODED_LOCALITY,
        geocoded: true,
        extra: {
          round,
          grantCategory: category,
          grantAmountAud: amount,
          organisationRaw: nrm.cleanText(organisationRaw),
          town,
          locationQualifier: qualifier,
          region,
          geocodeMatch: fix.displayName || null,
          programme: 'Electric Vehicle ChargeSmart Grants',
        },
      });
    });
  }

  return { records, issues };
}

module.exports = {
  id,
  meta,
  requests,
  normalise,
  addressesToGeocode,
  PAGE_URL,
  TAS_BBOX,
  cleanOrganisation,
  connectorsFromCategory,
  decodeEntities,
  findLocationTables,
  findLocationlessTables,
  grantCategory,
  isTotalRow,
  parseChargerCount,
  parseLocation,
  parseMoney,
  parseTable,
  stripTags,
};
