'use strict';
/**
 * Identity resolution and provenance-tracked merge.
 *
 * The problem this solves, measured on real data (2026-09-05):
 *   OSM has 1,590 AU charging sites. TfNSW alone has 1,958 NSW rows.
 *   Neither is a superset of the other. The same physical site appears in both
 *   with different names (73% of TfNSW rows have NO name at all), coordinates
 *   tens of metres apart, and different operator spellings ("BP" / "BP Australia").
 *   Concatenating sources produces doubled pins; naive coordinate rounding
 *   merges genuinely distinct chargers in the same shopping-centre car park.
 *
 * Approach: spatial bucketing -> candidate pairs -> weighted score ->
 * single-link clustering -> field-level merge by source trust, retaining
 * per-field provenance so every value on the map can be traced to a source.
 */

const geo = require('./geo');
const nrm = require('./normalise');

/**
 * Per-source trust weights, used to pick a winner when sources disagree.
 * Rationale, not vibes:
 *  - Government datasets are authoritative for the sites they cover, because
 *    they are derived from funding/deployment records. But they are stale
 *    between publications and jurisdictionally incomplete.
 *  - OSM is continuously updated by people physically at the site, so it is
 *    better for names, opening hours and access, and it covers every state.
 * Trust is therefore assigned PER FIELD, not per source.
 */
const DEFAULT_FIELD_TRUST = {
  // field            : ordered list of source ids, most trusted first
  //
  // Every enabled source must be listed in every field it can supply.
  // `pickField` ranks an unlisted source last, so omitting one silently
  // demotes it — which is what happened to `vic` before this was filled in,
  // despite Victoria publishing the best-structured connector data of any
  // source.
  //
  // Two placements matter more than the rest:
  //   - `act` is LAST for lat/lng, because its coordinates are geocoded from
  //     street addresses and can be tens of metres out. They must never
  //     override a surveyed OpenStreetMap position.
  //   - `act` is LAST for status, because every ACT record is `unknown` (the
  //     source reports grant funding, not delivery). Ranking it last lets a
  //     source with real status information win, so a site OpenStreetMap
  //     confirms as operational is reported as operational.
  name: ['osm', 'act', 'vic', 'nsw', 'qld', 'tas'], // ACT publishes real venue names
  operator: ['nsw', 'vic', 'qld', 'osm', 'tas'], // ACT publishes none; tas names the grantee
  network: ['nsw', 'vic', 'osm', 'qld'],
  lat: ['osm', 'nsw', 'vic', 'qld', 'act', 'tas'], // geocoded sources last; tas is town-level
  lng: ['osm', 'nsw', 'vic', 'qld', 'act', 'tas'],
  address: ['act', 'nsw', 'vic', 'qld', 'osm', 'tas'],
  connectors: ['vic', 'act', 'nsw', 'osm', 'qld'], // vic/act are structured
  plugCount: ['act', 'vic', 'nsw', 'osm', 'qld'], // ACT states bays explicitly
  maxPowerKw: ['vic', 'act', 'nsw', 'osm', 'qld'],
  status: ['nsw', 'qld', 'vic', 'osm', 'act', 'tas'], // act/tas are always unknown — last
  access: ['osm', 'act', 'nsw', 'vic', 'qld'],
  fee: ['osm', 'nsw', 'vic', 'qld', 'act'],
  openingHours: ['osm', 'nsw', 'vic', 'qld'],
  website: ['osm', 'nsw', 'vic', 'qld'],
};

/** Matching thresholds. Tuned against the NSW/OSM overlap; see docs/ARCHITECTURE.md. */
const MATCH = {
  /** Hard spatial ceiling: beyond this, never the same site. */
  maxDistanceM: 250,
  /** Below this distance, treat as same site unless names actively conflict. */
  certainDistanceM: 30,
  /** Bucket size for candidate generation; must be >= maxDistanceM. */
  cellMetres: 250,
  /** Minimum combined score to link two records. */
  scoreThreshold: 0.55,
  /** Name similarity above which names are considered agreeing. */
  nameAgree: 0.5,
  /** Name similarity below which names are considered actively conflicting. */
  nameConflict: 0.12,
};

/**
 * Does this record's `name` describe the PLACE, or just the charging network?
 *
 * Sources name different things. The ACT names venues ("Eastlake Football
 * Club"); OpenStreetMap elements without a name tag fall back to the operator
 * ("Evie Networks", "bp pulse", "Exploren"). Comparing across those two
 * vocabularies always scores near zero, so a naive matcher reads the mismatch
 * as evidence of two different sites — which rejected an ACT/OSM pair sitting
 * 0 metres apart.
 *
 * A name is treated as venue-descriptive unless the source flagged it as an
 * operator fallback, or it is simply the operator name repeated.
 */
function describesVenue(record) {
  if (!record.name) return false;
  if (record.nameFromOperator) return false;
  if (record.operator && nrm.operatorKey(record.name) === nrm.operatorKey(record.operator)) {
    return false;
  }
  return true;
}

/**
 * Score how likely two normalised records describe the same physical site.
 * Returns { score, distanceM, reasons } — reasons make the decision auditable.
 */
function scorePair(a, b, opts = {}) {
  const cfg = { ...MATCH, ...opts };
  const distanceM = geo.distanceMetres(a.lat, a.lng, b.lat, b.lng);
  const reasons = [];

  /**
   * A town-level coordinate is never evidence of identity.
   *
   * Tasmania's ChargeSmart list publishes only a town name, so its coordinates
   * are town centroids with kilometres of error. In a small town that centroid
   * can easily land within the 250 m matching ceiling of a real charger — and
   * merging on that basis would silently attach a funding record to whichever
   * unrelated charger happened to be nearest the town centre, and drag the
   * merged site's identity with it.
   *
   * Locality-precision records therefore stand alone, always. They remain
   * searchable ("is there a funded charger in Miena?") without ever claiming
   * to be a position.
   */
  if (nrm.isLocalityOnly(a) || nrm.isLocalityOnly(b)) {
    return {
      score: 0,
      distanceM,
      reasons: ['one side is known only to town level — a locality centroid cannot identify a site'],
    };
  }

  if (distanceM > cfg.maxDistanceM) {
    return { score: 0, distanceM, reasons: ['beyond max distance'] };
  }

  // Distance component: 1.0 at 0m, decaying to 0 at maxDistanceM.
  const distScore = 1 - distanceM / cfg.maxDistanceM;
  let score = distScore * 0.6;
  reasons.push(`distance ${distanceM.toFixed(0)}m (+${(distScore * 0.6).toFixed(2)})`);

  // Operator agreement is strong evidence either way.
  if (a.operator && b.operator) {
    if (a.operator === b.operator) {
      score += 0.25;
      reasons.push(`operator match "${a.operator}" (+0.25)`);
    } else {
      score -= 0.3;
      reasons.push(`operator conflict "${a.operator}" vs "${b.operator}" (-0.30)`);
    }
  }

  // Name similarity, only meaningful when both sides actually have a name.
  // 73% of TfNSW rows do not, which is why this cannot be the primary signal.
  const namesComparable = describesVenue(a) && describesVenue(b);
  if (a.name && b.name && namesComparable) {
    const sim = nrm.tokenSimilarity(a.name, b.name);
    if (sim >= cfg.nameAgree) {
      score += 0.2 * sim;
      reasons.push(`name sim ${sim.toFixed(2)} (+${(0.2 * sim).toFixed(2)})`);
    } else if (sim <= cfg.nameConflict) {
      score -= 0.15;
      reasons.push(`name conflict sim ${sim.toFixed(2)} (-0.15)`);
    }
  } else if (a.name && b.name) {
    reasons.push('names not comparable (one names the network, not the venue)');
  }

  /**
   * Two GEOCODED records need name evidence to be linked, no matter how close
   * they sit.
   *
   * Measured case: the ACT lists "Mawson Club" (10 Heard St) and "Southlands
   * Shopping Centre" (12 Heard St) as separate venues, and the geocoder
   * resolved both to the *identical* coordinate. Distance therefore carries no
   * information between two geocoded records — a 0 m separation may mean "same
   * site" or merely "the geocoder could not tell these apart". Requiring name
   * agreement keeps distinct venues distinct.
   */
  if (nrm.isGeocoded(a) && nrm.isGeocoded(b)) {
    const sim = a.name && b.name ? nrm.tokenSimilarity(a.name, b.name) : 0;
    if (sim < cfg.nameAgree) {
      return {
        score: 0,
        distanceM,
        reasons: [
          `both coordinates are geocoded and names disagree (sim ${sim.toFixed(2)}) — ` +
            'distance is not evidence between two geocoded records',
        ],
      };
    }
  }

  // Same postcode is weak corroboration; different postcode at <250m is common
  // near boundaries, so it is not penalised.
  if (a.address && b.address && a.address.postcode && b.address.postcode) {
    if (a.address.postcode === b.address.postcode) {
      score += 0.05;
      reasons.push('postcode match (+0.05)');
    }
  }

  // Very close together with no active conflict: accept regardless of sparse fields.
  if (distanceM <= cfg.certainDistanceM) {
    // Only a COMPARABLE name disagreement blocks the floor. Previously any
    // dissimilar name did, so a venue name vs an operator name kept two
    // records 0 m apart from ever merging.
    const nameConflicts =
      namesComparable && a.name && b.name && nrm.tokenSimilarity(a.name, b.name) <= cfg.nameConflict;
    const operatorConflicts = a.operator && b.operator && a.operator !== b.operator;
    if (!nameConflicts && !operatorConflicts) {
      score = Math.max(score, 0.8);
      reasons.push(`within ${cfg.certainDistanceM}m with no conflict (floor 0.80)`);
    }
  }

  return { score: Math.max(0, Math.min(1, score)), distanceM, reasons };
}

/**
 * Cluster normalised records into groups representing one physical site each.
 * Single-link union-find over pairs that score above threshold.
 *
 * @param {Array<object>} records normalised records (see sources/*.js)
 * @param {object} [opts]
 * @returns {{clusters: Array<Array<object>>, pairsConsidered: number, links: number}}
 */
function cluster(records, opts = {}) {
  const cfg = { ...MATCH, ...opts };
  const parent = records.map((_, i) => i);

  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    // path compression
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[ry] = rx;
  };

  // Spatial index: bucket -> record indices.
  const buckets = new Map();
  records.forEach((r, i) => {
    const key = geo.cellKey(r.lat, r.lng, cfg.cellMetres);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  });

  let pairsConsidered = 0;
  let links = 0;
  const seenPair = new Set();

  records.forEach((r, i) => {
    for (const key of geo.neighbourKeys(r.lat, r.lng, cfg.cellMetres)) {
      const bucket = buckets.get(key);
      if (!bucket) continue;
      for (const j of bucket) {
        if (j <= i) continue;
        const pairId = i * records.length + j;
        if (seenPair.has(pairId)) continue;
        seenPair.add(pairId);
        pairsConsidered++;
        const { score } = scorePair(r, records[j], cfg);
        if (score >= cfg.scoreThreshold) {
          union(i, j);
          links++;
        }
      }
    }
  });

  const groups = new Map();
  records.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  });

  return { clusters: Array.from(groups.values()), pairsConsidered, links };
}

/**
 * Pick a field value from a cluster according to per-field source trust,
 * recording where it came from and what was rejected.
 */
function pickField(field, members, fieldTrust) {
  const order = fieldTrust[field] || [];
  const candidates = members
    .map((m) => ({
      sourceId: m.sourceId,
      value: m[field],
      fetchedAt: m.fetchedAt,
      sourceRecordId: m.sourceRecordId,
    }))
    .filter((c) => c.value !== null && c.value !== undefined && c.value !== '');

  if (!candidates.length) return { value: null, provenance: null, conflicts: [] };

  const rank = (sourceId) => {
    const i = order.indexOf(sourceId);
    return i === -1 ? order.length + 1 : i;
  };

  const sorted = [...candidates].sort((a, b) => {
    const dr = rank(a.sourceId) - rank(b.sourceId);
    if (dr !== 0) return dr;
    // Tie-break on freshness, then on richer value.
    const df = String(b.fetchedAt || '').localeCompare(String(a.fetchedAt || ''));
    if (df !== 0) return df;
    return String(b.value).length - String(a.value).length;
  });

  const winner = sorted[0];
  const distinct = new Map();
  for (const c of candidates) {
    const k = JSON.stringify(c.value);
    if (!distinct.has(k)) distinct.set(k, c);
  }

  const conflicts =
    distinct.size > 1
      ? Array.from(distinct.values())
          .filter((c) => JSON.stringify(c.value) !== JSON.stringify(winner.value))
          .map((c) => ({ sourceId: c.sourceId, value: c.value }))
      : [];

  return {
    value: winner.value,
    provenance: {
      sourceId: winner.sourceId,
      sourceRecordId: winner.sourceRecordId,
      fetchedAt: winner.fetchedAt,
    },
    conflicts,
  };
}

/** Union connector lists across members, summing counts per standard. */
function mergeConnectors(members) {
  const byStandard = new Map();
  for (const m of members) {
    for (const c of m.connectors || []) {
      const key = c.standard;
      const prev = byStandard.get(key);
      if (!prev) {
        byStandard.set(key, {
          standard: key,
          count: c.count || null,
          powerKw: c.powerKw || null,
          sources: [m.sourceId],
        });
      } else {
        // Take the maximum asserted count and power — a source that knows
        // about more plugs is more likely to be complete than one that knows
        // about fewer, and under-reporting is the common failure.
        if ((c.count || 0) > (prev.count || 0)) prev.count = c.count;
        if ((c.powerKw || 0) > (prev.powerKw || 0)) prev.powerKw = c.powerKw;
        if (!prev.sources.includes(m.sourceId)) prev.sources.push(m.sourceId);
      }
    }
  }
  return Array.from(byStandard.values()).sort((a, b) => (b.powerKw || 0) - (a.powerKw || 0));
}

/**
 * Confidence score for a merged site, in [0,1].
 * Deliberately explainable: corroboration, completeness, and agreement.
 */
function computeConfidence(site, members, conflictCount) {
  let score = 0;
  // Corroboration: independent sources agreeing that a site exists here.
  const distinctSources = new Set(members.map((m) => m.sourceId));
  score += Math.min(distinctSources.size, 3) * 0.2; // up to 0.6

  // Completeness of the fields a driver actually needs.
  const needed = ['name', 'operator', 'maxPowerKw', 'address'];
  const present = needed.filter((f) => site[f] !== null && site[f] !== undefined).length;
  score += (present / needed.length) * 0.25;

  if (site.connectors && site.connectors.length) score += 0.15;

  // Penalise unresolved disagreement between sources.
  score -= Math.min(conflictCount, 4) * 0.05;

  /**
   * Penalise positional imprecision.
   *
   * Confidence is a claim about the record as a whole, and a site whose
   * coordinate is a town centroid several kilometres wide is materially less
   * trustworthy than one surveyed on the ground — even when its other fields
   * are complete. Without this, Tasmania's town-level grant rows scored the
   * same as a surveyed charger with identical field coverage.
   */
  const precision = nrm.positionPrecision(site);
  if (precision === nrm.POSITION_PRECISION.GEOCODED_ADDRESS) score -= 0.1;
  if (precision === nrm.POSITION_PRECISION.GEOCODED_LOCALITY) score -= 0.3;

  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

/**
 * Build a stable canonical ID for a site.
 *
 * Stability requirement: the ID must survive re-ingest, so it cannot be an
 * array index or a hash of the whole record (which changes when any field
 * changes). It is derived from rounded geography plus operator, both of which
 * are stable for a physical installation. A 4-decimal grid is ~11m.
 */
function canonicalId(lat, lng, operator) {
  const latKey = lat.toFixed(4).replace('-', 's').replace('.', '');
  const lngKey = lng.toFixed(4).replace('.', '');
  const opKey = nrm.slug(operator || 'unknown', 14) || 'unknown';
  return `au-${latKey}-${lngKey}-${opKey}`;
}

/**
 * Merge a cluster of source records into one canonical site.
 * @param {Array<object>} members
 * @param {object} [opts]
 */
function mergeCluster(members, opts = {}) {
  const fieldTrust = { ...DEFAULT_FIELD_TRUST, ...(opts.fieldTrust || {}) };
  const site = {};
  const provenance = {};
  const conflicts = {};

  const scalarFields = [
    'name',
    'operator',
    'network',
    'status',
    'access',
    'fee',
    'openingHours',
    'website',
    'plugCount',
    'maxPowerKw',
    'address',
  ];

  for (const field of scalarFields) {
    const picked = pickField(field, members, fieldTrust);
    site[field] = picked.value;
    if (picked.provenance) provenance[field] = picked.provenance;
    if (picked.conflicts.length) conflicts[field] = picked.conflicts;
  }

  // Geometry: prefer the most trusted source's coordinate rather than a
  // centroid. A centroid of two sources that disagree by 80m puts the pin in
  // the middle of a road, which is worse than being confidently at one of them.
  const latPick = pickField('lat', members, fieldTrust);
  const lngPick = pickField('lng', members, fieldTrust);
  site.lat = geo.roundCoord(latPick.value);
  site.lng = geo.roundCoord(lngPick.value);
  provenance.lat = latPick.provenance;
  provenance.lng = lngPick.provenance;

  // Report the spatial spread so the UI/QA can flag disagreeing sources.
  let maxSpreadM = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      maxSpreadM = Math.max(
        maxSpreadM,
        geo.distanceMetres(members[i].lat, members[i].lng, members[j].lat, members[j].lng)
      );
    }
  }

  /**
   * Positional precision of the merged site = the BEST precision among its
   * members, because `lat`/`lng` were picked from the most-trusted source and
   * the trust order puts surveyed sources above geocoded ones. Recording it
   * lets every surface decide whether the pin is good enough to show.
   */
  const precedence = [
    nrm.POSITION_PRECISION.SURVEYED,
    nrm.POSITION_PRECISION.GEOCODED_ADDRESS,
    nrm.POSITION_PRECISION.GEOCODED_LOCALITY,
  ];
  site.positionPrecision = members
    .map((m) => nrm.positionPrecision(m))
    .sort((x, y) => precedence.indexOf(x) - precedence.indexOf(y))[0];
  site.positionErrorMetres = nrm.PRECISION_ERROR_METRES[site.positionPrecision] || null;
  site.geocoded = site.positionPrecision !== nrm.POSITION_PRECISION.SURVEYED;

  site.connectors = mergeConnectors(members);

  // Derived fields — computed once here so every surface agrees.
  if (!site.maxPowerKw && site.connectors.length) {
    const fromConnectors = site.connectors.reduce((a, c) => Math.max(a, c.powerKw || 0), 0);
    site.maxPowerKw = fromConnectors || null;
  }
  site.speedBand = nrm.speedBand(site.maxPowerKw);
  site.state =
    (site.address && site.address.state) || geo.stateFromLatLng(site.lat, site.lng) || null;

  /**
   * Derived display name.
   *
   * Measured need: 73% of TfNSW rows carry no Station_name, and OSM often has
   * none either, so a large share of merged sites have `name === null`. Every
   * surface would otherwise have to invent its own fallback (and the API was
   * literally returning "null" as a site name). Deriving it once here keeps
   * the CLI, API and web page consistent.
   *
   * `name` is left untouched so consumers can still distinguish a published
   * name from one we constructed; `nameIsDerived` records which it is.
   */
  const suburb = (site.address && (site.address.suburb || site.address.street)) || null;
  if (site.name) {
    site.displayName = site.name;
    site.nameIsDerived = false;
  } else {
    const parts = [];
    if (site.operator && site.operator !== 'Non-networked') parts.push(site.operator);
    if (suburb) parts.push(suburb);
    site.displayName = parts.length
      ? parts.join(' — ')
      : suburb
        ? `Charging site, ${suburb}`
        : `Charging site (${site.state || 'AU'})`;
    site.nameIsDerived = true;
  }
  if (!site.status || site.status === 'unknown') site.status = 'unknown';

  site.id = canonicalId(site.lat, site.lng, site.operator);
  site.sources = members
    .map((m) => ({
      sourceId: m.sourceId,
      sourceRecordId: m.sourceRecordId,
      fetchedAt: m.fetchedAt,
      url: m.sourceUrl || null,
    }))
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  site.sourceCount = new Set(members.map((m) => m.sourceId)).size;
  site.provenance = provenance;
  site.conflicts = conflicts;
  site.spatialSpreadM = Math.round(maxSpreadM);
  // Computed last: it reads site.positionPrecision, which is set above.
  site.confidence = computeConfidence(site, members, Object.keys(conflicts).length);

  return site;
}

/**
 * Full resolve: cluster then merge.
 * @param {Array<object>} records
 * @param {object} [opts]
 * @returns {{sites: Array<object>, stats: object}}
 */
function resolve(records, opts = {}) {
  const usable = records.filter((r) => geo.isValidLatLng(r.lat, r.lng));
  const rejected = records.length - usable.length;

  const { clusters, pairsConsidered, links } = cluster(usable, opts);
  const sites = clusters.map((members) => mergeCluster(members, opts));

  // Stable output order so diffs between runs are meaningful.
  sites.sort((a, b) => a.id.localeCompare(b.id));

  // Guard against ID collisions (two distinct sites landing on the same key).
  const idCounts = new Map();
  for (const s of sites) idCounts.set(s.id, (idCounts.get(s.id) || 0) + 1);
  let collisionsResolved = 0;
  const used = new Set();
  for (const s of sites) {
    if (used.has(s.id)) {
      let n = 2;
      while (used.has(`${s.id}-${n}`)) n++;
      s.id = `${s.id}-${n}`;
      collisionsResolved++;
    }
    used.add(s.id);
  }

  const stats = {
    inputRecords: records.length,
    rejectedInvalidCoords: rejected,
    sites: sites.length,
    merged: usable.length - sites.length,
    multiSourceSites: sites.filter((s) => s.sourceCount > 1).length,
    sitesWithConflicts: sites.filter((s) => Object.keys(s.conflicts).length > 0).length,
    pairsConsidered,
    links,
    collisionsResolved,
  };

  return { sites, stats };
}

module.exports = {
  DEFAULT_FIELD_TRUST,
  describesVenue,
  MATCH,
  canonicalId,
  cluster,
  computeConfidence,
  mergeCluster,
  mergeConnectors,
  pickField,
  resolve,
  scorePair,
};
