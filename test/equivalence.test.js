'use strict';
/**
 * Cross-surface equivalence.
 *
 * The project claims one source of truth: the CLI, the HTTP API and the
 * generated web page must return the SAME results for the same query, because
 * all three call src/core/search.js rather than filtering for themselves.
 *
 * A claim like that is worthless without a test that would actually fail if
 * someone reimplemented filtering in one surface. So this file:
 *   1. runs a query directly against core;
 *   2. runs the identical query through the real HTTP server;
 *   3. runs it through the core bundle that the web build inlines, evaluated
 *      in a fresh VM context the way a browser would;
 * then diffs the resulting id lists. It also asserts the browser bundle is
 * byte-identical to the on-disk core modules.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const { assert, describe, it } = require('./harness');

const pipeline = require('../src/pipeline');
const search = require('../src/core/search');
const server = require('../src/server');
const buildWeb = require('../build/build-web');
const exporters = require('../src/export');
const csvLib = require('../src/core/csv');

/** Queries exercised across every surface. Add a case, cover all three. */
const CASES = [
  { name: 'unfiltered default', query: {}, params: '' },
  { name: 'text search', query: { text: 'chargefox' }, params: 'q=chargefox' },
  {
    name: 'state + power',
    query: { states: ['VIC'], minPowerKw: 150 },
    params: 'states=VIC&minPowerKw=150',
  },
  {
    name: 'connector filter',
    query: { connectors: ['CHAdeMO'] },
    params: 'connectors=CHAdeMO',
  },
  {
    name: 'radius around Sydney',
    query: { lat: -33.8688, lng: 151.2093, radiusKm: 5 },
    params: 'lat=-33.8688&lng=151.2093&radiusKm=5',
  },
  {
    name: 'corroborated only',
    query: { minSources: 2 },
    params: 'minSources=2',
  },
  {
    name: 'including planned',
    query: { includePlanned: true },
    params: 'includePlanned=true',
  },
  {
    name: 'including town-level (approximate) records',
    query: { includeApproximate: true },
    params: 'includeApproximate=true',
  },
  {
    name: 'town-level records only',
    query: { precisions: ['geocoded_locality'] },
    params: 'precisions=geocoded_locality',
  },
  {
    name: 'approximate + state filter',
    query: { states: ['TAS'], includeApproximate: true },
    params: 'states=TAS&includeApproximate=true',
  },
  {
    name: 'sorted by name with paging',
    query: { sort: 'name', limit: 25, offset: 10 },
    params: 'sort=name&limit=25&offset=10',
  },
];

/** GET a JSON endpoint from a live server instance. */
function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body), headers: res.headers });
          } catch (err) {
            reject(new Error(`bad JSON from ${urlPath}: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

function getRaw(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      })
      .on('error', reject);
  });
}

module.exports = async function run() {
  let dataset;
  try {
    dataset = pipeline.loadDataset();
  } catch {
    describe('equivalence', () => {
      it('skipped: no dataset built (run `evmap ingest --offline`)', () => 'skip');
    });
    return;
  }

  /* ---------------- browser bundle fidelity ---------------- */

  describe('web bundle is generated from core, not reimplemented', () => {
    const bundle = buildWeb.bundleCore();

    it('inlines each core module verbatim', () => {
      for (const name of buildWeb.CORE_MODULES) {
        const source = fs.readFileSync(
          path.join(__dirname, '..', 'src', 'core', `${name}.js`),
          'utf8'
        );
        // The bundle indents by two spaces; compare on a normalised form so a
        // real content change fails but the indentation does not.
        const normalise = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
        assert.includes(
          normalise(bundle),
          normalise(source),
          `${name}.js is not inlined verbatim — the web page may have diverged from core`
        );
      }
    });

    it('the built page contains the bundle and the dataset', () => {
      const indexPath = path.join(__dirname, '..', 'web', 'index.html');
      if (!fs.existsSync(indexPath)) return 'skip';
      const html = fs.readFileSync(indexPath, 'utf8');
      assert.includes(html, '__evmapModules');
      assert.includes(html, 'window.EVMAP_SITES');
      assert.includes(html, 'openstreetmap.org/copyright', 'ODbL attribution must be present');
    });

    it('the page app never calls Array.prototype.filter on the site list directly', () => {
      // Guard against the most likely regression: someone "simplifying" the
      // page by filtering sites inline instead of calling the shared engine.
      const app = fs.readFileSync(path.join(__dirname, '..', 'build', 'app.js'), 'utf8');
      assert.includes(app, "__evmapRequire('search')", 'page must use the shared engine');
      assert.notOk(
        /SITES\s*\.\s*filter\s*\(/.test(app),
        'page must not filter SITES itself — route the query through core/search'
      );
    });
  });

  /* ---------------- core vs browser VM ---------------- */

  describe('core engine behaves identically inside a browser-like VM', () => {
    const bundle = buildWeb.bundleCore();
    const context = { console };
    vm.createContext(context);
    vm.runInContext(bundle, context);

    for (const testCase of CASES) {
      it(`matches for: ${testCase.name}`, () => {
        const direct = search.query(dataset.sites, testCase.query);
        const viaVm = vm.runInContext(
          `__evmapRequire('search').query(__SITES__, __QUERY__)`
            .replace('__SITES__', 'globalThis.__sites')
            .replace('__QUERY__', JSON.stringify(testCase.query)),
          Object.assign(context, { __sites: dataset.sites })
        );
        assert.equal(viaVm.total, direct.total, 'total differs');
        assert.deepEqual(
          viaVm.results.map((s) => s.id),
          direct.results.map((s) => s.id),
          'result ids differ between core and the browser bundle'
        );
      });
    }
  });

  /* ---------------- core vs HTTP API ---------------- */

  const instance = await server.start({ port: 0, host: '127.0.0.1', dataset, log: () => {} });
  const port = instance.address().port;

  try {
    describe('HTTP API returns identical results to the core engine', () => {
      for (const testCase of CASES) {
        it(`matches for: ${testCase.name}`, async () => {
          const direct = search.query(dataset.sites, testCase.query);
          const { status, json } = await getJson(port, `/api/sites?${testCase.params}`);
          assert.equal(status, 200);
          assert.equal(json.total, direct.total, 'total differs');
          assert.deepEqual(
            json.sites.map((s) => s.id),
            direct.results.map((s) => s.id),
            'result ids differ between core and the HTTP API'
          );
        });
      }
    });

    describe('HTTP API contract', () => {
      it('serves health without a dataset requirement', async () => {
        const { status, json } = await getJson(port, '/api/health');
        assert.equal(status, 200);
        assert.equal(json.status, 'ok');
      });

      it('exposes metadata with attribution and freshness budgets', async () => {
        const { json } = await getJson(port, '/api/meta');
        assert.atLeast(json.attribution.length, 4);
        assert.ok(json.freshnessBudgetDays.status, 'status budget must exist');
        assert.ok(json.licence.effective.includes('ODbL'), 'effective licence must be ODbL');
      });

      it('returns a single site with per-field staleness', async () => {
        const id = dataset.sites[0].id;
        const { status, json } = await getJson(port, `/api/sites/${encodeURIComponent(id)}`);
        assert.equal(status, 200);
        assert.equal(json.site.id, id);
        assert.ok(Object.keys(json.staleness).length > 0, 'expected staleness data');
      });

      it('returns 404 with a stable error code for an unknown site', async () => {
        const { status, json } = await getJson(port, '/api/sites/not-a-real-id');
        assert.equal(status, 404);
        assert.equal(json.error.code, 'NOT_FOUND');
      });

      it('returns 400 BAD_QUERY for an invalid sort', async () => {
        const { status, json } = await getJson(port, '/api/sites?sort=bogus');
        assert.equal(status, 400);
        assert.equal(json.error.code, 'BAD_QUERY');
      });

      it('returns 400 BAD_QUERY for a radius without a centre', async () => {
        const { status, json } = await getJson(port, '/api/sites?radiusKm=5');
        assert.equal(status, 400);
        assert.equal(json.error.code, 'BAD_QUERY');
      });

      it('returns 400 for a malformed bbox', async () => {
        const { status, json } = await getJson(port, '/api/sites?bbox=1,2,3');
        assert.equal(status, 400);
        assert.equal(json.error.code, 'BAD_QUERY');
      });

      it('rejects writes: this API is read-only', async () => {
        const status = await new Promise((resolve, reject) => {
          const req = http.request(
            { host: '127.0.0.1', port, path: '/api/sites', method: 'POST' },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            }
          );
          req.on('error', reject);
          req.end();
        });
        assert.equal(status, 405);
      });

      it('honours includeApproximate over HTTP (REGRESSION: it was ignored)', async () => {
        const withOut = await getJson(port, '/api/sites?states=TAS');
        const withIn = await getJson(port, '/api/sites?states=TAS&includeApproximate=true');
        assert.greaterThan(
          withIn.json.total,
          withOut.json.total,
          'town-level records must become reachable when asked for'
        );
        assert.ok(
          withIn.json.facets.positionPrecision.geocoded_locality > 0,
          'the precision facet must report them'
        );
      });

      it('excludes town-level records by default over HTTP', async () => {
        const { json } = await getJson(port, '/api/sites?states=TAS');
        assert.ok(
          !json.facets.positionPrecision.geocoded_locality,
          'the default view must contain no town-level records'
        );
      });

      it('never returns a town-level record from /api/nearest', async () => {
        const { json } = await getJson(port, '/api/nearest?lat=-42.88&lng=147.33&n=10');
        assert.ok(
          json.sites.every((s) => s.positionPrecision !== 'geocoded_locality'),
          'nearest is used for navigation and must be mappable'
        );
      });

      it('reports the mappable/approximate split in stats', async () => {
        const { json } = await getJson(port, '/api/stats');
        assert.equal(
          json.coverage.mappableSites + json.coverage.approximateSites,
          json.coverage.sites
        );
        assert.atLeast(json.coverage.approximateSites, 50);
      });

      it('accepts repeated and comma-separated list params equivalently', async () => {
        const a = await getJson(port, '/api/sites?states=NSW&states=VIC');
        const b = await getJson(port, '/api/sites?states=NSW,VIC');
        assert.equal(a.json.total, b.json.total);
      });

      it('sets permissive CORS for public read-only data', async () => {
        const { headers } = await getJson(port, '/api/health');
        assert.equal(headers['access-control-allow-origin'], '*');
      });

      it('serves nearest sites sorted by distance', async () => {
        const { json } = await getJson(port, '/api/nearest?lat=-33.8688&lng=151.2093&n=5');
        assert.equal(json.sites.length, 5);
        const distances = json.sites.map((s) => s.distanceM);
        const sorted = distances.slice().sort((x, y) => x - y);
        assert.deepEqual(distances, sorted);
      });

      it('rejects an out-of-range nearest count', async () => {
        const { status } = await getJson(port, '/api/nearest?lat=-33.8&lng=151.2&n=500');
        assert.equal(status, 400);
      });
    });

    describe('exports are identical via CLI module and HTTP', () => {
      it('CSV matches byte for byte', async () => {
        const direct = exporters.render('csv', dataset).body;
        const { body, headers } = await getRaw(port, '/api/export/csv');
        assert.equal(body, direct, 'CSV export differs between module and HTTP');
        assert.includes(headers['content-type'], 'text/csv');
      });

      it('GeoJSON matches byte for byte and is valid', async () => {
        const direct = exporters.render('geojson', dataset).body;
        const { body } = await getRaw(port, '/api/export/geojson');
        assert.equal(body, direct);
        const parsed = JSON.parse(body);
        assert.equal(parsed.type, 'FeatureCollection');
        assert.equal(parsed.features.length, dataset.sites.length);
        const f = parsed.features[0];
        assert.equal(f.geometry.type, 'Point');
        assert.equal(f.geometry.coordinates.length, 2);
        assert.ok(parsed.metadata.attribution, 'attribution must survive export');
      });

      it('CSV export is parseable and carries an attribution header', () => {
        const body = exporters.render('csv', dataset).body;
        assert.ok(body.startsWith('#'), 'expected leading comment header');
        assert.includes(body, 'OpenStreetMap');
        const dataPart = body.split('\n').filter((l) => !l.startsWith('#')).join('\n');
        const rows = csvLib.parse(dataPart);
        assert.equal(rows.length, dataset.sites.length);
        assert.ok('display_name' in rows[0]);
      });

      it('the ODbL bundle satisfies the share-alike obligation', async () => {
        const { status, body } = await getRaw(port, '/api/export/odbl');
        assert.equal(status, 200);
        const bundle = JSON.parse(body);
        assert.ok(bundle['LICENCE-NOTICE.txt'], 'bundle must include the licence notice');
        assert.includes(bundle['LICENCE-NOTICE.txt'], 'Derivative Database');
        assert.includes(bundle['LICENCE-NOTICE.txt'], 'opendatacommons.org/licenses/odbl');
        assert.includes(bundle['LICENCE-NOTICE.txt'].replace(/\s+/g, ' '), 'NOT a complete census');
        assert.ok(bundle['dataset.json'], 'bundle must include the database itself');
        assert.ok(bundle['dataset.csv']);
        assert.ok(bundle['dataset.geojson']);
      });

      it('rejects an unknown export format', async () => {
        const { status, json } = await getJson(port, '/api/export/xlsx');
        assert.equal(status, 400);
        assert.equal(json.error.code, 'BAD_QUERY');
      });
    });
  } finally {
    instance.close();
  }
};
