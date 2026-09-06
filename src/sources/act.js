'use strict';
/**
 * Source adapter: ACT Government — public EV chargers (Climate Choices).
 *
 * https://www.climatechoices.act.gov.au/transport-and-travel/zero-emissions-vehicles/public-ev-chargers-in-the-act
 *
 * WHY THIS SOURCE WAS ORIGINALLY MISSED
 * An earlier survey concluded the ACT published nothing, because it searched
 * data.act.gov.au (a Socrata portal, which returns only federated US DoE
 * data). The ACT does publish its charger list — as HTML tables inside
 * accordions on a policy page. No open-data portal search will ever surface
 * that. The lesson generalises: government data is not always in the data
 * portal.
 *
 * SHAPE (verified 2026-09-05, HTTP 200, 159,033 bytes)
 * Seven district accordions — Belconnen, Gungahlin, Inner North,
 * Inner South / East Canberra, Molonglo/Weston Creek, Woden Valley,
 * Tuggeranong — each containing one table with columns:
 *   Number of chargers | Number of charging bays | Charger type | Plug type | Location
 * 35 rows in total, summing to 74 chargers and 131 bays.
 *
 * SELF-VALIDATING PARSE
 * The page states its own totals: "As of December 2025, 74 public EV chargers
 * with 131 charging bays have received ACT Government funding." The adapter
 * parses that sentence and checks its own row sums against it, refusing the
 * response if they diverge. That converts a fragile HTML scrape into one that
 * fails loudly when the page is restructured, instead of silently returning
 * fewer rows.
 *
 * NO COORDINATES
 * The page gives addresses only, so records are geocoded via src/geocode.js
 * (Nominatim, ODbL, cached on disk). Geocoded coordinates are ranked LAST for
 * lat/lng in the resolver, because a geocoded street address can sit tens of
 * metres from the actual bay and must never override a surveyed OSM position.
 *
 * STATUS IS DELIBERATELY `unknown`
 * The tables list chargers that "have received ACT Government funding" —
 * funding is not delivery. Each district also carries a sentence like
 * "26 new government-supported charging bays are on the way", and those
 * figures (118 total) do NOT reconcile with the per-district table bays
 * (15, 16, 52, 20, 4, 16, 8 = 131), so they cannot be used to classify rows.
 * Victoria's near-identical ambiguity mislabelled 96 live sites when guessed
 * at, so nothing is guessed here: every ACT record is `unknown`, and OSM
 * corroboration is allowed to upgrade it (the resolver trusts `osm` above
 * `act` for status, so a site OSM confirms as operational becomes operational).
 *
 * Licence: CC-BY 4.0. The ACT site's copyright page states its material is
 * "available under a Creative Commons Attribution 4.0 licence, with the
 * exception of any images, photographs, video recordings, sound recordings or
 * branding, including the ACT Coat of Arms, the ACT Government logo and any
 * other government logos or symbols".
 */

const geo = require('../core/geo');
const nrm = require('../core/normalise');
const geocoder = require('../geocode');

const id = 'act';

const meta = {
  id,
  name: 'ACT Government — Public EV chargers (Climate Choices)',
  jurisdiction: 'ACT',
  licence: 'CC-BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: '© Australian Capital Territory',
  attributionRequired: true,
  shareAlike: false,
  homepage:
    'https://www.climatechoices.act.gov.au/transport-and-travel/zero-emissions-vehicles/public-ev-chargers-in-the-act',
  changeCadence: 'infrequent (page edited as grants are delivered)',
  recommendedRefresh: 'weekly',
  coverageCaveat:
    'ACT Government-funded chargers only (131 bays). The page states 300+ public bays exist territory-wide, so this is roughly 44% of ACT public charging.',
  /** This source needs geocoding; the pipeline uses this to wire it up. */
  requiresGeocoding: true,
  geocodeRegion: 'ACT, Australia',
  notes:
    'HTML table scrape. Status is unknown by design: the page reports funding, not delivery.',
};

const PAGE_URL = meta.homepage;

/** The ACT site rejects non-browser agents on some paths; send a real one. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

/** Districts, in page order. Used to label records and to sanity-check the parse. */
const DISTRICTS = [
  'Belconnen',
  'Gungahlin',
  'Inner North',
  'Inner South / East Canberra',
  'Molonglo/Weston Creek',
  'Woden Valley',
  'Tuggeranong',
];

/* ------------------------------------------------------------------ *
 * Minimal HTML helpers (no dependencies)
 * ------------------------------------------------------------------ */

/** Strip tags and decode the handful of entities this page actually uses. */
function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse an HTML <table> into rows of cell strings. */
function parseTable(tableHtml) {
  return [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
    .map((tr) => [...tr[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((c) => stripTags(c[0])))
    .filter((cells) => cells.length > 1);
}

/**
 * Read the totals the page states about itself, for the self-check.
 * Target sentence: "As of December 2025, 74 public EV chargers with 131
 * charging bays have received ACT Government funding."
 * @returns {{chargers:number, bays:number, asOf:string|null}|null}
 */
function statedTotals(html) {
  const text = stripTags(html.replace(/<script[\s\S]*?<\/script>/gi, ''));
  const m = text.match(
    /As of ([A-Za-z]+ \d{4}),?\s*(\d+)\s+public EV chargers?\s+with\s+(\d+)\s+charging bays/i
  );
  if (!m) return null;
  return { asOf: m[1], chargers: parseInt(m[2], 10), bays: parseInt(m[3], 10) };
}

/**
 * Locate the charger tables and pair each with its district.
 *
 * District names live in accordion <button> labels, not in headings, so this
 * matches on document order: each charger table is preceded by its district
 * button and a "N new ... bays are on the way" sentence.
 */
function findDistrictTables(html) {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => ({
    html: m[0],
    pos: m.index,
  }));

  const out = [];
  for (const table of tables) {
    const rows = parseTable(table.html);
    const header = (rows[0] || []).join(' | ');
    // Only the charger tables have this header; the grants table is Applicant|Grant.
    if (!/Number of chargers/i.test(header)) continue;

    const before = html.slice(Math.max(0, table.pos - 4000), table.pos);

    // Nearest preceding accordion button label that matches a known district.
    let district = null;
    const buttons = [...before.matchAll(/<button[^>]*>([\s\S]{0,200}?)<\/button>/gi)];
    for (let i = buttons.length - 1; i >= 0; i--) {
      const label = stripTags(buttons[i][1]);
      if (DISTRICTS.some((d) => d.toLowerCase() === label.toLowerCase())) {
        district = DISTRICTS.find((d) => d.toLowerCase() === label.toLowerCase());
        break;
      }
    }

    /**
     * The forward-looking sentence, captured for the record but NOT used to
     * classify status — see the module header for why.
     *
     * Must take the LAST match in the lookback window, not the first: the
     * window spans several accordions, so `exec` returning the first match
     * attributed each district the *previous* district's figure (Gungahlin
     * showed Belconnen's 26, Inner North showed Gungahlin's 4, and so on).
     */
    const otwMatches = [
      ...before.matchAll(/(\d+)\s+new government-supported charging bays are on the way/gi),
    ];
    const otw = otwMatches.length ? otwMatches[otwMatches.length - 1] : null;

    out.push({
      district,
      onTheWayBays: otw ? parseInt(otw[1], 10) : null,
      rows: rows.slice(1),
      header: rows[0] || [],
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Field parsing
 * ------------------------------------------------------------------ */

/**
 * Parse the "Charger type" column: "22kW AC", "150kW DC", "200kW DC",
 * "7kW AC", and the spacing variant "150 kW DC".
 * @returns {{kw:number|null, current:'AC'|'DC'|null}}
 */
function parseChargerType(raw) {
  const text = String(raw || '').trim();
  if (!text) return { kw: null, current: null };
  const parsed = nrm.parsePowerRating(text);
  const current = /\bDC\b/i.test(text) ? 'DC' : /\bAC\b/i.test(text) ? 'AC' : null;
  return { kw: parsed.maxKw, current };
}

/**
 * Parse the "Plug type" column into canonical connector standards.
 *
 * Observed values:
 *   "Type 2"
 *   "CCS2"
 *   "CCS2 and CHAdeMO"
 *   "Bring your own Type 1 or Type 2"   <- an AC socket, either plug accepted
 */
function parsePlugTypes(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  // "Bring your own X or Y" describes a socket accepting either plug. Emit both
  // standards so a driver filtering on either one finds the site.
  const byo = /bring your own/i.test(text);
  const body = text.replace(/bring your own/i, '');

  const standards = [];
  for (const part of body.split(/,|\band\b|\bor\b|\/|\+/i)) {
    const std = nrm.normaliseConnector(part.trim());
    if (std && !standards.includes(std)) standards.push(std);
  }

  return standards.map((standard) => ({
    standard,
    count: null,
    powerKw: null,
    bringYourOwnCable: byo || undefined,
  }));
}

/**
 * Split the "Location" column into a venue name and a street address.
 * e.g. "Sentinel Apartments 39 Benjamin Way, Belconnen"
 *   -> name "Sentinel Apartments", address "39 Benjamin Way, Belconnen"
 * Some rows have no venue prefix, and one includes a trailing
 * ", ACT 2611, Australia".
 */
function splitLocation(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return { name: null, address: null };

  // Venue name is everything before the first house number.
  const m = text.match(/\b\d+[a-zA-Z]?(?:\s*[-/]\s*\d+)?\s+[A-Z]/);
  if (m && m.index > 0) {
    return {
      name: text.slice(0, m.index).replace(/[,\s]+$/, '') || null,
      address: text.slice(m.index).trim(),
    };
  }
  // No house number (e.g. "Jamison Plaza Jamison Centre, Macquarie"): treat the
  // leading segment as the venue and keep the whole string as the address.
  const comma = text.indexOf(',');
  return {
    name: comma > 0 ? text.slice(0, comma).trim() : text,
    address: text,
  };
}

/* ------------------------------------------------------------------ *
 * Adapter interface
 * ------------------------------------------------------------------ */

function requests() {
  return [
    {
      key: 'act-chargers.html',
      urls: [PAGE_URL],
      format: 'text',
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,*/*' },
      /**
       * Validate BEFORE the cache is written. Three ways this page can betray
       * us, all of which would otherwise look like a successful fetch:
       *  1. a redirect to a generic error/landing page (no tables);
       *  2. a restructure that breaks table detection (fewer tables);
       *  3. an edit that changes the numbers without changing the structure.
       * (3) is caught by reconciling the parse against the page's own totals.
       */
      validate: (text) => {
        if (!/public ev charger/i.test(text)) {
          return 'page does not look like the ACT public EV chargers page';
        }
        const tables = findDistrictTables(text);
        if (tables.length === 0) return 'no charger tables found (page restructured?)';
        if (tables.length !== DISTRICTS.length) {
          return `expected ${DISTRICTS.length} district tables, found ${tables.length}`;
        }

        const stated = statedTotals(text);
        if (!stated) return 'could not find the stated charger/bay totals sentence';

        let chargers = 0;
        let bays = 0;
        for (const t of tables) {
          for (const row of t.rows) {
            chargers += parseInt(row[0], 10) || 0;
            bays += parseInt(row[1], 10) || 0;
          }
        }
        if (chargers !== stated.chargers || bays !== stated.bays) {
          return (
            `parsed totals (${chargers} chargers / ${bays} bays) do not match the ` +
            `totals the page states (${stated.chargers} / ${stated.bays}) — parse is wrong or the page changed`
          );
        }
        return null;
      },
    },
  ];
}

/**
 * Addresses this source will need geocoded. The pipeline calls this before
 * normalise() so the geocode cache can be warmed in one throttled pass.
 * @param {string} raw page HTML
 * @returns {string[]}
 */
function addressesToGeocode(raw) {
  const out = [];
  for (const table of findDistrictTables(raw)) {
    for (const row of table.rows) {
      const { address } = splitLocation(row[4]);
      if (address) out.push(address);
    }
  }
  return [...new Set(out)];
}

function normalise(raw, ctx = {}) {
  const fetchedAt = ctx.fetchedAt || new Date().toISOString();
  const records = [];
  const issues = [];

  const tables = findDistrictTables(raw);
  const stated = statedTotals(raw);

  let seenChargers = 0;
  let seenBays = 0;

  for (const table of tables) {
    const district = table.district || 'ACT';

    table.rows.forEach((row, rowIndex) => {
      const chargerCount = parseInt(row[0], 10) || null;
      const bayCount = parseInt(row[1], 10) || null;
      const typeRaw = row[2];
      const plugRaw = row[3];
      const locationRaw = row[4];

      seenChargers += chargerCount || 0;
      seenBays += bayCount || 0;

      const { name, address } = splitLocation(locationRaw);
      const recordId = `act:${nrm.slug(district, 18)}:${nrm.slug(name || address || String(rowIndex), 28)}`;

      if (!address) {
        issues.push({
          sourceId: id,
          sourceRecordId: recordId,
          kind: 'rejected',
          issue: `row has no usable location ("${locationRaw}")`,
        });
        return;
      }

      // Coordinates come from the geocode cache. A miss means we cannot place
      // the site, and inventing a suburb-centroid pin would be worse than
      // omitting it — so the record is dropped and reported.
      const fix = geocoder.fromCache(address);
      if (fix === undefined) {
        issues.push({
          sourceId: id,
          sourceRecordId: recordId,
          kind: 'rejected',
          issue: `address not in the geocode cache ("${address}") — run an online ingest to populate it`,
        });
        return;
      }
      if (!fix) {
        issues.push({
          sourceId: id,
          sourceRecordId: recordId,
          kind: 'rejected',
          issue: `geocoding found no coordinate for "${address}"`,
        });
        return;
      }
      if (!geo.isValidLatLng(fix.lat, fix.lng) || !geo.isInAustralia(fix.lat, fix.lng)) {
        issues.push({
          sourceId: id,
          sourceRecordId: recordId,
          kind: 'rejected',
          issue: `geocoded coordinate outside Australia for "${address}" (${fix.lat},${fix.lng})`,
        });
        return;
      }

      const type = parseChargerType(typeRaw);
      if (!type.kw && typeRaw) {
        issues.push({
          sourceId: id,
          sourceRecordId: recordId,
          kind: 'parse_failure',
          issue: `unparsed charger type "${typeRaw}"`,
        });
      }

      const connectors = parsePlugTypes(plugRaw);
      if (!connectors.length && plugRaw) {
        issues.push({
          sourceId: id,
          sourceRecordId: recordId,
          kind: 'parse_failure',
          issue: `unparsed plug type "${plugRaw}"`,
        });
      }
      // Distribute the row's stated power across its connectors.
      if (type.kw) for (const c of connectors) c.powerKw = type.kw;

      // Every ACT record is funding-confirmed but delivery-unconfirmed.
      issues.push({
        sourceId: id,
        sourceRecordId: recordId,
        kind: 'status_flag',
        issue: 'status unknown: the ACT page reports grant funding, not delivery',
      });

      const parsedAddress = nrm.parseAddress(address);
      if (parsedAddress && !parsedAddress.state) parsedAddress.state = 'ACT';

      records.push({
        sourceId: id,
        sourceRecordId: recordId,
        sourceUrl: PAGE_URL,
        fetchedAt,
        lat: fix.lat,
        lng: fix.lng,
        name: nrm.cleanText(name),
        // The ACT publishes no operator per row — the grants table names the
        // recipients (ActewAGL, BP Pulse, ENGIE, Evie, EVX, NRMA, SolarHub) but
        // does not map them to sites, so inferring one would be fabrication.
        operator: null,
        network: null,
        address: parsedAddress,
        connectors,
        plugCount: bayCount,
        maxPowerKw: type.kw,
        status: 'unknown',
        access: 'public', // the page's subject is explicitly *public* chargers
        fee: null,
        openingHours: null,
        website: null,
        /** Marks the coordinate as derived, not published. */
        geocoded: true,
        extra: {
          district,
          chargerCount,
          bayCount,
          chargerTypeRaw: nrm.cleanText(typeRaw),
          plugTypeRaw: nrm.cleanText(plugRaw),
          currentType: type.current,
          locationRaw: nrm.cleanText(locationRaw),
          geocodeMatch: fix.displayName || null,
          geocodeType: fix.type || null,
          districtOnTheWayBays: table.onTheWayBays,
          programme: 'ACT Government EV charging grants',
        },
      });
    });
  }

  // Report the reconciliation outcome so it lands in the ingest report even
  // when the data was served from cache (validate only runs on fetch).
  if (stated && (seenChargers !== stated.chargers || seenBays !== stated.bays)) {
    issues.push({
      sourceId: id,
      sourceRecordId: 'act:totals',
      kind: 'parse_failure',
      issue:
        `parsed ${seenChargers} chargers / ${seenBays} bays but the page states ` +
        `${stated.chargers} / ${stated.bays}`,
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
  DISTRICTS,
  PAGE_URL,
  findDistrictTables,
  parseChargerType,
  parsePlugTypes,
  parseTable,
  splitLocation,
  statedTotals,
  stripTags,
};
