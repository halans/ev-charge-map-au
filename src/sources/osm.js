'use strict';
/**
 * Source adapter: OpenStreetMap via the Overpass API.
 *
 * Why this is the backbone of the project:
 *  - It is the only source with national coverage under a single licence.
 *  - It needs no API key (verified 2026-09-05: HTTP 200, 1,590 AU elements).
 *  - It is continuously updated by people standing at the charger.
 *
 * Licence: Open Database Licence (ODbL) 1.0. Attribution is MANDATORY and the
 * share-alike term applies to derived *databases*. See docs/DATA_SOURCES.md.
 */

const geo = require('../core/geo');
const nrm = require('../core/normalise');

const id = 'osm';

const meta = {
  id,
  name: 'OpenStreetMap (Overpass API)',
  jurisdiction: 'AU (national)',
  licence: 'ODbL 1.0',
  licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  attribution: '© OpenStreetMap contributors',
  attributionRequired: true,
  shareAlike: true,
  homepage: 'https://www.openstreetmap.org/',
  /** How often the upstream data meaningfully changes. Drives ingest cadence. */
  changeCadence: 'continuous',
  recommendedRefresh: 'daily',
};

/** Overpass mirrors, tried in order. */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Overpass QL. `out center tags` gives a single coordinate for ways too, so
 * charging sites mapped as car-park polygons are not lost (35 of them today).
 */
const QUERY = [
  '[out:json][timeout:280];',
  'area["ISO3166-1"="AU"][admin_level=2]->.a;',
  '(',
  '  node["amenity"="charging_station"](area.a);',
  '  way["amenity"="charging_station"](area.a);',
  ');',
  'out center tags;',
].join('\n');

/**
 * How stale an Overpass mirror's database may be before we refuse its answer.
 *
 * This exists because of a real incident on 2026-09-05: the primary endpoint
 * timed out, the pipeline fell back to the kumi mirror, and that mirror
 * returned **HTTP 200 with a complete-looking payload of 1,493 elements** —
 * against the primary's 1,590. Nothing was truncated and there was no
 * `remark`; the mirror's underlying database was simply four months behind
 * (`timestamp_osm_base: 2026-05-06` vs `2026-09-04`). A 6% coverage loss,
 * completely silent, and small enough to slip under the record-count drift
 * threshold.
 *
 * Overpass helpfully states its own data age in `osm3s.timestamp_osm_base`,
 * so we can simply refuse a stale mirror and let the fetch layer try the next
 * URL (or fall back to our own cache, which is better than fresh-but-worse
 * data).
 */
const MAX_DATA_AGE_DAYS = 7;

/** Descriptor consumed by the fetch layer (src/fetch.js). */
function requests(ctx = {}) {
  const maxAgeDays = ctx.maxDataAgeDays || MAX_DATA_AGE_DAYS;
  return [
    {
      key: 'osm-au-chargers.json',
      urls: ENDPOINTS,
      method: 'POST',
      body: new URLSearchParams({ data: QUERY }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      format: 'json',
      validate: (parsed) => {
        if (!parsed || !Array.isArray(parsed.elements)) {
          return 'response has no elements array';
        }
        // Overpass reports partial results in a top-level `remark`.
        if (parsed.remark) return `Overpass remark: ${parsed.remark}`;
        if (!parsed.elements.length) return 'zero elements returned';

        const base = parsed.osm3s && parsed.osm3s.timestamp_osm_base;
        if (!base) return 'response is missing osm3s.timestamp_osm_base';
        const ageDays = (Date.now() - Date.parse(base)) / 86400000;
        if (!Number.isFinite(ageDays)) {
          return `unparseable timestamp_osm_base "${base}"`;
        }
        if (ageDays > maxAgeDays) {
          return (
            `mirror database is ${ageDays.toFixed(0)} days stale ` +
            `(timestamp_osm_base ${base}, limit ${maxAgeDays} days) — refusing a degraded mirror`
          );
        }
        return null;
      },
    },
  ];
}

/** Read the numeric part of an OSM `socket:*:output` value, e.g. "350 kW". */
function outputToKw(raw) {
  const parsed = nrm.parsePowerRating(raw);
  return parsed.maxKw;
}

/**
 * Extract connectors from OSM socket:* tags.
 * Tag shape: socket:type2_combo=2, socket:type2_combo:output=350 kW
 */
function connectorsFromTags(tags) {
  const out = [];
  for (const [key, value] of Object.entries(tags)) {
    if (!key.startsWith('socket:')) continue;
    if (key.endsWith(':output') || key.endsWith(':voltage') || key.endsWith(':current')) continue;
    const standard = nrm.normaliseConnector(key.slice('socket:'.length));
    if (!standard) continue;
    const count = /^\d+$/.test(String(value).trim()) ? parseInt(value, 10) : null;
    const powerKw = outputToKw(tags[`${key}:output`]);
    out.push({ standard, count, powerKw });
  }
  return out;
}

/**
 * Normalise raw Overpass JSON into the shared record shape.
 * @param {object} raw parsed Overpass response
 * @param {{fetchedAt:string}} ctx
 * @returns {{records: Array<object>, issues: Array<object>}}
 */
function normalise(raw, ctx = {}) {
  const fetchedAt = ctx.fetchedAt || new Date().toISOString();
  const records = [];
  const issues = [];
  const elements = (raw && raw.elements) || [];

  for (const el of elements) {
    if (el.type === 'count') continue; // `out count` responses
    const tags = el.tags || {};
    // Ways carry their coordinate under `center` because of `out center`.
    const lat = el.lat !== undefined ? el.lat : el.center && el.center.lat;
    const lng = el.lon !== undefined ? el.lon : el.center && el.center.lon;

    if (!geo.isValidLatLng(lat, lng)) {
      issues.push({ sourceId: id, sourceRecordId: `${el.type}/${el.id}`, kind: 'rejected', issue: 'missing or invalid coordinates' });
      continue;
    }
    if (!geo.isInAustralia(lat, lng)) {
      issues.push({
        sourceId: id,
        sourceRecordId: `${el.type}/${el.id}`,
        kind: 'rejected',
        issue: `coordinate outside AU bbox (${lat},${lng})`,
      });
      continue;
    }

    const connectors = connectorsFromTags(tags);
    const capacity = /^\d+$/.test(String(tags.capacity || '').trim())
      ? parseInt(tags.capacity, 10)
      : null;

    // OSM has no explicit status tag for chargers; disused:/proposed: prefixes
    // and lifecycle tags carry it instead.
    let statusRaw = 'operational';
    if (tags['disused:amenity'] || tags.disused === 'yes') statusRaw = 'decommissioned';
    if (tags['proposed:amenity'] || tags.proposed === 'yes') statusRaw = 'planned';
    if (tags.construction === 'yes' || tags['construction:amenity']) statusRaw = 'construction';

    const maxFromConnectors = connectors.reduce((a, c) => Math.max(a, c.powerKw || 0), 0);

    records.push({
      sourceId: id,
      sourceRecordId: `${el.type}/${el.id}`,
      sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      fetchedAt,
      lat,
      lng,
      name: nrm.cleanText(tags.name || tags.short_name || tags.operator || tags.brand),
      /**
       * True when `name` above fell back to operator/brand because the element
       * has no real name tag.
       *
       * This matters for matching, not display. Such a "name" describes the
       * charging NETWORK ("Evie Networks", "bp pulse", "Exploren"), whereas
       * sources like the ACT name the VENUE ("Eastlake Football Club",
       * "Next Gen Canberra"). Comparing across those two vocabularies always
       * yields near-zero similarity, so treating the mismatch as evidence of
       * two different sites is wrong — it rejected an ACT/OSM pair sitting
       * 0 metres apart. The resolver skips name scoring when this is set.
       */
      nameFromOperator: !(tags.name || tags.short_name) && !!(tags.operator || tags.brand),
      operator: nrm.normaliseOperator(tags.operator || tags.brand || tags.network),
      network: nrm.normaliseOperator(tags.network || tags.brand),
      address: (() => {
        const parts = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
        const joined = [parts, tags['addr:suburb'] || tags['addr:city'], tags['addr:state'], tags['addr:postcode']]
          .filter(Boolean)
          .join(', ');
        return joined ? nrm.parseAddress(joined) : null;
      })(),
      connectors,
      plugCount: capacity,
      maxPowerKw: maxFromConnectors || null,
      status: nrm.normaliseStatus(statusRaw),
      access: nrm.normaliseAccess(tags.access),
      fee: nrm.normaliseFee(tags.fee),
      openingHours: nrm.cleanText(tags.opening_hours),
      website: nrm.cleanText(tags.website || tags['brand:website'] || tags['network:website']),
      raw: undefined, // deliberately dropped: keeps the built artefact small
    });
  }

  return { records, issues };
}

module.exports = { id, meta, requests, normalise, QUERY, ENDPOINTS, connectorsFromTags };
