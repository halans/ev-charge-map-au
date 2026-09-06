'use strict';
/**
 * Web build: generates web/index.html — a single self-contained page.
 *
 * The critical property: the browser does NOT get a reimplementation of the
 * search logic. This script reads src/core/{geo,normalise,search}.js off disk
 * and inlines them verbatim behind a 6-line CommonJS shim, so the page runs
 * the exact same engine as the CLI and the HTTP API. If someone changes the
 * matching or filtering rules in core, the web page changes with them, and
 * test/equivalence.test.js fails if the three surfaces ever diverge.
 *
 * Leaflet is vendored into web/vendor/ rather than loaded from a CDN, so the
 * page has no third-party runtime dependency. Map TILES still require network
 * (that is inherent to any tiled map); when tiles are unavailable the page
 * falls back to a built-in canvas plot so search remains usable offline.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE_DIR = path.join(ROOT, 'src', 'core');
const WEB_DIR = path.join(ROOT, 'web');
const VENDOR_DIR = path.join(WEB_DIR, 'vendor');

/** Core modules inlined into the browser bundle, in dependency order. */
const CORE_MODULES = ['geo', 'normalise', 'search'];

/**
 * Wrap the core modules in a minimal CommonJS emulation.
 * Deliberately tiny and readable: this is a shim, not a bundler.
 */
function bundleCore() {
  const parts = [
    '/* --- inlined from src/core/ at build time. DO NOT EDIT HERE. --- */',
    'var __evmapModules = {};',
    'function __evmapRequire(p) {',
    "  var key = String(p).replace(/^\\.\\//, '').replace(/\\.js$/, '');",
    '  if (!(key in __evmapModules)) throw new Error("core module not bundled: " + key);',
    '  return __evmapModules[key];',
    '}',
  ];

  for (const name of CORE_MODULES) {
    const file = path.join(CORE_DIR, `${name}.js`);
    const source = fs.readFileSync(file, 'utf8');
    parts.push('');
    parts.push(`/* ==== src/core/${name}.js ==== */`);
    parts.push(`__evmapModules[${JSON.stringify(name)}] = (function () {`);
    parts.push('  var module = { exports: {} };');
    parts.push('  var exports = module.exports;');
    parts.push('  var require = __evmapRequire;');
    // Indent for readability of the generated file.
    parts.push(
      source
        .split('\n')
        .map((l) => (l ? '  ' + l : l))
        .join('\n')
    );
    parts.push('  return module.exports;');
    parts.push('})();');
  }

  return parts.join('\n');
}

/**
 * Slim projection of a site for the browser.
 *
 * Short keys because the full field names cost ~40% more bytes across 3,000
 * records. The mapping is expanded back to readable names by `expand()` in the
 * page script, so the app code stays legible.
 */
function slimSite(s) {
  return {
    id: s.id,
    name: s.name,
    displayName: s.displayName,
    nameIsDerived: s.nameIsDerived,
    operator: s.operator,
    lat: s.lat,
    lng: s.lng,
    state: s.state,
    address: s.address ? s.address.full : null,
    suburb: s.address ? s.address.suburb : null,
    postcode: s.address ? s.address.postcode : null,
    maxPowerKw: s.maxPowerKw,
    speedBand: s.speedBand,
    connectors: (s.connectors || []).map((c) => ({
      standard: c.standard,
      count: c.count,
      powerKw: c.powerKw,
    })),
    plugCount: s.plugCount,
    status: s.status,
    access: s.access,
    fee: s.fee,
    network: s.network,
    sourceCount: s.sourceCount,
    sources: (s.sources || []).map((x) => x.sourceId),
    sourceUrls: (s.sources || []).map((x) => x.url).filter(Boolean),
    confidence: s.confidence,
    conflicts: Object.keys(s.conflicts || {}),
    spatialSpreadM: s.spatialSpreadM,
    positionPrecision: s.positionPrecision,
    positionErrorMetres: s.positionErrorMetres,
    /** Per-field provenance, reduced to field -> sourceId for the detail panel. */
    provenance: Object.fromEntries(
      Object.entries(s.provenance || {})
        .filter(([, v]) => v && v.sourceId)
        .map(([k, v]) => [k, v.sourceId])
    ),
    fetchedAt: (() => {
      // Most recent fetch across the contributing sources.
      const times = (s.sources || []).map((x) => x.fetchedAt).filter(Boolean).sort();
      return times.length ? times[times.length - 1] : null;
    })(),
  };
}

/** Escape for safe embedding in an HTML <script> block. */
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function readVendor(name) {
  const file = path.join(VENDOR_DIR, name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing vendored asset web/vendor/${name}. See docs/BUILDING.md for the fetch command.`
    );
  }
  return fs.readFileSync(file, 'utf8');
}

/**
 * Render the page.
 * @param {object} args { dataset, coreBundle, leafletJs, leafletCss }
 */
function renderHtml({ dataset, coreBundle, leafletJs, leafletCss }) {
  const sites = dataset.sites.map(slimSite);
  const meta = {
    generatedAt: dataset.generatedAt,
    licence: dataset.licence,
    attribution: dataset.attribution,
    sources: dataset.sources.map((s) => ({
      sourceId: s.sourceId,
      name: s.name,
      jurisdiction: s.jurisdiction,
      licence: s.licence,
      licenceUrl: s.licenceUrl,
      attribution: s.attribution,
      recordCount: s.recordCount,
      fetchedAt: s.fetchedAt,
      recommendedRefresh: s.recommendedRefresh,
      coverageCaveat: s.coverageCaveat,
      changeCadence: s.changeCadence,
    })),
    counts: dataset.counts,
    freshnessBudgetDays: dataset.freshnessBudgetDays,
  };

  const appScript = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const appStyles = fs.readFileSync(path.join(__dirname, 'app.css'), 'utf8');

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Australian EV Charger Map — open data</title>
<meta name="description" content="Every public EV charging site in Australia that appears in openly-licensed data, reconciled from OpenStreetMap and state government datasets.">
<meta name="color-scheme" content="light dark">
<style>
/* ===== vendored Leaflet 1.9.4 ===== */
${leafletCss}
</style>
<style>
/* ===== application styles (build/app.css) ===== */
${appStyles}
</style>
</head>
<body>
<div id="app">
  <header id="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <span class="brand-text">
        <strong>EV Chargers AU</strong>
        <span class="brand-sub">open data only</span>
      </span>
    </div>
    <div class="search-wrap">
      <input id="q" type="search" placeholder="Search suburb, operator or site name" autocomplete="off"
             aria-label="Search charging sites">
      <button id="locate" type="button" title="Find chargers near me" aria-label="Find chargers near me">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 8a4 4 0 100 8 4 4 0 000-8zm0-6a1 1 0 011 1v1.06A8.01 8.01 0 0119.94 11H21a1 1 0 010 2h-1.06A8.01 8.01 0 0113 19.94V21a1 1 0 01-2 0v-1.06A8.01 8.01 0 014.06 13H3a1 1 0 010-2h1.06A8.01 8.01 0 0111 4.06V3a1 1 0 011-1zm0 4a6 6 0 100 12 6 6 0 000-12z"/></svg>
      </button>
    </div>
    <button id="filters-toggle" type="button" class="ghost" aria-expanded="false" aria-controls="filters">
      Filters <span id="filter-count" class="pill" hidden>0</span>
    </button>
  </header>

  <section id="filters" hidden aria-label="Filters">
    <div class="filter-grid">
      <label class="field">
        <span>Minimum power</span>
        <select id="f-power">
          <option value="">Any power</option>
          <option value="7">7 kW or more</option>
          <option value="25">25 kW or more</option>
          <option value="50">50 kW or more (fast)</option>
          <option value="150">150 kW or more (rapid)</option>
          <option value="250">250 kW or more (ultra)</option>
        </select>
        <span class="power-key">
          <span><span class="swatch slow" aria-hidden="true"></span>7–24</span>
          <span><span class="swatch fast" aria-hidden="true"></span>25–149</span>
          <span><span class="swatch rapid" aria-hidden="true"></span>150–249</span>
          <span><span class="swatch ultra" aria-hidden="true"></span>250+ kW</span>
        </span>
      </label>
      <label class="field">
        <span>Connector</span>
        <select id="f-connector">
          <option value="">Any connector</option>
          <option value="CCS2">CCS2</option>
          <option value="CHAdeMO">CHAdeMO</option>
          <option value="Type2">Type 2 (AC)</option>
          <option value="TeslaProprietary">Tesla</option>
        </select>
      </label>
      <label class="field">
        <span>State or territory</span>
        <select id="f-state">
          <option value="">All of Australia</option>
          <option>NSW</option><option>VIC</option><option>QLD</option>
          <option>SA</option><option>WA</option><option>TAS</option>
          <option>NT</option><option>ACT</option>
        </select>
      </label>
      <label class="field">
        <span>Operator</span>
        <select id="f-operator"><option value="">Any operator</option></select>
      </label>
      <label class="check">
        <input type="checkbox" id="f-corroborated">
        <span>Only sites confirmed by 2+ sources</span>
      </label>
      <label class="check">
        <input type="checkbox" id="f-planned">
        <span>Include planned / not yet built</span>
      </label>
      <label class="check">
        <input type="checkbox" id="f-approximate">
        <span>Include town-level records <em>(position is the town, not the charger)</em></span>
      </label>
    </div>
    <div class="filter-actions">
      <button id="filters-reset" type="button" class="ghost">Reset filters</button>
      <button id="filters-done" type="button" class="primary">Show results</button>
    </div>
  </section>

  <main id="main">
    <div id="map" role="application" aria-label="Map of charging sites"></div>
    <canvas id="fallback-map" hidden aria-label="Offline plot of charging sites"></canvas>

    <div id="map-banners" aria-live="polite">
      <div id="map-hint" class="chip-notice info" hidden></div>
      <div id="toast" class="chip-notice warn" hidden></div>
    </div>

    <div id="legend-wrap">
      <button id="legend-toggle" type="button" class="ghost small" aria-expanded="false" aria-controls="legend">
        Legend
      </button>
      <div id="legend" hidden aria-label="Marker legend">
        <div class="legend-row"><span class="swatch ultra"></span>Ultra · 250 kW+</div>
        <div class="legend-row"><span class="swatch rapid"></span>Rapid · 150–249 kW</div>
        <div class="legend-row"><span class="swatch fast"></span>Fast · 25–149 kW</div>
        <div class="legend-row"><span class="swatch slow"></span>Slow or unpublished</div>
        <div class="legend-row"><span class="swatch planned"></span>Planned / not yet built</div>
        <div class="legend-row"><span class="swatch approx"></span>Town-level (approximate)</div>
        <div class="legend-row"><span class="cluster" style="width:16px;height:16px;font-size:9px">N</span>Grouped nearby sites — click to zoom in</div>
      </div>
    </div>

    <aside id="panel" aria-label="Results">
      <div id="panel-handle" role="button" tabindex="0" aria-label="Expand or collapse the results list">
        <span class="grip" aria-hidden="true"></span>
        <span id="result-count">Loading…</span>
      </div>
      <div id="results" role="list"></div>
      <div id="detail" hidden></div>
    </aside>
  </main>

  <footer id="attribution">
    <button id="about-toggle" type="button" class="ghost small">Data sources &amp; licences</button>
    <span id="freshness"></span>
  </footer>

  <dialog id="about">
    <article>
      <h2>Where this data comes from</h2>
      <p id="about-intro"></p>
      <div id="about-sources"></div>
      <h3>Licence of this dataset</h3>
      <p id="about-licence"></p>
      <p class="fineprint">
        This map is built from openly-licensed data only. It is <strong>not</strong> a
        complete census of Australian public charging infrastructure, and it carries no
        live availability information — a charger shown here may be occupied, offline,
        or decommissioned. Always confirm with the operator's own app before relying on a site.
      </p>
      <form method="dialog"><button class="primary">Close</button></form>
    </article>
  </dialog>
</div>

<script>
/* ===== vendored Leaflet 1.9.4 ===== */
${leafletJs}
</script>
<script>
${coreBundle}
</script>
<script>
/* ===== dataset, inlined so the page works from file:// ===== */
window.EVMAP_META = ${safeJson(meta)};
window.EVMAP_SITES = ${safeJson(sites)};
</script>
<script>
/* ===== application (build/app.js) ===== */
${appScript}
</script>
</body>
</html>
`;
}

/**
 * Build the web artefacts.
 * @param {object} opts { dataset, log, outDir }
 */
function build(opts = {}) {
  const log = opts.log || (() => {});
  const dataset = opts.dataset;
  if (!dataset) throw new Error('build() requires a dataset');

  const outDir = opts.outDir || WEB_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  log('Bundling core modules for the browser…');
  const coreBundle = bundleCore();
  log(`  inlined ${CORE_MODULES.length} core modules (${(coreBundle.length / 1024).toFixed(1)} KiB)`);

  const leafletJs = readVendor('leaflet.js');
  const leafletCss = readVendor('leaflet.css');
  log(`  vendored Leaflet (${(leafletJs.length / 1024).toFixed(1)} KiB js, ${(leafletCss.length / 1024).toFixed(1)} KiB css)`);

  const html = renderHtml({ dataset, coreBundle, leafletJs, leafletCss });
  const indexPath = path.join(outDir, 'index.html');
  fs.writeFileSync(indexPath, html);
  log(`  wrote index.html with ${dataset.sites.length} sites`);

  // Also emit the slim dataset separately, so the HTTP API and third parties
  // can consume it without parsing the HTML.
  const slimPath = path.join(outDir, 'sites.json');
  fs.writeFileSync(
    slimPath,
    JSON.stringify({
      generatedAt: dataset.generatedAt,
      attribution: dataset.attribution,
      licence: dataset.licence,
      sites: dataset.sites.map(slimSite),
    })
  );

  const files = [indexPath, slimPath].map((p) => ({ path: p, bytes: fs.statSync(p).size }));
  return { dir: outDir, files };
}

module.exports = { CORE_MODULES, build, bundleCore, renderHtml, slimSite };
