'use strict';
/**
 * Query engine over the canonical site list.
 *
 * This is THE search implementation. The CLI, the HTTP API and the generated
 * web page all call `query()` — none of them filter sites themselves. That is
 * what makes the cross-surface equivalence test in test/equivalence.test.js
 * meaningful rather than decorative.
 *
 * No Node built-ins: this file is inlined verbatim into the browser bundle.
 */

const geo = require('./geo');
const nrm = require('./normalise');

/** Fields a text query is matched against, in descending weight. */
const TEXT_FIELDS = [
  ['name', 3],
  ['displayName', 3],
  ['operator', 2],
  ['network', 1],
];

/**
 * @typedef {object} Query
 * @property {string}   [text]        free-text match on name/operator/suburb
 * @property {number}   [lat]         centre for radius search
 * @property {number}   [lng]
 * @property {number}   [radiusKm]    requires lat/lng
 * @property {object}   [bbox]        {minLat,maxLat,minLng,maxLng}
 * @property {string[]} [states]      e.g. ['NSW','VIC']
 * @property {string[]} [operators]   canonical operator names
 * @property {string[]} [connectors]  canonical standards, e.g. ['CCS2']
 * @property {number}   [minPowerKw]
 * @property {number}   [maxPowerKw]
 * @property {string[]} [speedBands]
 * @property {string[]} [statuses]    default ['operational','unknown']
 * @property {boolean}  [includePlanned] convenience: adds 'planned'
 * @property {number}   [minSources]  corroboration filter
 * @property {number}   [minConfidence]
 * @property {string}   [sort]        'relevance'|'distance'|'power'|'confidence'|'name'
 * @property {number}   [limit]
 * @property {number}   [offset]
 */

/** Default statuses: never show unbuilt sites unless explicitly asked. */
const DEFAULT_STATUSES = ['operational', 'unknown'];

/**
 * Default positional precisions.
 *
 * Town-level records (Tasmania's ChargeSmart grant list) are EXCLUDED by
 * default. They are real information — a funded charger exists in that town —
 * but the coordinate is a town centroid with kilometres of error, so showing it
 * on a map alongside surveyed pins would imply a precision that does not exist.
 * Callers opt in with `includeApproximate` or an explicit `precisions` list.
 */
const DEFAULT_PRECISIONS = nrm.MAPPABLE_PRECISIONS.slice();

function asArray(v) {
  if (v === null || v === undefined || v === '') return null;
  return Array.isArray(v) ? v : [v];
}

function normaliseQuery(raw = {}) {
  const q = {
    text: raw.text ? String(raw.text).trim() : null,
    lat: raw.lat !== undefined && raw.lat !== null && raw.lat !== '' ? Number(raw.lat) : null,
    lng: raw.lng !== undefined && raw.lng !== null && raw.lng !== '' ? Number(raw.lng) : null,
    radiusKm:
      raw.radiusKm !== undefined && raw.radiusKm !== null && raw.radiusKm !== ''
        ? Number(raw.radiusKm)
        : null,
    bbox: raw.bbox || null,
    states: asArray(raw.states),
    operators: asArray(raw.operators),
    connectors: asArray(raw.connectors),
    minPowerKw: raw.minPowerKw !== undefined && raw.minPowerKw !== null && raw.minPowerKw !== '' ? Number(raw.minPowerKw) : null,
    maxPowerKw: raw.maxPowerKw !== undefined && raw.maxPowerKw !== null && raw.maxPowerKw !== '' ? Number(raw.maxPowerKw) : null,
    speedBands: asArray(raw.speedBands),
    statuses: asArray(raw.statuses) || DEFAULT_STATUSES.slice(),
    precisions: asArray(raw.precisions) || DEFAULT_PRECISIONS.slice(),
    minSources: raw.minSources ? Number(raw.minSources) : null,
    minConfidence: raw.minConfidence ? Number(raw.minConfidence) : null,
    sort: raw.sort || null,
    limit: raw.limit !== undefined && raw.limit !== null && raw.limit !== '' ? Number(raw.limit) : 100,
    offset: raw.offset ? Number(raw.offset) : 0,
  };

  if (raw.includePlanned) {
    if (!q.statuses.includes('planned')) q.statuses = q.statuses.concat('planned');
  }

  // Opt in to town-level records.
  if (raw.includeApproximate) {
    for (const p of Object.values(nrm.POSITION_PRECISION)) {
      if (!q.precisions.includes(p)) q.precisions = q.precisions.concat(p);
    }
  }

  // Uppercase state codes so ?states=nsw works.
  if (q.states) q.states = q.states.map((s) => String(s).toUpperCase());

  // A radius search without a centre is a client bug; fail loudly rather than
  // silently returning the whole country.
  if (q.radiusKm !== null && (q.lat === null || q.lng === null)) {
    throw new Error('radiusKm requires both lat and lng');
  }
  if (q.limit !== null && (!Number.isFinite(q.limit) || q.limit < 0)) {
    throw new Error('limit must be a non-negative number');
  }
  if (q.limit !== null && q.limit > 10000) q.limit = 10000;

  return q;
}

/** Relevance score for a text query, 0 when it does not match at all. */
function textScore(site, text) {
  const needle = String(text).toLowerCase().trim();
  if (!needle) return 1;
  const tokens = needle.split(/\s+/).filter(Boolean);
  let score = 0;

  for (const [field, weight] of TEXT_FIELDS) {
    const value = site[field];
    if (!value) continue;
    const hay = String(value).toLowerCase();
    for (const t of tokens) {
      if (hay.includes(t)) score += weight;
      if (hay.startsWith(t)) score += weight * 0.5; // prefix bonus
    }
  }

  // Address components: suburb is what people actually type.
  if (site.address) {
    for (const part of [site.address.suburb, site.address.street, site.address.postcode]) {
      if (!part) continue;
      const hay = String(part).toLowerCase();
      for (const t of tokens) if (hay.includes(t)) score += 2;
    }
  }

  // Fuzzy fallback so "chargefoxx" or reordered words still find something.
  if (score === 0 && site.name) {
    const sim = nrm.tokenSimilarity(site.name, needle);
    if (sim >= 0.34) score = sim;
  }

  return score;
}

function inBbox(site, bbox) {
  return (
    site.lat >= bbox.minLat &&
    site.lat <= bbox.maxLat &&
    site.lng >= bbox.minLng &&
    site.lng <= bbox.maxLng
  );
}

/**
 * Run a query over a site array.
 * @param {Array<object>} sites
 * @param {Query} rawQuery
 * @returns {{results: Array<object>, total: number, query: object, facets: object}}
 */
function query(sites, rawQuery = {}) {
  const q = normaliseQuery(rawQuery);
  const matched = [];

  // Pre-compute the radius bbox once as a cheap pre-filter.
  const radiusBbox =
    q.radiusKm !== null ? geo.bboxAround(q.lat, q.lng, q.radiusKm * 1000) : null;

  for (const site of sites) {
    if (q.statuses && !q.statuses.includes(site.status)) continue;

    if (q.precisions && !q.precisions.includes(nrm.positionPrecision(site))) continue;

    if (q.states && !q.states.includes(String(site.state || '').toUpperCase())) continue;

    if (q.operators && !q.operators.includes(site.operator)) continue;

    if (q.minPowerKw !== null && !(Number(site.maxPowerKw) >= q.minPowerKw)) continue;
    if (q.maxPowerKw !== null && !(Number(site.maxPowerKw) <= q.maxPowerKw)) continue;

    if (q.speedBands && !q.speedBands.includes(site.speedBand)) continue;

    if (q.connectors) {
      const have = (site.connectors || []).map((c) => c.standard);
      if (!q.connectors.some((c) => have.includes(c))) continue;
    }

    if (q.minSources !== null && !(site.sourceCount >= q.minSources)) continue;
    if (q.minConfidence !== null && !(site.confidence >= q.minConfidence)) continue;

    if (q.bbox && !inBbox(site, q.bbox)) continue;

    let distanceM = null;
    if (radiusBbox) {
      if (!inBbox(site, radiusBbox)) continue; // cheap reject
      distanceM = geo.distanceMetres(q.lat, q.lng, site.lat, site.lng);
      if (distanceM > q.radiusKm * 1000) continue; // exact reject
    } else if (q.lat !== null && q.lng !== null) {
      distanceM = geo.distanceMetres(q.lat, q.lng, site.lat, site.lng);
    }

    let score = 1;
    if (q.text) {
      score = textScore(site, q.text);
      if (score <= 0) continue;
    }

    matched.push({ site, score, distanceM });
  }

  // Sorting. Default: distance when a centre is given, else relevance when
  // there is a text query, else power (most useful ordering for a bare list).
  const sortMode =
    q.sort || (q.lat !== null && q.lng !== null ? 'distance' : q.text ? 'relevance' : 'power');

  const comparators = {
    distance: (a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity),
    relevance: (a, b) => b.score - a.score || (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity),
    power: (a, b) => (b.site.maxPowerKw || 0) - (a.site.maxPowerKw || 0),
    confidence: (a, b) => b.site.confidence - a.site.confidence,
    name: (a, b) => String(a.site.name || '~').localeCompare(String(b.site.name || '~')),
  };
  const cmp = comparators[sortMode];
  if (!cmp) {
    throw new Error(
      `Unknown sort "${sortMode}". Valid: ${Object.keys(comparators).join(', ')}`
    );
  }
  // Stable tiebreak on id so results are deterministic across surfaces.
  matched.sort((a, b) => cmp(a, b) || a.site.id.localeCompare(b.site.id));

  const total = matched.length;
  const page = q.limit === null ? matched.slice(q.offset) : matched.slice(q.offset, q.offset + q.limit);

  return {
    query: q,
    sort: sortMode,
    total,
    returned: page.length,
    facets: facetsFor(matched.map((m) => m.site)),
    results: page.map((m) => ({
      ...m.site,
      ...(m.distanceM !== null
        ? { distanceM: Math.round(m.distanceM), distanceKm: Number((m.distanceM / 1000).toFixed(2)) }
        : {}),
      ...(q.text ? { relevance: Number(m.score.toFixed(3)) } : {}),
    })),
  };
}

/** Facet counts for the matched set, so UI filters can show live counts. */
function facetsFor(sites) {
  const count = (arr, key) => {
    const m = {};
    for (const s of arr) {
      const v = key(s);
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        for (const one of v) m[one] = (m[one] || 0) + 1;
      } else {
        m[v] = (m[v] || 0) + 1;
      }
    }
    return m;
  };

  return {
    state: count(sites, (s) => s.state || 'unknown'),
    operator: count(sites, (s) => s.operator || 'unknown'),
    speedBand: count(sites, (s) => s.speedBand),
    status: count(sites, (s) => s.status),
    connector: count(sites, (s) => (s.connectors || []).map((c) => c.standard)),
    sourceCount: count(sites, (s) => String(s.sourceCount)),
    positionPrecision: count(sites, (s) => nrm.positionPrecision(s)),
  };
}

/** Find one site by canonical id. */
function byId(sites, id) {
  return sites.find((s) => s.id === id) || null;
}

/** Nearest N sites to a point, ignoring all other filters except status. */
function nearest(sites, lat, lng, n = 5, statuses = DEFAULT_STATUSES) {
  return sites
    // A town centroid must never be offered as "the nearest charger" — it is
    // not a location, and this endpoint is the one most likely to be trusted
    // for navigation.
    .filter((s) => statuses.includes(s.status) && nrm.isMappable(s))
    .map((s) => ({ site: s, distanceM: geo.distanceMetres(lat, lng, s.lat, s.lng) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, n)
    .map((x) => ({ ...x.site, distanceM: Math.round(x.distanceM) }));
}

module.exports = {
  DEFAULT_PRECISIONS,
  DEFAULT_STATUSES,
  byId,
  facetsFor,
  nearest,
  normaliseQuery,
  query,
  textScore,
};
