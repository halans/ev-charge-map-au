'use strict';
/**
 * Read-only HTTP API + static web map. Zero dependencies (node:http only).
 *
 * Every query endpoint delegates to src/core/search.js — the same module the
 * CLI and the browser bundle use. See test/equivalence.test.js, which asserts
 * the three surfaces return identical results for identical queries.
 *
 * Error contract: every failure returns JSON
 *   { error: { code, message, detail? } }
 * with a documented HTTP status. Codes are stable strings, safe to switch on.
 * Full schemas: docs/API.md
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const pipeline = require('./pipeline');
const search = require('./core/search');
const exporters = require('./export');

const WEB_DIR = path.join(__dirname, '..', 'web');

/** Stable error codes. Documented in docs/API.md. */
const ERRORS = {
  BAD_QUERY: { status: 400, code: 'BAD_QUERY' },
  NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  METHOD_NOT_ALLOWED: { status: 405, code: 'METHOD_NOT_ALLOWED' },
  DATASET_UNAVAILABLE: { status: 503, code: 'DATASET_UNAVAILABLE' },
  INTERNAL: { status: 500, code: 'INTERNAL' },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
    // Read-only public data: permissive CORS is appropriate and expected.
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, kind, message, detail) {
  sendJson(res, kind.status, {
    error: { code: kind.code, message, ...(detail ? { detail } : {}) },
  });
}

function sendText(res, status, body, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * Parse query parameters into a search query object.
 * Repeated params and comma-separated lists both work: ?states=NSW&states=VIC
 * and ?states=NSW,VIC are equivalent.
 */
function queryFromParams(params) {
  const multi = (key) => {
    const all = params.getAll(key);
    if (!all.length) return null;
    const flat = all.flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
    return flat.length ? flat : null;
  };
  const one = (key) => (params.has(key) ? params.get(key) : null);
  const bool = (key) => {
    if (!params.has(key)) return false;
    const v = String(params.get(key)).toLowerCase();
    return v === '' || v === '1' || v === 'true' || v === 'yes';
  };

  let bbox = null;
  if (params.has('bbox')) {
    // bbox=minLng,minLat,maxLng,maxLat (GeoJSON/slippy-map order)
    const parts = String(params.get('bbox')).split(',').map(Number);
    if (parts.length !== 4 || !parts.every(Number.isFinite)) {
      throw new Error('bbox expects four numbers: minLng,minLat,maxLng,maxLat');
    }
    bbox = { minLng: parts[0], minLat: parts[1], maxLng: parts[2], maxLat: parts[3] };
  }

  return {
    text: one('q') || one('text'),
    lat: one('lat'),
    lng: one('lng'),
    radiusKm: one('radiusKm') || one('radius_km'),
    bbox,
    states: multi('states') || multi('state'),
    operators: multi('operators') || multi('operator'),
    connectors: multi('connectors') || multi('connector'),
    minPowerKw: one('minPowerKw') || one('min_kw'),
    maxPowerKw: one('maxPowerKw') || one('max_kw'),
    speedBands: multi('speedBands') || multi('speed'),
    statuses: multi('statuses') || multi('status'),
    /**
     * Positional-precision filter. Omitting these two was a real bug: the CLI
     * and the core engine honoured `includeApproximate` while the HTTP API
     * silently ignored it, so town-level records were unreachable over HTTP.
     * The cross-surface equivalence test now covers it.
     */
    precisions: multi('precisions') || multi('precision'),
    includeApproximate: bool('includeApproximate') || bool('include_approximate'),
    includePlanned: bool('includePlanned') || bool('include_planned'),
    minSources: one('minSources'),
    minConfidence: one('minConfidence'),
    sort: one('sort'),
    // search.query() treats an explicit `null` limit as "no limit" — omitting
    // the query param entirely must stay the default 100-per-page behaviour,
    // so pass undefined (not one()'s null-for-absent) when it's not given.
    limit: params.has('limit') ? one('limit') : undefined,
    offset: one('offset'),
  };
}

/** Serve a file from web/, with directory traversal blocked. */
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(WEB_DIR, rel);

  if (!target.startsWith(path.resolve(WEB_DIR))) {
    return sendError(res, ERRORS.NOT_FOUND, 'Not found');
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return sendError(
      res,
      ERRORS.NOT_FOUND,
      `No such file "${rel}". Run \`evmap build\` to generate the web map.`
    );
  }

  const body = fs.readFileSync(target);
  const type = MIME[path.extname(target)] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

/**
 * Build the request handler.
 * @param {object} opts { dataset } inject a dataset to skip disk loading (tests)
 */
function createHandler(opts = {}) {
  /** Lazily loaded and cached, so the process starts even with no dataset. */
  let cached = opts.dataset || null;
  const getDataset = () => {
    if (cached) return cached;
    cached = pipeline.loadDataset();
    return cached;
  };

  return function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendError(res, ERRORS.BAD_QUERY, 'Malformed request URL');
    }

    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(
        res,
        ERRORS.METHOD_NOT_ALLOWED,
        `${req.method} is not supported; this API is read-only`
      );
    }

    // ---- Health: must not require a dataset ------------------------------
    if (route === '/api/health') {
      let datasetOk = true;
      let generatedAt = null;
      let sites = 0;
      try {
        const d = getDataset();
        generatedAt = d.generatedAt;
        sites = d.sites.length;
      } catch {
        datasetOk = false;
      }
      return sendJson(res, datasetOk ? 200 : 503, {
        status: datasetOk ? 'ok' : 'no-dataset',
        datasetGeneratedAt: generatedAt,
        sites,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }

    // Everything below needs the dataset.
    let dataset;
    if (route.startsWith('/api/')) {
      try {
        dataset = getDataset();
      } catch (err) {
        return sendError(
          res,
          ERRORS.DATASET_UNAVAILABLE,
          'Dataset not built yet. Run `evmap ingest` (or `evmap ingest --offline`).',
          err.message
        );
      }
    }

    try {
      // ---- Metadata ------------------------------------------------------
      if (route === '/api/meta') {
        return sendJson(res, 200, {
          schemaVersion: dataset.schemaVersion,
          generatedAt: dataset.generatedAt,
          licence: dataset.licence,
          attribution: dataset.attribution,
          freshnessBudgetDays: dataset.freshnessBudgetDays,
          sources: dataset.sources,
          counts: dataset.counts,
        });
      }

      // ---- Search --------------------------------------------------------
      if (route === '/api/sites') {
        let result;
        try {
          result = search.query(dataset.sites, queryFromParams(url.searchParams));
        } catch (err) {
          return sendError(res, ERRORS.BAD_QUERY, err.message);
        }
        return sendJson(res, 200, {
          generatedAt: dataset.generatedAt,
          attribution: dataset.attribution,
          total: result.total,
          returned: result.returned,
          sort: result.sort,
          facets: result.facets,
          sites: result.results,
        });
      }

      // ---- Single site ---------------------------------------------------
      if (route.startsWith('/api/sites/')) {
        const id = decodeURIComponent(route.slice('/api/sites/'.length));
        const site = search.byId(dataset.sites, id);
        if (!site) {
          return sendError(res, ERRORS.NOT_FOUND, `No site with id "${id}"`);
        }
        // Attach per-field staleness, computed from the freshness budgets.
        const staleness = {};
        for (const field of Object.keys(dataset.freshnessBudgetDays)) {
          const s = pipeline.fieldStaleness(site, field);
          if (s) staleness[field] = s;
        }
        return sendJson(res, 200, {
          generatedAt: dataset.generatedAt,
          attribution: dataset.attribution,
          site,
          staleness,
        });
      }

      // ---- Nearest -------------------------------------------------------
      if (route === '/api/nearest') {
        const lat = Number(url.searchParams.get('lat'));
        const lng = Number(url.searchParams.get('lng'));
        const n = Number(url.searchParams.get('n') || 5);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return sendError(res, ERRORS.BAD_QUERY, 'lat and lng are required numbers');
        }
        if (!Number.isFinite(n) || n < 1 || n > 100) {
          return sendError(res, ERRORS.BAD_QUERY, 'n must be between 1 and 100');
        }
        return sendJson(res, 200, {
          generatedAt: dataset.generatedAt,
          attribution: dataset.attribution,
          sites: search.nearest(dataset.sites, lat, lng, n),
        });
      }

      // ---- Stats ---------------------------------------------------------
      if (route === '/api/stats') {
        return sendJson(res, 200, {
          generatedAt: dataset.generatedAt,
          counts: dataset.counts,
          coverage: pipeline.coverageSummary(dataset.sites),
        });
      }

      // ---- Exports (incl. the ODbL compliance bundle) --------------------
      if (route.startsWith('/api/export')) {
        const format = (route.split('/')[3] || url.searchParams.get('format') || 'csv').toLowerCase();
        if (!exporters.FORMATS.includes(format)) {
          return sendError(
            res,
            ERRORS.BAD_QUERY,
            `Unknown export format "${format}"`,
            `Valid formats: ${exporters.FORMATS.join(', ')}`
          );
        }
        const out = exporters.render(format, dataset);
        return sendText(res, 200, out.body, out.contentType, {
          'content-disposition': `attachment; filename="${out.filename}"`,
        });
      }

      if (route.startsWith('/api/')) {
        return sendError(res, ERRORS.NOT_FOUND, `No such endpoint "${route}"`);
      }

      // ---- Static web map ------------------------------------------------
      return serveStatic(res, url.pathname);
    } catch (err) {
      return sendError(res, ERRORS.INTERNAL, 'Unhandled server error', err.message);
    }
  };
}

/**
 * Start the server.
 * @returns {Promise<http.Server>}
 */
function start(opts = {}) {
  const port = opts.port || 8787;
  const host = opts.host || '127.0.0.1';
  const log = opts.log || (() => {});
  const server = http.createServer(createHandler(opts));

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      log(`ev-charge-map-au listening on http://${host}:${port}`);
      log('');
      log('  Web map      http://' + host + ':' + port + '/');
      log('  Search       /api/sites?q=chargefox&states=VIC&minPowerKw=150');
      log('  Nearest      /api/nearest?lat=-33.8688&lng=151.2093&n=5');
      log('  One site     /api/sites/<id>');
      log('  Metadata     /api/meta');
      log('  Statistics   /api/stats');
      log('  Health       /api/health');
      log('  ODbL bundle  /api/export/odbl');
      log('');
      resolve(server);
    });
  });
}

module.exports = { ERRORS, createHandler, queryFromParams, start };
