'use strict';
/**
 * Ingest pipeline: fetch -> normalise -> resolve -> dataset artefact.
 *
 * This module is the single source of truth. The CLI, the HTTP API and the
 * generated web page all consume the artefact it produces; none of them
 * re-implement normalisation, matching or search.
 */

const fs = require('fs');
const path = require('path');

const fetchLayer = require('./fetch');
const registry = require('./sources');
const resolver = require('./core/resolve');
const geocoder = require('./geocode');
const geo = require('./core/geo');
const nrm = require('./core/normalise');

const DATASET_PATH = path.join(__dirname, '..', 'data', 'cache', 'dataset.json');
const REPORT_PATH = path.join(__dirname, '..', 'data', 'cache', 'ingest-report.json');

/**
 * Freshness policy, expressed per FIELD rather than per record.
 *
 * The reasoning, which is the core thesis of the architecture: a charging
 * site's coordinates essentially never change once built, while its pricing
 * and opening hours change often. Applying one global TTL either wastes fetch
 * budget on stable fields or serves stale values for volatile ones. The UI
 * uses these budgets to decide what to label as possibly-outdated.
 *
 * Values are in days.
 */
const FIELD_FRESHNESS_BUDGET_DAYS = {
  lat: 3650, // a built charger does not move
  lng: 3650,
  name: 365,
  operator: 180, // networks get acquired (BP/Chargefox consolidation)
  network: 180,
  address: 730,
  connectors: 180, // hardware upgrades happen
  plugCount: 180,
  maxPowerKw: 180,
  status: 30, // sites open and close; the most volatile field we carry
  access: 180,
  fee: 30, // volatile, and we mostly do not have it at all
  openingHours: 90,
  website: 365,
};

/**
 * Drift thresholds for the `drift` command. A source that silently changes
 * shape is the most common way an aggregation pipeline rots: the fetch keeps
 * returning HTTP 200 while the content becomes useless.
 */
const DRIFT_LIMITS = {
  /** Fractional change in record count that is treated as suspicious. */
  recordCountWarnFraction: 0.1,
  recordCountFailFraction: 0.35,
  /** A source dropping to zero records is always a failure. */
  failOnZero: true,
  /**
   * Issue-rate handling.
   *
   * An ABSOLUTE threshold is the wrong primary signal here. TfNSW legitimately
   * runs at roughly a 32% issue rate every single run, because 522 of its rows
   * state a current type ("AC") where a power rating belongs. That is a
   * permanent property of the dataset, not drift — alerting on it every run
   * trains the operator to ignore the alert.
   *
   * So drift is measured as a RISE in the issue rate against the previous run,
   * and the absolute ceiling is reserved for catastrophic change (a source
   * whose schema moved so far that most records no longer normalise).
   */
  issueRateRiseWarn: 0.1,
  issueRateRiseFail: 0.25,
  issueRateAbsoluteFail: 0.75,
};

/**
 * Run every request for a source, following any `then` chains.
 * @returns {Promise<{payloads: Array, fetchMeta: Array}>}
 */
async function fetchSource(source, opts) {
  const log = opts.log || (() => {});
  const ctx = { apiKey: opts.apiKeys && opts.apiKeys[source.id] };
  let queue = source.requests(ctx) || [];
  const payloads = [];
  const fetchMeta = [];

  if (!queue.length) {
    log(`  · ${source.id}: no requests configured (missing API key?) — skipped`);
    return { payloads, fetchMeta, skipped: true };
  }

  while (queue.length) {
    const req = queue.shift();
    const result = await fetchLayer.retrieve(req, opts);
    fetchMeta.push({ key: req.key, ...result.meta });

    if (typeof req.then === 'function') {
      // Metadata request: follow it to the real data request.
      const next = req.then(result.parsed !== null ? result.parsed : result.text);
      queue = queue.concat(next || []);
      continue;
    }
    payloads.push({
      req,
      raw: req.format === 'json' ? result.parsed : result.text,
      fromCache: result.fromCache,
      meta: result.meta,
    });
  }

  return { payloads, fetchMeta, skipped: false };
}

/**
 * Ingest all selected sources and resolve them into canonical sites.
 *
 * @param {object} opts
 *   sources: string[]|null   source ids, null = defaults
 *   offline: boolean         rebuild from data/raw without network
 *   log: function
 *   includePlanned: boolean  keep planned/unbuilt sites in the artefact
 * @returns {Promise<{dataset: object, report: object}>}
 */
async function ingest(opts = {}) {
  const log = opts.log || (() => {});
  const sources = registry.select(opts.sources);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const allRecords = [];
  const perSource = [];
  const allIssues = [];
  const geocodeStats = {};

  for (const source of sources) {
    log(`\n[${source.id}] ${source.meta.name}`);
    const sourceStart = Date.now();
    let records = [];
    let issues = [];
    let error = null;
    let skipped = false;
    let fetchMeta = [];

    try {
      const fetched = await fetchSource(source, opts);
      fetchMeta = fetched.fetchMeta;
      skipped = fetched.skipped;

      for (const payload of fetched.payloads) {
        const fetchedAt = (payload.meta && payload.meta.fetchedAt) || startedAt;

        /**
         * Geocoding pass, for sources that publish addresses instead of
         * coordinates (currently only the ACT).
         *
         * Done here, before normalise(), so the whole address list is warmed
         * in one throttled batch rather than the adapter making ad-hoc
         * requests mid-parse. Results are cached on disk permanently, so this
         * is a no-op on every run after the first, and `--offline` never
         * reaches the network.
         */
        if (source.meta.requiresGeocoding && typeof source.addressesToGeocode === 'function') {
          const addresses = source.addressesToGeocode(payload.raw);
          if (addresses.length) {
            const geo = await geocoder.geocodeAll(addresses, {
              region: source.meta.geocodeRegion,
              offline: !!opts.offline,
              log,
            });
            geocodeStats[source.id] = geo.stats;
            log(
              `  geocode: ${geo.stats.requested} addresses — ${geo.stats.fromCache} cached, ` +
                `${geo.stats.fetched} fetched, ${geo.stats.failed} unresolved`
            );
          }
        }

        const out = source.normalise(payload.raw, { fetchedAt });
        records = records.concat(out.records);
        issues = issues.concat(out.issues || []);
      }
    } catch (err) {
      error = err.message;
      log(`  ✗ ${source.id}: ${err.message}`);
    }

    if (!error && !skipped) {
      log(
        `  ${records.length} records normalised, ${issues.length} issues ` +
          `(${Date.now() - sourceStart}ms)`
      );
    }

    allRecords.push(...records);
    allIssues.push(...issues.map((i) => ({ ...i, sourceId: source.id })));
    perSource.push({
      sourceId: source.id,
      name: source.meta.name,
      jurisdiction: source.meta.jurisdiction,
      licence: source.meta.licence,
      licenceUrl: source.meta.licenceUrl,
      attribution: source.meta.attribution,
      shareAlike: !!source.meta.shareAlike,
      homepage: source.meta.homepage,
      changeCadence: source.meta.changeCadence,
      recommendedRefresh: source.meta.recommendedRefresh,
      coverageCaveat: source.meta.coverageCaveat || null,
      recordCount: records.length,
      issueCount: issues.length,
      issueRate: records.length ? Number((issues.length / records.length).toFixed(4)) : 0,
      /**
       * Structural issue rate — the drift signal.
       *
       * Only issues that indicate the DATA SHAPE changed count here:
       * `rejected` (record unusable) and `parse_failure` (a field no longer
       * parses). Excluded are `data_gap` (upstream simply does not publish the
       * field), `status_flag` (a planned site, which is information not error)
       * and `policy` (a record we deliberately skipped for licensing).
       *
       * Why this matters concretely: every one of QLD's 17 records raises
       * "plug count column empty", giving a 100% raw issue rate forever. Using
       * the raw rate, QLD failed the drift check on every single run — a
       * permanent false alarm. Its structural rate is 0%.
       */
      structuralIssueCount: issues.filter(
        (i) => i.kind === 'rejected' || i.kind === 'parse_failure'
      ).length,
      structuralIssueRate: records.length
        ? Number(
            (
              issues.filter((i) => i.kind === 'rejected' || i.kind === 'parse_failure').length /
              records.length
            ).toFixed(4)
          )
        : 0,
      issueKinds: issues.reduce((acc, i) => {
        const k = i.kind || 'unclassified';
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
      plannedCount: records.filter((r) => r.status === 'planned').length,
      error,
      skipped,
      fetch: fetchMeta,
      fetchedAt:
        (fetchMeta.find((m) => m.fetchedAt) || {}).fetchedAt || (error ? null : startedAt),
      /**
       * Which URL actually served the data. Recorded because a fallback to a
       * secondary mirror correlates with degraded data — see the incident
       * documented in src/sources/osm.js. Drift reports a change here.
       */
      servedFrom: (fetchMeta.filter((m) => m.url).map((m) => m.url).pop()) || null,
      geocoding: geocodeStats[source.id] || null,
      staleFallback: fetchMeta.some((m) => m.staleFallback),
    });
  }

  log(`\nResolving ${allRecords.length} records into canonical sites…`);
  const { sites, stats } = resolver.resolve(allRecords, opts.matching || {});

  // Planned/unbuilt sites are retained in the artefact but flagged, so the
  // default map view can exclude them while the data stays available.
  const plannedSites = sites.filter((s) => s.status === 'planned').length;
  const kept = opts.includePlanned === false ? sites.filter((s) => s.status !== 'planned') : sites;

  const dataset = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    generator: 'ev-charge-map-au ingest',
    /** Everything a consumer needs to comply with the source licences. */
    /**
     * Attribution. A geocoding source adds Nominatim's ODbL attribution,
     * because its coordinates are OpenStreetMap-derived and that obligation
     * travels with the data.
     */
    attribution: (() => {
      const list = registry.attributions(sources);
      if (sources.some((s) => s.meta.requiresGeocoding) && Object.keys(geocodeStats).length) {
        list.push(geocoder.ATTRIBUTION);
      }
      return list;
    })(),
    /**
     * ODbL note carried in the data itself. Because we ingest OSM into our own
     * store, this artefact is an ODbL "Derivative Database", not merely a
     * "Produced Work" — share-alike applies and the artefact must be
     * offerable under ODbL. See docs/DATA_SOURCES.md.
     */
    licence: {
      effective: 'ODbL 1.0 (share-alike inherited from OpenStreetMap)',
      reason:
        'This artefact is a Derivative Database of OpenStreetMap data, so ODbL share-alike applies to the database as a whole.',
      note: 'Individual source records remain under their own licences, listed in attribution[].',
    },
    freshnessBudgetDays: FIELD_FRESHNESS_BUDGET_DAYS,
    sources: perSource,
    counts: {
      sourceRecords: allRecords.length,
      sites: kept.length,
      sitesIncludingPlanned: sites.length,
      plannedSites,
      ...stats,
    },
    sites: kept,
  };

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    offline: !!opts.offline,
    sources: perSource,
    resolution: stats,
    coverage: coverageSummary(kept),
    geocoding: { perSource: geocodeStats, cache: geocoder.cacheStats() },
    issues: allIssues,
    issueSummary: summariseIssues(allIssues),
  };

  log(
    `\n${allRecords.length} source records -> ${kept.length} canonical sites ` +
      `(${stats.merged} merged, ${stats.multiSourceSites} corroborated by 2+ sources)`
  );

  return { dataset, report };
}

/** Group issues by source and message shape for a readable summary. */
function summariseIssues(issues) {
  const byKey = new Map();
  for (const i of issues) {
    // Collapse the variable part of messages so counts are meaningful.
    const shape = String(i.issue)
      .replace(/"[^"]*"/g, '"…"')
      .replace(/\(-?[\d.,\s]+\)/g, '(…)');
    const key = `${i.sourceId}: ${shape}`;
    byKey.set(key, (byKey.get(key) || 0) + 1);
  }
  return Array.from(byKey.entries())
    .map(([issue, count]) => ({ issue, count }))
    .sort((a, b) => b.count - a.count);
}

/** Aggregate stats used by the CLI `stats` command and the web page footer. */
function coverageSummary(sites) {
  const byState = {};
  const byPrecision = {};
  const byOperator = {};
  const bySpeed = {};
  const byStatus = {};
  const bySourceCount = {};
  let withPower = 0;
  let withConnectors = 0;
  let withName = 0;
  let plugTotal = 0;

  for (const s of sites) {
    const st = s.state || 'unknown';
    byState[st] = (byState[st] || 0) + 1;
    const prec = nrm.positionPrecision(s);
    byPrecision[prec] = (byPrecision[prec] || 0) + 1;
    const op = s.operator || 'unknown';
    byOperator[op] = (byOperator[op] || 0) + 1;
    bySpeed[s.speedBand] = (bySpeed[s.speedBand] || 0) + 1;
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    bySourceCount[s.sourceCount] = (bySourceCount[s.sourceCount] || 0) + 1;
    if (s.maxPowerKw) withPower++;
    if (s.connectors && s.connectors.length) withConnectors++;
    if (s.name) withName++;
    if (Number.isFinite(s.plugCount)) plugTotal += s.plugCount;
  }

  const total = sites.length || 1;
  return {
    sites: sites.length,
    /**
     * Sites precise enough to place on a map. The difference from `sites` is
     * the town-level records, which are searchable but not mappable — reporting
     * only the total would overstate what the map can actually show.
     */
    mappableSites: sites.filter((s) => nrm.isMappable(s)).length,
    approximateSites: sites.filter((s) => !nrm.isMappable(s)).length,
    estimatedPlugs: plugTotal,
    byState,
    byPrecision,
    byStatus,
    bySpeed,
    bySourceCount,
    topOperators: Object.entries(byOperator)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([operator, count]) => ({ operator, count })),
    completeness: {
      withName: Number((withName / total).toFixed(4)),
      withPower: Number((withPower / total).toFixed(4)),
      withConnectors: Number((withConnectors / total).toFixed(4)),
    },
  };
}

/**
 * Compare a fresh ingest report against the previously saved one and classify
 * each source as ok / warn / fail. Exit-code mapping lives in the CLI.
 */
function detectDrift(previousReport, currentReport, limits = DRIFT_LIMITS) {
  const findings = [];
  const prevBySource = new Map(
    ((previousReport && previousReport.sources) || []).map((s) => [s.sourceId, s])
  );

  for (const cur of currentReport.sources) {
    const prev = prevBySource.get(cur.sourceId);

    if (cur.error) {
      findings.push({
        sourceId: cur.sourceId,
        level: 'fail',
        message: `fetch/normalise error: ${cur.error}`,
      });
      continue;
    }
    if (cur.skipped) {
      findings.push({
        sourceId: cur.sourceId,
        level: 'ok',
        message: 'skipped (not configured)',
      });
      continue;
    }
    if (limits.failOnZero && cur.recordCount === 0) {
      findings.push({
        sourceId: cur.sourceId,
        level: 'fail',
        message: 'returned zero records — treated as a failure, not a change',
      });
      continue;
    }

    /**
     * Use the STRUCTURAL issue rate, not the raw one. See the field's
     * definition in ingest() for why: a permanently incomplete upstream field
     * would otherwise fail the drift check on every run.
     * Older reports predate the field, so fall back to the raw rate.
     */
    const curRate = Number.isFinite(cur.structuralIssueRate)
      ? cur.structuralIssueRate
      : cur.issueRate;
    const prevRate =
      prev && Number.isFinite(prev.structuralIssueRate)
        ? prev.structuralIssueRate
        : prev
          ? prev.issueRate
          : null;

    // Absolute ceiling: only for catastrophic breakage.
    if (curRate >= limits.issueRateAbsoluteFail) {
      findings.push({
        sourceId: cur.sourceId,
        level: 'fail',
        message: `${(curRate * 100).toFixed(1)}% of records failed to parse (schema change?)`,
      });
    } else if (prevRate !== null) {
      // Primary signal: has the structural issue rate RISEN since the last run?
      const rise = curRate - prevRate;
      if (rise >= limits.issueRateRiseFail) {
        findings.push({
          sourceId: cur.sourceId,
          level: 'fail',
          message:
            `parse-failure rate rose ${(rise * 100).toFixed(1)} points ` +
            `(${(prevRate * 100).toFixed(1)}% -> ${(curRate * 100).toFixed(1)}%) — likely schema change`,
        });
      } else if (rise >= limits.issueRateRiseWarn) {
        findings.push({
          sourceId: cur.sourceId,
          level: 'warn',
          message:
            `parse-failure rate rose ${(rise * 100).toFixed(1)} points ` +
            `(${(prevRate * 100).toFixed(1)}% -> ${(curRate * 100).toFixed(1)}%)`,
        });
      }
    }

    if (cur.staleFallback) {
      findings.push({
        sourceId: cur.sourceId,
        level: 'warn',
        message: 'all endpoints failed; served from a stale local cache',
      });
    }

    if (prev && prev.servedFrom && cur.servedFrom && prev.servedFrom !== cur.servedFrom) {
      findings.push({
        sourceId: cur.sourceId,
        level: 'warn',
        message: `served from a different endpoint than last run (${cur.servedFrom}) — check for a degraded mirror`,
      });
    }

    if (prev && prev.recordCount > 0) {
      const delta = (cur.recordCount - prev.recordCount) / prev.recordCount;
      const pct = (delta * 100).toFixed(1);
      if (Math.abs(delta) >= limits.recordCountFailFraction) {
        findings.push({
          sourceId: cur.sourceId,
          level: 'fail',
          message: `record count moved ${pct}% (${prev.recordCount} -> ${cur.recordCount})`,
        });
      } else if (Math.abs(delta) >= limits.recordCountWarnFraction) {
        findings.push({
          sourceId: cur.sourceId,
          level: 'warn',
          message: `record count moved ${pct}% (${prev.recordCount} -> ${cur.recordCount})`,
        });
      }
    } else if (!prev) {
      findings.push({
        sourceId: cur.sourceId,
        level: 'ok',
        message: `new source, baseline ${cur.recordCount} records`,
      });
    }

    if (!findings.some((f) => f.sourceId === cur.sourceId)) {
      findings.push({
        sourceId: cur.sourceId,
        level: 'ok',
        message: `${cur.recordCount} records, ${(curRate * 100).toFixed(1)}% parse-failure rate`,
      });
    }
  }

  const worst = findings.some((f) => f.level === 'fail')
    ? 'fail'
    : findings.some((f) => f.level === 'warn')
      ? 'warn'
      : 'ok';

  return { level: worst, findings };
}

/**
 * Age of a field's value in days, against its freshness budget.
 * Used by the API and web page to label values as possibly outdated.
 */
function fieldStaleness(site, field, now = Date.now()) {
  const prov = site.provenance && site.provenance[field];
  if (!prov || !prov.fetchedAt) return null;
  const ageDays = (now - Date.parse(prov.fetchedAt)) / 86400000;
  const budget = FIELD_FRESHNESS_BUDGET_DAYS[field];
  if (!Number.isFinite(ageDays) || !budget) return null;
  return {
    field,
    ageDays: Number(ageDays.toFixed(2)),
    budgetDays: budget,
    stale: ageDays > budget,
    sourceId: prov.sourceId,
  };
}

function saveDataset(dataset, targetPath = DATASET_PATH) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(dataset));
  return targetPath;
}

function saveReport(report, targetPath = REPORT_PATH) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(report, null, 2) + '\n');
  return targetPath;
}

function loadDataset(targetPath = DATASET_PATH) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(
      `No dataset at ${targetPath}. Run \`node bin/evmap.js ingest\` (or \`ingest --offline\`) first.`
    );
  }
  return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
}

function loadReport(targetPath = REPORT_PATH) {
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  DATASET_PATH,
  DRIFT_LIMITS,
  FIELD_FRESHNESS_BUDGET_DAYS,
  REPORT_PATH,
  coverageSummary,
  detectDrift,
  fieldStaleness,
  ingest,
  loadDataset,
  loadReport,
  saveDataset,
  saveReport,
  summariseIssues,
  geo,
};
