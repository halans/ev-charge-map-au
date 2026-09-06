'use strict';
/**
 * Source adapter: Transport for NSW "EV Charging Locations".
 *
 * Verified 2026-09-05: HTTP 200, 1,958 rows, CC-BY (3.0 AU on the portal).
 * Dataset page last modified 2026-07-14; CSV resource last modified 2026-04-20.
 *
 * This is the richest single dataset in the country and also the dirtiest.
 * Documented quirks, all measured:
 *   - UTF-8 BOM on the header row.
 *   - 98 rows have Charger_Type = "Upcoming" — these are NOT built yet.
 *   - 1,438 / 1,958 rows (73%) have an empty Station_name.
 *   - 1,837 rows have an empty OBJECTID, so there is no usable upstream key;
 *     we must synthesise a record id from content.
 *   - Charger_rating mixes real ratings ("22 kW"), current types ("AC", 522
 *     rows) and multi-bank strings ("2x350kW & 2x175kW").
 *   - Station_address sometimes has an empty street segment: ", Muswellbrook, 2333".
 *   - The filename is date-stamped (ev_20251216.csv), so the resource URL
 *     changes when they republish. We resolve it via the CKAN API instead of
 *     hardcoding it — see requests().
 */

const csv = require('../core/csv');
const geo = require('../core/geo');
const nrm = require('../core/normalise');

const id = 'nsw';

const meta = {
  id,
  name: 'Transport for NSW — EV Charging Locations',
  jurisdiction: 'NSW',
  licence: 'CC-BY 3.0 AU',
  licenceUrl: 'https://creativecommons.org/licenses/by/3.0/au/',
  attribution: '© State of New South Wales (Transport for NSW)',
  attributionRequired: true,
  shareAlike: false,
  homepage:
    'https://opendata.transport.nsw.gov.au/data/dataset/electric-vehicle-charging-stations-nsw',
  changeCadence: 'periodic (observed months between republications)',
  recommendedRefresh: 'weekly',
};

/** CKAN package id for the dataset, used to discover the current CSV resource. */
const PACKAGE_ID = 'be1c4de4-4517-4bd0-8a09-2965ddfc7179';
const CKAN_PACKAGE_URL = `https://opendata.transport.nsw.gov.au/data/api/3/action/package_show?id=${PACKAGE_ID}`;

/**
 * Known-good direct URL, used as a fallback if CKAN discovery fails.
 * Date-stamped by the publisher; expect it to go stale.
 */
const FALLBACK_CSV_URL =
  'https://opendata.transport.nsw.gov.au/data/dataset/be1c4de4-4517-4bd0-8a09-2965ddfc7179/resource/7bbb6461-e52d-4fe7-ace4-a15c30198de0/download/ev_20251216.csv';

function requests() {
  return [
    {
      key: 'nsw-package.json',
      urls: [CKAN_PACKAGE_URL],
      format: 'json',
      /**
       * Two-stage fetch: read the CKAN metadata, then follow it to whichever
       * CSV resource is current. This is what stops a republished, renamed
       * file from silently breaking the pipeline.
       */
      then: (pkg) => {
        const resources = ((pkg && pkg.result && pkg.result.resources) || []).filter(
          (r) =>
            String(r.format).toUpperCase() === 'CSV' &&
            !/not updated/i.test(r.name || '')
        );
        // Prefer the most recently modified current CSV.
        resources.sort((a, b) =>
          String(b.last_modified || b.created || '').localeCompare(
            String(a.last_modified || a.created || '')
          )
        );
        const url = resources.length ? resources[0].url : FALLBACK_CSV_URL;
        return [{ key: 'nsw-ev.csv', urls: [url], format: 'text' }];
      },
    },
  ];
}

/**
 * Synthesise a stable record id. OBJECTID is empty on 94% of rows, so we hash
 * the content that identifies the row instead. Stable across re-ingest as long
 * as the publisher does not change the values.
 */
function syntheticId(row, index) {
  const oid = String(row.OBJECTID || '').trim();
  if (oid) return `objectid:${oid}`;
  const basis = [
    Number(row.Latitude).toFixed(5),
    Number(row.Longitude).toFixed(5),
    nrm.slug(row.Operator, 12),
    nrm.slug(row.Charger_Type, 6),
  ].join('|');
  // Cheap deterministic 32-bit hash (FNV-1a). Not cryptographic; only needs
  // to be stable and collision-rare within one dataset.
  let h = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `row:${h.toString(16)}:${index}`;
}

/**
 * Highest power any practical AC charger delivers, in kW.
 *
 * Single-phase AC tops out around 7 kW and three-phase around 22 kW; 43 kW
 * exists but is rare and effectively the ceiling. Anything above this is DC by
 * physics, whatever the source says.
 */
const AC_CEILING_KW = 43;

/**
 * Build connectors from the NSW Charger_Type + Charger_rating pair.
 * NSW does not publish connector standards, only AC/DC and a rating, so we
 * emit an unspecified-standard connector rather than inventing CCS2.
 *
 * REGRESSION GUARD: `Charger_Type` is not always AC or DC. 98 rows carry
 * "Upcoming" in that column instead, and two of those state a rating of
 * "2x350kW & 2x175kW" with the operator truncated to "PLUS ES Manag".
 *
 * The original implementation treated anything that was not literally "DC" as
 * AC, which labelled those two sites as 350 kW **AC** connectors — physically
 * impossible, and visible in the data as a kerbside AC network apparently
 * operating ultra-rapid chargers. When the stated current type is unusable,
 * infer it from the power instead, and emit nothing rather than guessing when
 * the power cannot settle it either.
 */
function connectorsFromRow(row) {
  const typeRaw = String(row.Charger_Type || '').trim();
  const parsed = nrm.parsePowerRating(row.Charger_rating);
  const statedAc = /^ac$/i.test(typeRaw);
  const statedDc = /^dc$/i.test(typeRaw);

  /** @returns {string|null} the canonical standard, or null if undecidable */
  const standardFor = (kw) => {
    if (statedDc) return nrm.CONNECTORS.DC_UNSPECIFIED;
    if (statedAc) return nrm.CONNECTORS.AC_UNSPECIFIED;
    // Type not stated usefully (e.g. "Upcoming"): let the power decide.
    if (Number.isFinite(kw) && kw > AC_CEILING_KW) return nrm.CONNECTORS.DC_UNSPECIFIED;
    return null; // genuinely unknown — do not guess
  };

  if (parsed.groups.length) {
    return parsed.groups
      .map((g) => ({ standard: standardFor(g.kw), count: g.count, powerKw: g.kw }))
      .filter((c) => c.standard !== null);
  }

  // No parseable rating: still record that a connector of this current type
  // exists, with unknown power. Losing the row entirely would be worse.
  if (statedAc || statedDc) {
    const plugs = /^\d+$/.test(String(row.Number_of_plugs || '').trim())
      ? parseInt(row.Number_of_plugs, 10)
      : null;
    return [{ standard: standardFor(null), count: plugs, powerKw: null }];
  }
  return [];
}

/**
 * @param {string} raw CSV text
 * @param {{fetchedAt:string}} ctx
 */
function normalise(raw, ctx = {}) {
  const fetchedAt = ctx.fetchedAt || new Date().toISOString();
  const rows = csv.parse(raw);
  const records = [];
  const issues = [];

  rows.forEach((row, index) => {
    const lat = parseFloat(row.Latitude);
    const lng = parseFloat(row.Longitude);
    const recordId = syntheticId(row, index);

    if (!geo.isValidLatLng(lat, lng)) {
      issues.push({ sourceId: id, sourceRecordId: recordId, kind: 'rejected', issue: 'missing or invalid coordinates' });
      return;
    }
    if (!geo.isInAustralia(lat, lng)) {
      issues.push({
        sourceId: id,
        sourceRecordId: recordId,
        kind: 'rejected',
        issue: `coordinate outside AU bbox (${lat},${lng})`,
      });
      return;
    }

    const parsedPower = nrm.parsePowerRating(row.Charger_rating);
    if (parsedPower.note) {
      issues.push({ sourceId: id, sourceRecordId: recordId, kind: /no rating/.test(parsedPower.note) ? 'data_gap' : 'parse_failure', issue: `power: ${parsedPower.note}` });
    }

    // "Upcoming" appears in Charger_Type, not in a status column. Source also
    // distinguishes existing vs round-based rollouts ("Destination Charging R2").
    const statusBasis = /upcoming/i.test(row.Charger_Type || '')
      ? 'upcoming'
      : /^existing/i.test(row.Source || '')
        ? 'existing'
        : 'operational';
    const status = nrm.normaliseStatus(statusBasis);
    if (status === 'planned') {
      issues.push({ sourceId: id, sourceRecordId: recordId, kind: 'status_flag', issue: 'planned/unbuilt site (Charger_Type=Upcoming)' });
    }

    const address = nrm.parseAddress(row.Station_address);
    // The CSV has a dedicated postcode column that is more reliable than
    // scraping it out of the address string.
    if (address && !address.postcode && /^\d{4}$/.test(String(row.PCODE || '').trim())) {
      address.postcode = String(row.PCODE).trim();
    }
    if (address && !address.state) address.state = 'NSW';

    const plugCount = /^\d+$/.test(String(row.Number_of_plugs || '').trim())
      ? parseInt(row.Number_of_plugs, 10)
      : null;

    records.push({
      sourceId: id,
      sourceRecordId: recordId,
      sourceUrl: meta.homepage,
      fetchedAt,
      lat,
      lng,
      name: nrm.cleanText(row.Station_name),
      operator: nrm.normaliseOperator(row.Operator),
      network: nrm.normaliseOperator(row.Operator),
      address,
      connectors: connectorsFromRow(row),
      plugCount,
      maxPowerKw: parsedPower.maxKw,
      status,
      access: 'unknown', // NSW does not publish an access field
      fee: null, // nor a fee field — must stay unknown, not "free"
      openingHours: null,
      website: null,
      /** Source-specific extras worth keeping for QA and facets. */
      extra: {
        lga: nrm.cleanText(row.LGANAME),
        programme: nrm.cleanText(row.Source),
        chargerType: nrm.cleanText(row.Charger_Type),
        ratingRaw: nrm.cleanText(row.Charger_rating),
      },
    });
  });

  return { records, issues };
}

module.exports = { id, meta, requests, normalise, syntheticId, connectorsFromRow, AC_CEILING_KW, PACKAGE_ID };
