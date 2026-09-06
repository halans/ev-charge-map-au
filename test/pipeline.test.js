'use strict';
/**
 * Pipeline, fetch-layer and CLI tests.
 *
 * These cover the parts that keep the dataset trustworthy over time: offline
 * rebuilds, checksum tracking, secret redaction, drift classification and the
 * CLI's exit-code contract.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { assert, describe, it } = require('./harness');

const pipeline = require('../src/pipeline');
const fetchLayer = require('../src/fetch');
const geocoder = require('../src/geocode');
const cli = require('../bin/evmap');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'evmap.js');

/** Run the CLI and capture stdout + exit code without throwing. */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // The GeoJSON export of 3,000 sites is several MB; the 1MB default
      // maxBuffer truncated it and produced a bogus JSON parse failure.
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

module.exports = async function run() {
  /**
   * Pre-computed ingests, awaited before any synchronous it() runs.
   */
  const haveCache = fs.existsSync(path.join(fetchLayer.RAW_DIR, 'osm-au-chargers.json'));
  const PRE = { dataset: null, report: null, excluded: null, second: null };
  if (haveCache) {
    const first = await pipeline.ingest({ offline: true, log: () => {} });
    PRE.dataset = first.dataset;
    PRE.report = first.report;
    PRE.excluded = (await pipeline.ingest({ offline: true, includePlanned: false, log: () => {} })).dataset;
    PRE.second = (await pipeline.ingest({ offline: true, log: () => {} })).dataset;
  }

  /* ------------------------------------------------------------------ */
  describe('fetch layer', () => {
    it('redacts API keys from URLs before they are logged or stored', () => {
      const url = 'https://api.openchargemap.io/v3/poi?countrycode=AU&key=super-secret-123';
      const safe = fetchLayer.redactUrl(url, ['super-secret-123']);
      assert.notOk(safe.includes('super-secret-123'), 'declared secret must be removed');
      assert.includes(safe, 'REDACTED');
    });

    it('redacts common key parameters even when not declared', () => {
      const safe = fetchLayer.redactUrl('https://x.test/a?api_key=abc&token=def');
      assert.notOk(safe.includes('abc'));
      assert.notOk(safe.includes('def'));
    });

    it('REGRESSION: sends an explicit Accept header (Overpass 406s without one)', () => {
      assert.ok(fetchLayer.DEFAULT_ACCEPT, 'a default Accept header must be defined');
      assert.includes(fetchLayer.DEFAULT_ACCEPT, 'application/json');
      // The parenthesised URL in the old agent string was the 406 trigger.
      assert.notOk(/[()]/.test(fetchLayer.DEFAULT_USER_AGENT), 'UA must not contain parentheses');
    });

    it('computes stable sha256 digests', () => {
      const a = fetchLayer.sha256(Buffer.from('hello'));
      const b = fetchLayer.sha256(Buffer.from('hello'));
      assert.equal(a, b);
      assert.equal(a.length, 64);
      assert.notEqual(a, fetchLayer.sha256(Buffer.from('hello!')));
    });

    it('records a checksum and byte count for every cached file', () => {
      const manifest = fetchLayer.readManifest();
      const keys = Object.keys(manifest.entries);
      if (!keys.length) return 'skip';
      for (const key of keys) {
        const entry = manifest.entries[key];
        assert.ok(entry.sha256, `${key} missing sha256`);
        assert.equal(entry.sha256.length, 64, `${key} bad digest length`);
        assert.greaterThan(entry.bytes, 0, `${key} zero bytes`);
        assert.ok(entry.fetchedAt, `${key} missing fetchedAt`);
      }
    });

    it('manifest checksums match the files actually on disk (self-verifying cache)', () => {
      const manifest = fetchLayer.readManifest();
      const keys = Object.keys(manifest.entries);
      if (!keys.length) return 'skip';
      for (const key of keys) {
        const file = path.join(fetchLayer.RAW_DIR, key);
        if (!fs.existsSync(file)) continue;
        const actual = fetchLayer.sha256(fs.readFileSync(file));
        assert.equal(
          actual,
          manifest.entries[key].sha256,
          `${key} on disk does not match the manifest checksum`
        );
      }
    });

    it('offline mode fails loudly when a cached file is missing', async () => {
      let threw = false;
      try {
        await fetchLayer.retrieve(
          { key: 'definitely-not-cached.json', urls: ['https://x.test/a'], format: 'json' },
          { offline: true }
        );
      } catch (err) {
        threw = true;
        assert.includes(err.message, 'offline');
      }
      assert.ok(threw, 'expected an explicit failure, not a silent empty result');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('geocoder', () => {
    it('uses an ODbL geocoder, so the output licence is unchanged', () => {
      // A commercial geocoder would add terms that forbid storing or
      // redisplaying coordinates — incompatible with redistributing this data.
      assert.includes(geocoder.ATTRIBUTION.licence, 'ODbL');
      assert.includes(geocoder.ENDPOINT, 'nominatim');
      assert.equal(geocoder.ATTRIBUTION.shareAlike, true);
    });

    it('throttles to at most one request per second, per Nominatim policy', () => {
      assert.atLeast(geocoder.MIN_INTERVAL_MS, 1000);
    });

    it('sends an identifying User-Agent, which the policy requires', () => {
      assert.includes(geocoder.USER_AGENT, 'ev-charge-map-au');
    });

    it('normalises cache keys so trivial formatting differences share an entry', () => {
      assert.equal(
        geocoder.cacheKey('39 Benjamin Way, Belconnen'),
        geocoder.cacheKey('39  benjamin way,   BELCONNEN')
      );
    });

    it('builds fallback query variants, most specific first', () => {
      const v = geocoder.queryVariants('Sentinel Apartments 39 Benjamin Way, Belconnen', 'ACT, Australia');
      assert.atLeast(v.length, 2);
      assert.includes(v[0], 'Sentinel Apartments');
      // A later variant drops the venue prefix and starts at the house number.
      assert.ok(v.some((x) => x.startsWith('39 Benjamin Way')), 'expected a street-only variant');
      assert.ok(v.every((x) => x.includes('ACT, Australia')), 'region must be appended');
    });

    it('ships a populated cache, so offline rebuilds need no network', () => {
      const stats = geocoder.cacheStats();
      assert.atLeast(stats.total, 30, 'the committed geocode cache should cover the ACT rows');
      assert.atLeast(stats.resolved, 30);
    });

    it('records unresolved addresses rather than dropping them silently', () => {
      const stats = geocoder.cacheStats();
      assert.equal(stats.total, stats.resolved + stats.unresolved);
    });

    it('returns undefined for an address never queried, null for one that failed', () => {
      // The distinction matters: undefined means "run an ingest", null means
      // "already tried, no coordinate exists".
      assert.equal(geocoder.fromCache('nowhere at all, atlantis ' + Date.now()), undefined);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('pipeline: offline ingest against the shipped cache', () => {
    const cached = fs.existsSync(path.join(fetchLayer.RAW_DIR, 'osm-au-chargers.json'));
    if (!cached) {
      it('skipped: no cached raw data', () => 'skip');
      return;
    }

    // Ingest ONCE, before the synchronous it() blocks run, so every assertion
    // below sees a populated dataset. (The harness's it() is synchronous by
    // design; awaiting inside it would leave these variables undefined.)
    const dataset = PRE.dataset;
    const report = PRE.report;

    it('rebuilds the whole dataset with no network access', () => {
      assert.atLeast(dataset.sites.length, 2500, 'expected a national dataset');
      assert.equal(report.offline, true);
    });

    it('reports no source errors on the shipped cache', () => {
      const errored = report.sources.filter((s) => s.error);
      assert.deepEqual(errored.map((s) => s.sourceId), [], 'all cached sources must rebuild');
    });

    it('merges duplicate records across sources', () => {
      assert.greaterThan(dataset.counts.merged, 100, 'expected real cross-source merging');
      assert.greaterThan(dataset.counts.multiSourceSites, 100, 'expected corroborated sites');
    });

    it('produces fewer sites than source records (deduplication happened)', () => {
      assert.ok(
        dataset.counts.sites < dataset.counts.sourceRecords,
        'site count must be below raw record count'
      );
    });

    it('assigns a unique id to every site', () => {
      const ids = new Set(dataset.sites.map((s) => s.id));
      assert.equal(ids.size, dataset.sites.length);
    });

    it('is deterministic: two runs produce identical output', () => {
      assert.deepEqual(
        PRE.second.sites.map((s) => s.id),
        dataset.sites.map((s) => s.id),
        'ingest must be reproducible'
      );
    });

    it('carries the ODbL effective licence, inherited from OSM', () => {
      assert.includes(dataset.licence.effective, 'ODbL');
      assert.includes(dataset.licence.reason, 'Derivative Database');
    });

    it('lists attribution for every contributing source', () => {
      assert.atLeast(dataset.attribution.length, 4);
      for (const a of dataset.attribution) {
        assert.ok(a.text && a.licence && a.licenceUrl);
      }
    });

    it('flags planned sites without dropping them by default', () => {
      assert.greaterThan(dataset.counts.plannedSites, 0);
      assert.ok(dataset.sites.some((s) => s.status === 'planned'));
    });

    it('honours --exclude-planned', () => {
      assert.notOk(PRE.excluded.sites.some((s) => s.status === 'planned'));
      assert.ok(PRE.excluded.sites.length < dataset.sites.length);
    });

    it('every site has a usable display name', () => {
      const nameless = dataset.sites.filter((s) => !s.displayName);
      assert.equal(nameless.length, 0, `${nameless.length} sites would render as blank`);
    });

    it('every site has a valid Australian coordinate and a state', () => {
      const bad = dataset.sites.filter(
        (s) => !pipeline.geo.isInAustralia(s.lat, s.lng) || !s.state
      );
      assert.equal(bad.length, 0);
    });

    it('reports geocoding activity and the ACT source', () => {
      assert.ok(report.geocoding, 'report must carry geocoding state');
      assert.atLeast(report.geocoding.cache.resolved, 30);
      const act = report.sources.find((x) => x.sourceId === 'act');
      assert.ok(act, 'ACT must be an enabled source');
      assert.atLeast(act.recordCount, 30);
      assert.ok(act.geocoding, 'ACT must report its geocoding stats');
      assert.equal(act.geocoding.fetched, 0, 'an offline run must fetch nothing');
    });

    it('credits Nominatim when a geocoded source contributed', () => {
      assert.ok(
        dataset.attribution.some((a) => a.sourceId === 'nominatim'),
        'geocoded coordinates are OSM-derived and must be attributed'
      );
    });

    it('classifies every issue with a kind, so drift can ignore data gaps', () => {
      const unclassified = report.issues.filter((i) => !i.kind);
      assert.equal(unclassified.length, 0, `${unclassified.length} issues lack a kind`);
      const qld = report.sources.find((x) => x.sourceId === 'qld');
      if (qld) {
        assert.equal(qld.structuralIssueRate, 0, 'QLD gaps must not read as parse failures');
        assert.greaterThan(qld.issueRate, 0.5, 'but its raw issue rate is high');
      }
    });

    it('summarises issues by shape rather than dumping every one', () => {
      assert.ok(Array.isArray(report.issueSummary));
      if (report.issueSummary.length) {
        assert.ok(report.issueSummary[0].count >= 1);
        assert.ok(typeof report.issueSummary[0].issue === 'string');
      }
    });

    it('computes coverage by state across all eight jurisdictions', () => {
      const states = Object.keys(report.coverage.byState);
      for (const st of ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']) {
        assert.includes(states, st, `${st} missing from coverage`);
      }
    });
  });

  /* ------------------------------------------------------------------ */
  describe('pipeline: freshness budgets', () => {
    it('gives coordinates a far longer budget than status', () => {
      const b = pipeline.FIELD_FRESHNESS_BUDGET_DAYS;
      assert.greaterThan(b.lat, b.status * 10, 'coordinates are stable; status is volatile');
      assert.atMost(b.status, 60);
      assert.atMost(b.fee, 60);
    });

    it('computes per-field staleness against the budget', () => {
      const site = {
        provenance: { status: { sourceId: 'nsw', fetchedAt: '2020-01-01T00:00:00.000Z' } },
      };
      const s = pipeline.fieldStaleness(site, 'status', Date.parse('2026-09-05T00:00:00.000Z'));
      assert.ok(s.stale, 'a 2020 status value must be flagged stale in 2026');
      assert.equal(s.sourceId, 'nsw');
      assert.greaterThan(s.ageDays, 2000);
    });

    it('returns null when a field has no provenance', () => {
      assert.equal(pipeline.fieldStaleness({ provenance: {} }, 'status'), null);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('pipeline: drift detection', () => {
    const baseline = {
      finishedAt: '2026-09-01T00:00:00.000Z',
      sources: [
        { sourceId: 'osm', recordCount: 1590, issueRate: 0 },
        { sourceId: 'nsw', recordCount: 1958, issueRate: 0.3 },
      ],
    };

    it('passes when counts are stable', () => {
      const d = pipeline.detectDrift(baseline, {
        sources: [
          { sourceId: 'osm', recordCount: 1595, issueRate: 0 },
          { sourceId: 'nsw', recordCount: 1960, issueRate: 0.3 },
        ],
      });
      assert.equal(d.level, 'ok');
    });

    it('FAILS when a source returns zero records (not treated as a change)', () => {
      const d = pipeline.detectDrift(baseline, {
        sources: [{ sourceId: 'osm', recordCount: 0, issueRate: 0 }],
      });
      assert.equal(d.level, 'fail');
      assert.includes(d.findings[0].message, 'zero records');
    });

    it('warns on a moderate count change and fails on a large one', () => {
      const warn = pipeline.detectDrift(baseline, {
        sources: [{ sourceId: 'osm', recordCount: 1400, issueRate: 0 }],
      });
      assert.equal(warn.level, 'warn');

      const fail = pipeline.detectDrift(baseline, {
        sources: [{ sourceId: 'osm', recordCount: 800, issueRate: 0 }],
      });
      assert.equal(fail.level, 'fail');
    });

    it('fails when the issue rate spikes, catching a silent schema change', () => {
      const d = pipeline.detectDrift(baseline, {
        sources: [{ sourceId: 'osm', recordCount: 1590, issueRate: 0.8 }],
      });
      assert.equal(d.level, 'fail');
      assert.includes(d.findings[0].message, 'schema change');
    });

    it('does NOT alert on a persistently dirty source (TfNSW sits at ~32%)', () => {
      // The absolute rate is high but unchanged, so it is a data-quality fact,
      // not drift. Alerting every run would train the operator to ignore it.
      const d = pipeline.detectDrift(
        { sources: [{ sourceId: 'nsw', recordCount: 1958, issueRate: 0.32, structuralIssueRate: 0 }] },
        { sources: [{ sourceId: 'nsw', recordCount: 1960, issueRate: 0.32, structuralIssueRate: 0 }] }
      );
      assert.equal(d.level, 'ok');
    });

    it('warns when a dirty source gets meaningfully dirtier', () => {
      const d = pipeline.detectDrift(
        { sources: [{ sourceId: 'nsw', recordCount: 1958, structuralIssueRate: 0.02 }] },
        { sources: [{ sourceId: 'nsw', recordCount: 1958, structuralIssueRate: 0.2 }] }
      );
      assert.equal(d.level, 'warn');
    });

    it('fails when a source errored', () => {
      const d = pipeline.detectDrift(baseline, {
        sources: [{ sourceId: 'nsw', recordCount: 0, error: 'HTTP 500' }],
      });
      assert.equal(d.level, 'fail');
    });

    it('REGRESSION: ignores permanent data gaps, using the structural rate', () => {
      // Every QLD record raises "plug count column empty" -> 100% RAW issue
      // rate on every run. Against the raw rate this failed drift forever.
      const d = pipeline.detectDrift(
        { sources: [{ sourceId: 'qld', recordCount: 17, issueRate: 1, structuralIssueRate: 0 }] },
        { sources: [{ sourceId: 'qld', recordCount: 17, issueRate: 1, structuralIssueRate: 0 }] }
      );
      assert.equal(d.level, 'ok', 'a permanent upstream data gap is not drift');
    });

    it('still fails when records genuinely stop parsing', () => {
      const d = pipeline.detectDrift(
        { sources: [{ sourceId: 'vic', recordCount: 152, structuralIssueRate: 0.02 }] },
        { sources: [{ sourceId: 'vic', recordCount: 152, structuralIssueRate: 0.9 }] }
      );
      assert.equal(d.level, 'fail');
      assert.includes(d.findings[0].message, 'schema change');
    });

    it('falls back to the raw rate for reports predating the structural field', () => {
      const d = pipeline.detectDrift(
        { sources: [{ sourceId: 'osm', recordCount: 1590, issueRate: 0.0 }] },
        { sources: [{ sourceId: 'osm', recordCount: 1590, issueRate: 0.9 }] }
      );
      assert.equal(d.level, 'fail');
    });

    it('warns when a source is served by a different endpoint than last run', () => {
      const d = pipeline.detectDrift(
        { sources: [{ sourceId: 'osm', recordCount: 1590, structuralIssueRate: 0, servedFrom: 'https://overpass-api.de/api/interpreter' }] },
        { sources: [{ sourceId: 'osm', recordCount: 1590, structuralIssueRate: 0, servedFrom: 'https://overpass.kumi.systems/api/interpreter' }] }
      );
      assert.equal(d.level, 'warn');
      assert.includes(d.findings[0].message, 'different endpoint');
    });

    it('warns when all endpoints failed and a stale cache was served', () => {
      const d = pipeline.detectDrift(
        { sources: [{ sourceId: 'osm', recordCount: 1590, structuralIssueRate: 0 }] },
        { sources: [{ sourceId: 'osm', recordCount: 1590, structuralIssueRate: 0, staleFallback: true }] }
      );
      assert.equal(d.level, 'warn');
      assert.includes(d.findings[0].message, 'stale local cache');
    });

    it('treats an unconfigured source as ok, not broken', () => {
      const d = pipeline.detectDrift(baseline, {
        sources: [{ sourceId: 'ocm', recordCount: 0, skipped: true }],
      });
      assert.equal(d.level, 'ok');
    });

    it('establishes a baseline for a brand-new source', () => {
      const d = pipeline.detectDrift(null, {
        sources: [{ sourceId: 'osm', recordCount: 1590, issueRate: 0 }],
      });
      assert.equal(d.level, 'ok');
      assert.includes(d.findings[0].message, 'baseline');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('CLI argument parsing', () => {
    it('REGRESSION: accepts negative coordinates as values, not flags', () => {
      // Every Australian latitude is negative; "--near -33.8688,151.2093" was
      // being parsed as a bare boolean flag.
      const opts = cli.parseArgs(['search', '--near', '-33.8688,151.2093', '--radius-km', '5']);
      assert.equal(opts.near, '-33.8688,151.2093');
      assert.equal(opts['radius-km'], '5');
    });

    it('still treats long and short options as options', () => {
      const opts = cli.parseArgs(['search', '--json', '--limit', '5']);
      assert.equal(opts.json, true);
      assert.equal(opts.limit, '5');
    });

    it('supports --key=value form', () => {
      assert.equal(cli.parseArgs(['x', '--port=9090']).port, '9090');
    });

    it('collects positionals', () => {
      assert.deepEqual(cli.parseArgs(['search', 'chargefox', 'ballarat'])._, ['search', 'chargefox', 'ballarat']);
    });

    it('defines distinct exit codes for each failure mode', () => {
      const codes = Object.values(cli.EXIT);
      assert.equal(new Set(codes).size, codes.length, 'exit codes must be distinct');
      assert.equal(cli.EXIT.OK, 0);
      assert.notEqual(cli.EXIT.USAGE, cli.EXIT.FAIL);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('CLI end-to-end (real subprocess)', () => {
    const haveDataset = fs.existsSync(pipeline.DATASET_PATH);

    it('exits 3 (usage) with no command and prints help', () => {
      const r = runCli([]);
      assert.equal(r.code, 3);
      assert.includes(r.stdout, 'USAGE');
    });

    it('exits 3 for an unknown command', () => {
      assert.equal(runCli(['frobnicate']).code, 3);
    });

    it('exits 0 for --help', () => {
      const r = runCli(['--help']);
      assert.equal(r.code, 0);
      assert.includes(r.stdout, 'evmap');
    });

    it('lists sources with licences and share-alike status', () => {
      const r = runCli(['sources']);
      assert.equal(r.code, 0);
      assert.includes(r.stdout, 'ODbL');
      assert.includes(r.stdout, 'CC-BY');
      assert.includes(r.stdout, 'share-alike');
      assert.includes(r.stdout, 'DISABLED', 'OCM should show as disabled by default');
    });

    it('prints stats for the built dataset', () => {
      if (!haveDataset) return 'skip';
      const r = runCli(['stats']);
      assert.equal(r.code, 0);
      assert.includes(r.stdout, 'By state:');
      assert.includes(r.stdout, 'NSW');
      assert.includes(r.stdout, 'Field completeness:');
    });

    it('emits machine-readable stats with --json', () => {
      if (!haveDataset) return 'skip';
      const r = runCli(['stats', '--json']);
      assert.equal(r.code, 0);
      const parsed = JSON.parse(r.stdout);
      assert.ok(parsed.coverage.byState.NSW > 0);
    });

    it('searches by text', () => {
      if (!haveDataset) return 'skip';
      const r = runCli(['search', 'chargefox', '--limit', '3']);
      assert.equal(r.code, 0);
      assert.includes(r.stdout.toLowerCase(), 'chargefox');
    });

    it('searches by radius using a negative latitude', () => {
      if (!haveDataset) return 'skip';
      const r = runCli(['search', '--near', '-33.8688,151.2093', '--radius-km', '3', '--limit', '2']);
      assert.equal(r.code, 0);
      assert.includes(r.stdout, 'km');
    });

    it('exits 3 when --radius-km is given without --near', () => {
      if (!haveDataset) return 'skip';
      assert.equal(runCli(['search', '--radius-km', '5']).code, 3);
    });

    it('exits 3 for a malformed --near value', () => {
      if (!haveDataset) return 'skip';
      assert.equal(runCli(['search', '--near', 'garbage']).code, 3);
    });

    it('exports GeoJSON to stdout', () => {
      if (!haveDataset) return 'skip';
      const r = runCli(['export', '--format', 'geojson']);
      assert.equal(r.code, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.type, 'FeatureCollection');
    });

    it('unpacks the ODbL bundle into a directory when --out ends in a separator', () => {
      if (!haveDataset) return 'skip';
      const dir = path.join(require('os').tmpdir(), 'evmap-odbl-test-' + Date.now()) + path.sep;
      const r = runCli(['export', '--format', 'odbl', '--out', dir]);
      assert.equal(r.code, 0);
      for (const name of ['LICENCE-NOTICE.txt', 'dataset.json', 'dataset.csv', 'dataset.geojson']) {
        assert.ok(fs.existsSync(path.join(dir, name)), name + ' missing from the bundle');
      }
      const notice = fs.readFileSync(path.join(dir, 'LICENCE-NOTICE.txt'), 'utf8');
      assert.includes(notice, 'Derivative Database');
      // The notice is hard-wrapped, so match on whitespace-normalised text
      // rather than assuming the phrase sits on one line.
      assert.includes(notice.replace(/\s+/g, ' '), 'NOT a complete census');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('writes a single file when --out names a file', () => {
      if (!haveDataset) return 'skip';
      const file = path.join(require('os').tmpdir(), 'evmap-bundle-' + Date.now() + '.json');
      const r = runCli(['export', '--format', 'odbl', '--out', file]);
      assert.equal(r.code, 0);
      const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(bundle['LICENCE-NOTICE.txt']);
      fs.rmSync(file, { force: true });
    });

    it('exits 3 for an unknown export format', () => {
      if (!haveDataset) return 'skip';
      assert.equal(runCli(['export', '--format', 'xlsx']).code, 3);
    });
  });
};
