#!/usr/bin/env node
'use strict';
/**
 * evmap — CLI for the Australian open EV charger dataset.
 *
 * Exit codes (distinct, so CI can tell failure modes apart):
 *   0  success / drift ok
 *   1  drift warnings found (soft failure)
 *   2  drift failures found, or a source errored
 *   3  usage error (bad flag, unknown command)
 *   4  runtime error (network, filesystem, parse)
 */

const fs = require('fs');
const path = require('path');

const pipeline = require('../src/pipeline');
const registry = require('../src/sources');
const search = require('../src/core/search');
const buildWeb = require('../build/build-web');

const EXIT = { OK: 0, WARN: 1, FAIL: 2, USAGE: 3, RUNTIME: 4 };

const USAGE = `evmap — open EV charger data for Australia

USAGE
  evmap <command> [options]

COMMANDS
  ingest              Fetch all sources, resolve, and write data/cache/dataset.json
  build               Generate the self-contained offline web map into web/
  serve               Start the read-only HTTP API + web map
  stats               Print coverage statistics for the current dataset
  search <text>       Search the dataset from the command line
  sources             List known sources with licence and cadence
  drift               Re-ingest and compare against the last report (for CI)
  export              Write the dataset out as CSV, GeoJSON or ODbL bundle

GLOBAL OPTIONS
  --offline           Use cached data/raw files; never touch the network
  --sources a,b,c     Restrict to specific source ids (default: osm,nsw,vic,qld)
  --json              Machine-readable output where applicable
  --quiet             Suppress progress logging
  -h, --help          Show this help

INGEST OPTIONS
  --exclude-planned   Drop planned/unbuilt sites from the artefact entirely
                      (default: keep them, flagged status=planned)

SERVE OPTIONS
  --port N            Port to listen on (default 8787)
  --host H            Host to bind (default 127.0.0.1)

SEARCH OPTIONS
  --near "lat,lng"    Centre for a radius search
  --radius-km N       Radius in km (requires --near)
  --state NSW,VIC     Filter by state/territory
  --operator NAME     Filter by canonical operator name
  --connector CCS2    Filter by connector standard
  --min-kw N          Minimum peak power
  --include-planned   Include planned/unbuilt sites
  --include-approximate  Include town-level records (Tasmanian grant list),
                      whose coordinates mark the town, not the charger
  --limit N           Max results (default 20)

EXPORT OPTIONS
  --format f          csv | geojson | odbl  (default csv)
  --out PATH          Output file (default stdout for csv/geojson)

EXAMPLES
  evmap ingest
  evmap ingest --offline
  evmap search "chargefox" --state VIC --min-kw 150
  evmap search --near "-33.8688,151.2093" --radius-km 5 --connector CCS2
  evmap serve --port 8080
  evmap drift --offline
  evmap export --format geojson --out chargers.geojson
`;

/** Tiny argv parser. Supports --flag, --key value, --key=value, positionals. */
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        /**
         * A following token is a VALUE unless it is clearly another option.
         * Naively rejecting anything starting with "-" breaks negative
         * numbers, which matters here because every Australian latitude is
         * negative: `--near "-33.8688,151.2093"` was being parsed as a bare
         * boolean flag. So only "--foo" and "-x" (letter short flags) are
         * treated as options; "-33.8" and "-1" are values.
         */
        const isOption =
          next !== undefined && (next.startsWith('--') || /^-[a-zA-Z]/.test(next));
        if (next === undefined || isOption) {
          opts[a.slice(2)] = true;
        } else {
          opts[a.slice(2)] = next;
          i++;
        }
      }
    } else if (a === '-h') {
      opts.help = true;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

const list = (v) =>
  v === undefined || v === true || v === null
    ? null
    : String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

function fail(message, code = EXIT.USAGE) {
  process.stderr.write(`evmap: ${message}\n`);
  process.exit(code);
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

async function cmdIngest(opts) {
  const log = opts.quiet ? () => {} : (m) => process.stdout.write(m + '\n');
  const { dataset, report } = await pipeline.ingest({
    sources: list(opts.sources),
    offline: !!opts.offline,
    includePlanned: !opts['exclude-planned'],
    log,
  });

  pipeline.saveDataset(dataset);
  pipeline.saveReport(report);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ counts: dataset.counts, coverage: report.coverage }, null, 2) + '\n');
  } else {
    log(`\nWrote ${path.relative(process.cwd(), pipeline.DATASET_PATH)}`);
    log(`Wrote ${path.relative(process.cwd(), pipeline.REPORT_PATH)}`);
  }

  // A source that errored is a real failure even though we produced output.
  const errored = report.sources.filter((s) => s.error);
  if (errored.length) {
    process.stderr.write(
      `\nWARNING: ${errored.length} source(s) failed: ${errored.map((s) => s.sourceId).join(', ')}\n`
    );
    return EXIT.FAIL;
  }
  return EXIT.OK;
}

async function cmdBuild(opts) {
  const log = opts.quiet ? () => {} : (m) => process.stdout.write(m + '\n');
  const dataset = pipeline.loadDataset();
  const out = buildWeb.build({ dataset, log });
  log(`\nBuilt ${out.files.length} file(s) into ${path.relative(process.cwd(), out.dir)}`);
  for (const f of out.files) {
    log(`  ${path.basename(f.path)}  ${(f.bytes / 1024).toFixed(1)} KiB`);
  }
  return EXIT.OK;
}

async function cmdServe(opts) {
  const server = require('../src/server');
  const port = Number(opts.port || process.env.PORT || 8787);
  const host = String(opts.host || '127.0.0.1');
  if (!Number.isFinite(port) || port < 1 || port > 65535) fail(`invalid --port ${opts.port}`);
  await server.start({ port, host, log: (m) => process.stdout.write(m + '\n') });
  return null; // long-running; never resolves to an exit code
}

function cmdStats(opts) {
  const dataset = pipeline.loadDataset();
  const coverage = pipeline.coverageSummary(dataset.sites);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ generatedAt: dataset.generatedAt, counts: dataset.counts, coverage }, null, 2) + '\n');
    return EXIT.OK;
  }

  const out = [];
  out.push(`Dataset generated ${dataset.generatedAt}`);
  out.push(`Sites: ${coverage.sites}   Estimated plugs: ${coverage.estimatedPlugs}`);
  out.push(
    `  mappable: ${coverage.mappableSites}   approximate (town-level, hidden by default): ${coverage.approximateSites}`
  );
  out.push('');
  out.push('By state:');
  for (const [k, v] of Object.entries(coverage.byState).sort((a, b) => b[1] - a[1])) {
    out.push(`  ${k.padEnd(9)} ${String(v).padStart(6)}`);
  }
  out.push('');
  out.push('By charging speed:');
  const bandOrder = ['ultra', 'rapid', 'fast', 'medium', 'slow', 'trickle', 'unknown'];
  for (const band of bandOrder) {
    if (coverage.bySpeed[band]) out.push(`  ${band.padEnd(9)} ${String(coverage.bySpeed[band]).padStart(6)}`);
  }
  out.push('');
  out.push('By positional precision:');
  for (const [k, v] of Object.entries(coverage.byPrecision || {}).sort((a, b) => b[1] - a[1])) {
    out.push(`  ${k.padEnd(18)} ${String(v).padStart(6)}`);
  }
  out.push('');
  out.push('By source corroboration:');
  for (const [k, v] of Object.entries(coverage.bySourceCount).sort()) {
    out.push(`  ${k} source(s) ${String(v).padStart(6)}`);
  }
  out.push('');
  out.push('Top operators:');
  for (const { operator, count } of coverage.topOperators.slice(0, 12)) {
    out.push(`  ${String(operator).padEnd(20)} ${String(count).padStart(5)}`);
  }
  out.push('');
  out.push('Field completeness:');
  for (const [k, v] of Object.entries(coverage.completeness)) {
    out.push(`  ${k.padEnd(16)} ${(v * 100).toFixed(1)}%`);
  }
  out.push('');
  out.push('Sources:');
  for (const s of dataset.sources) {
    const state = s.error ? `ERROR: ${s.error}` : s.skipped ? 'skipped' : `${s.recordCount} records`;
    out.push(`  ${s.sourceId.padEnd(5)} ${String(s.licence).padEnd(24)} ${state}`);
  }
  process.stdout.write(out.join('\n') + '\n');
  return EXIT.OK;
}

function cmdSearch(opts) {
  const dataset = pipeline.loadDataset();
  const text = opts._.slice(1).join(' ') || null;

  let lat = null;
  let lng = null;
  if (opts.near) {
    const parts = String(opts.near).split(',').map((s) => Number(s.trim()));
    if (parts.length !== 2 || !parts.every(Number.isFinite)) {
      fail('--near expects "lat,lng", e.g. --near "-33.8688,151.2093"');
    }
    [lat, lng] = parts;
  }
  if (opts['radius-km'] && lat === null) fail('--radius-km requires --near');

  let result;
  try {
    result = search.query(dataset.sites, {
      text,
      lat,
      lng,
      radiusKm: opts['radius-km'] ? Number(opts['radius-km']) : null,
      states: list(opts.state),
      operators: list(opts.operator),
      connectors: list(opts.connector),
      minPowerKw: opts['min-kw'] ? Number(opts['min-kw']) : null,
      includePlanned: !!opts['include-planned'],
      includeApproximate: !!opts['include-approximate'],
      limit: opts.limit ? Number(opts.limit) : 20,
    });
  } catch (err) {
    fail(err.message);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return EXIT.OK;
  }

  const out = [`${result.total} match(es); showing ${result.returned} (sort: ${result.sort})`, ''];
  for (const s of result.results) {
    const power = s.maxPowerKw ? `${s.maxPowerKw}kW` : 'power unknown';
    const conns = (s.connectors || []).map((c) => c.standard).join('/') || 'connectors unknown';
    const dist = s.distanceKm !== undefined ? `  ${s.distanceKm}km` : '';
    out.push(`${s.displayName || s.name || '(unnamed site)'}${dist}`);
    out.push(`  ${s.operator || 'unknown operator'} · ${power} · ${conns} · ${s.state || '??'}`);
    if (s.address && s.address.full) out.push(`  ${s.address.full}`);
    out.push(
      `  id=${s.id} sources=${s.sources.map((x) => x.sourceId).join('+')} confidence=${s.confidence}` +
        (s.status !== 'operational' ? ` STATUS=${s.status.toUpperCase()}` : '') +
        (s.positionPrecision === 'geocoded_locality' ? '  [TOWN-LEVEL POSITION]' : '')
    );
    if (Object.keys(s.conflicts || {}).length) {
      out.push(`  ! sources disagree on: ${Object.keys(s.conflicts).join(', ')}`);
    }
    out.push('');
  }
  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

function cmdSources(opts) {
  const sources = registry.ALL_SOURCES;
  if (opts.json) {
    process.stdout.write(JSON.stringify(sources.map((s) => s.meta), null, 2) + '\n');
    return EXIT.OK;
  }
  const out = [];
  for (const s of sources) {
    out.push(`${s.id} — ${s.meta.name}`);
    out.push(`  jurisdiction : ${s.meta.jurisdiction}`);
    out.push(`  licence      : ${s.meta.licence}`);
    out.push(`  attribution  : ${s.meta.attribution}`);
    out.push(`  share-alike  : ${s.meta.shareAlike ? 'YES — derived databases must stay ODbL' : 'no'}`);
    out.push(`  cadence      : ${s.meta.changeCadence} (refresh ${s.meta.recommendedRefresh})`);
    if (s.meta.requiresApiKey) out.push(`  api key      : required, env ${s.meta.apiKeyEnvVar}`);
    if (s.meta.enabledByDefault === false) out.push('  default      : DISABLED');
    if (s.meta.coverageCaveat) out.push(`  caveat       : ${s.meta.coverageCaveat}`);
    out.push('');
  }
  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

async function cmdDrift(opts) {
  const log = opts.quiet ? () => {} : (m) => process.stdout.write(m + '\n');
  const previous = pipeline.loadReport();
  const { dataset, report } = await pipeline.ingest({
    sources: list(opts.sources),
    offline: !!opts.offline,
    log: () => {},
  });

  const drift = pipeline.detectDrift(previous, report);

  if (opts.json) {
    process.stdout.write(JSON.stringify(drift, null, 2) + '\n');
  } else {
    log(previous ? `Comparing against report from ${previous.finishedAt}` : 'No previous report — establishing baseline');
    log('');
    const icon = { ok: '  ok  ', warn: ' WARN ', fail: ' FAIL ' };
    for (const f of drift.findings) {
      log(`[${icon[f.level]}] ${f.sourceId.padEnd(5)} ${f.message}`);
    }
    log('');
    log(`Overall: ${drift.level.toUpperCase()}`);
  }

  // Persist the new report so the next run has a baseline, but only when the
  // run was clean — otherwise a bad run becomes the new "normal".
  if (drift.level !== 'fail') {
    pipeline.saveDataset(dataset);
    pipeline.saveReport(report);
  } else {
    log('Not updating the saved baseline: this run failed drift checks.');
  }

  return drift.level === 'fail' ? EXIT.FAIL : drift.level === 'warn' ? EXIT.WARN : EXIT.OK;
}

function cmdExport(opts) {
  const dataset = pipeline.loadDataset();
  const format = String(opts.format || 'csv').toLowerCase();
  const exporters = require('../src/export');

  if (!exporters.FORMATS.includes(format)) {
    fail(`unknown --format "${format}". Valid: ${exporters.FORMATS.join(', ')}`);
  }

  const out = exporters.render(format, dataset);

  /**
   * The ODbL bundle is a set of files, not one document. When --out names a
   * directory (trailing separator, or an existing directory), unpack it so the
   * operator gets a ready-to-publish compliance folder rather than an envelope
   * they have to disassemble themselves.
   */
  if (opts.out && out.files) {
    const target = String(opts.out);
    const looksLikeDir =
      target.endsWith('/') ||
      target.endsWith(path.sep) ||
      (fs.existsSync(target) && fs.statSync(target).isDirectory());

    if (looksLikeDir) {
      fs.mkdirSync(target, { recursive: true });
      const written = [];
      for (const [name, content] of Object.entries(out.files)) {
        const file = path.join(target, name);
        fs.writeFileSync(file, content);
        written.push({ file, bytes: Buffer.byteLength(content) });
      }
      process.stdout.write(`Wrote ${written.length} file(s) to ${target}\n`);
      for (const w of written) {
        process.stdout.write(`  ${path.basename(w.file)}  ${(w.bytes / 1024).toFixed(1)} KiB\n`);
      }
      return EXIT.OK;
    }
  }

  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(String(opts.out))), { recursive: true });
    fs.writeFileSync(String(opts.out), out.body);
    process.stdout.write(`Wrote ${opts.out} (${out.body.length} bytes, ${out.contentType})\n`);
  } else {
    process.stdout.write(out.body);
  }
  return EXIT.OK;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const command = opts._[0];

  // An explicit help request is a success; being invoked with no command at
  // all is a usage error (so a broken CI invocation is not silently green).
  if (opts.help || opts.h) {
    process.stdout.write(USAGE);
    process.exit(EXIT.OK);
  }
  if (!command) {
    process.stdout.write(USAGE);
    process.exit(EXIT.USAGE);
  }

  const commands = {
    ingest: cmdIngest,
    build: cmdBuild,
    serve: cmdServe,
    stats: cmdStats,
    search: cmdSearch,
    sources: cmdSources,
    drift: cmdDrift,
    export: cmdExport,
  };

  const handler = commands[command];
  if (!handler) {
    process.stderr.write(`evmap: unknown command "${command}"\n\n${USAGE}`);
    process.exit(EXIT.USAGE);
  }

  try {
    const code = await handler(opts);
    /**
     * Set exitCode rather than calling process.exit().
     *
     * process.exit() terminates immediately and DISCARDS buffered stdout
     * writes. `evmap export --format geojson > out.json` was producing a
     * truncated file (cut off around 146 KB) for exactly this reason. Setting
     * exitCode lets the event loop drain the stream first, then exit with the
     * intended status.
     */
    if (code !== null && code !== undefined) process.exitCode = code;
  } catch (err) {
    process.stderr.write(`evmap: ${err.message}\n`);
    if (process.env.EVMAP_DEBUG) process.stderr.write(String(err.stack) + '\n');
    process.exit(EXIT.RUNTIME);
  }
}

if (require.main === module) main();

module.exports = { parseArgs, EXIT, USAGE };
