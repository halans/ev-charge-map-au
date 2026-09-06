'use strict';
/**
 * Address -> coordinate geocoding, with a permanent on-disk cache.
 *
 * WHY THIS EXISTS
 * Every source except the ACT supplies coordinates. The ACT publishes only
 * street addresses ("Sentinel Apartments 39 Benjamin Way, Belconnen"), so
 * those records cannot enter the pipeline — which requires lat/lng — without
 * being geocoded first.
 *
 * WHY NOMINATIM
 * It is OpenStreetMap-derived, so it carries ODbL, which is exactly the licence
 * this dataset already inherits. A commercial geocoder (Google, Mapbox) would
 * add terms that conflict with redistributing the result — most forbid storing
 * geocodes or displaying them on a non-native basemap. Using an ODbL geocoder
 * keeps the output licence unchanged.
 *
 * OPERATING RULES (Nominatim usage policy)
 *  - Absolute maximum 1 request per second. Enforced here, not left to callers.
 *  - An identifying User-Agent is mandatory.
 *  - No bulk geocoding. This is ~35 addresses, once, then cached forever.
 *
 * THE CACHE IS THE POINT
 * Results are written to data/raw/geocode-cache.json and committed. That keeps
 * three promises intact: offline rebuilds never hit the network, repeated runs
 * never re-query a donated service, and the dataset stays reproducible.
 *
 * ACCURACY CAVEAT
 * A geocoded street address lands anywhere from a few metres to ~100 m from the
 * actual charger bay. Geocoded coordinates are therefore ranked LAST for
 * lat/lng in the resolver's per-field trust order, and every geocoded record
 * carries `geocoded: true` so downstream consumers can tell.
 */

const fs = require('fs');
const path = require('path');

const fetchLayer = require('./fetch');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'raw', 'geocode-cache.json');
const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** Nominatim asks for no more than one request per second. */
const MIN_INTERVAL_MS = 1100;

/**
 * Contact-identifying agent. Nominatim's policy requires being able to
 * identify the caller; a generic agent risks a block for everyone.
 */
const USER_AGENT = 'ev-charge-map-au/1.0 open-data-aggregation (geocoding ~35 AU addresses, cached)';

/** Attribution owed for any coordinate produced here. */
const ATTRIBUTION = {
  sourceId: 'nominatim',
  text: 'Geocoding © OpenStreetMap contributors (Nominatim)',
  licence: 'ODbL 1.0',
  licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  shareAlike: true,
};

function readCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    return parsed && parsed.entries ? parsed : { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  // Stable key order so the committed file produces clean diffs.
  const ordered = { version: cache.version || 1, entries: {} };
  for (const key of Object.keys(cache.entries).sort()) ordered.entries[key] = cache.entries[key];
  fs.writeFileSync(CACHE_PATH, JSON.stringify(ordered, null, 2) + '\n');
}

/**
 * Normalise an address into a stable cache key. Must not change casually —
 * changing it silently invalidates the whole committed cache.
 */
function cacheKey(address) {
  return String(address || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Build the query variants to try, most specific first.
 *
 * ACT addresses are prefixed with a venue name ("Jamison Plaza Jamison Centre,
 * Macquarie"), which Nominatim often fails on. Falling back to the street
 * portion — everything from the first house number onwards — recovers most of
 * them, and finally the suburb alone gives a coarse but honest fix.
 */
function queryVariants(address, region) {
  const clean = String(address || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const suffix = region ? `, ${region}` : '';
  const variants = [`${clean}${suffix}`];

  // From the first house number onwards, e.g. "39 Benjamin Way, Belconnen".
  const numMatch = clean.match(/\b\d+[a-zA-Z]?(?:\s*[-/]\s*\d+)?\s+[A-Z][\w'-]*/);
  if (numMatch && numMatch.index > 0) {
    variants.push(`${clean.slice(numMatch.index)}${suffix}`);
  }

  // Last comma-separated component is usually the suburb.
  const parts = clean.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    variants.push(`${parts[parts.length - 1]}${suffix}`);
  }

  return [...new Set(variants)];
}

let lastRequestAt = 0;

async function throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/**
 * Query Nominatim for one string.
 * @returns {Promise<{lat:number,lng:number,displayName:string,type:string}|null>}
 */
async function queryNominatim(query, opts = {}) {
  await throttle();
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '1',
    countrycodes: 'au',
    addressdetails: '0',
  });
  const url = `${ENDPOINT}?${params.toString()}`;

  const res = await fetchLayer.httpRequest(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    timeoutMs: opts.timeoutMs || 30000,
  });

  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);

  let parsed;
  try {
    parsed = JSON.parse(res.text);
  } catch (err) {
    throw new Error(`Nominatim returned non-JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed) || !parsed.length) return null;

  const hit = parsed[0];
  const lat = parseFloat(hit.lat);
  const lng = parseFloat(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    lat,
    lng,
    displayName: hit.display_name || null,
    type: [hit.category, hit.type].filter(Boolean).join(':') || null,
  };
}

/**
 * Geocode a list of addresses, using and updating the on-disk cache.
 *
 * @param {string[]} addresses
 * @param {object} opts
 *   region:  string appended to each query, e.g. 'ACT, Australia'
 *   offline: boolean — never touch the network; uncached addresses resolve to null
 *   log:     function
 * @returns {Promise<{results: Map<string, object|null>, stats: object}>}
 */
async function geocodeAll(addresses, opts = {}) {
  const log = opts.log || (() => {});
  const cache = readCache();
  const results = new Map();
  const stats = { requested: 0, fromCache: 0, fetched: 0, failed: 0, skippedOffline: 0 };

  const unique = [...new Set(addresses.filter(Boolean))];
  stats.requested = unique.length;

  let cacheDirty = false;

  for (const address of unique) {
    const key = cacheKey(address);

    if (Object.prototype.hasOwnProperty.call(cache.entries, key)) {
      const entry = cache.entries[key];
      results.set(address, entry.result || null);
      stats.fromCache++;
      if (!entry.result) stats.failed++;
      continue;
    }

    if (opts.offline) {
      results.set(address, null);
      stats.skippedOffline++;
      log(`  · geocode: no cached coordinate for "${address}" (offline)`);
      continue;
    }

    let found = null;
    let attempted = [];
    for (const variant of queryVariants(address, opts.region)) {
      attempted.push(variant);
      try {
        found = await queryNominatim(variant, opts);
      } catch (err) {
        log(`  ! geocode: ${err.message} for "${variant}"`);
        found = null;
      }
      if (found) break;
    }

    cache.entries[key] = {
      address,
      queriedAt: new Date().toISOString(),
      attempted,
      result: found,
    };
    cacheDirty = true;

    if (found) {
      stats.fetched++;
      log(`  ✓ geocode: "${address}" -> ${found.lat.toFixed(6)},${found.lng.toFixed(6)}`);
    } else {
      stats.failed++;
      log(`  ✗ geocode: no match for "${address}" (tried ${attempted.length} variants)`);
    }
    results.set(address, found);
  }

  if (cacheDirty) writeCache(cache);

  return { results, stats };
}

/** Look up a single address from the cache only. Used by adapters in normalise(). */
function fromCache(address) {
  const cache = readCache();
  const entry = cache.entries[cacheKey(address)];
  return entry ? entry.result || null : undefined;
}

/** How many addresses the committed cache resolves. For tests and reporting. */
function cacheStats() {
  const cache = readCache();
  const keys = Object.keys(cache.entries);
  return {
    total: keys.length,
    resolved: keys.filter((k) => cache.entries[k].result).length,
    unresolved: keys.filter((k) => !cache.entries[k].result).length,
  };
}

module.exports = {
  ATTRIBUTION,
  CACHE_PATH,
  ENDPOINT,
  MIN_INTERVAL_MS,
  USER_AGENT,
  cacheKey,
  cacheStats,
  fromCache,
  geocodeAll,
  queryNominatim,
  queryVariants,
  readCache,
  writeCache,
};
