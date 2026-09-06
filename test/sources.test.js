'use strict';
/**
 * Source adapter tests, run against the REAL cached upstream files in
 * data/raw/. That is deliberate: synthetic fixtures would have passed happily
 * while the VIC status heuristic mislabelled 96 live sites as unbuilt.
 *
 * These tests are offline — they read the shipped cache, never the network.
 */

const fs = require('fs');
const path = require('path');

const { assert, describe, it } = require('./harness');

const csvLib = require('../src/core/csv');
const osm = require('../src/sources/osm');
const nsw = require('../src/sources/nsw');
const vic = require('../src/sources/vic');
const qld = require('../src/sources/qld');
const act = require('../src/sources/act');
const tas = require('../src/sources/tas');
const nrmCore = require('../src/core/normalise');
const geoCore = require('../src/core/geo');
const registry = require('../src/sources');

const RAW = path.join(__dirname, '..', 'data', 'raw');
const have = (f) => fs.existsSync(path.join(RAW, f));
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
const readText = (f) => fs.readFileSync(path.join(RAW, f), 'utf8');

const CTX = { fetchedAt: '2026-09-05T00:00:00.000Z', now: Date.parse('2026-09-05T00:00:00.000Z') };

module.exports = function run() {
  /* ------------------------------------------------------------------ */
  describe('source registry', () => {
    it('enables exactly the six keyless open sources by default', () => {
      assert.deepEqual(registry.DEFAULT_SOURCES.map((s) => s.id), ['osm', 'nsw', 'vic', 'qld', 'act', 'tas']);
    });

    it('does not enable Open Charge Map by default (needs an API key)', () => {
      assert.notOk(registry.DEFAULT_SOURCES.some((s) => s.id === 'ocm'));
      assert.equal(registry.ocm.meta.enabledByDefault, false);
    });

    it('throws a helpful error for an unknown source id', () => {
      assert.throws(() => registry.select(['atlantis']));
    });

    it('every source declares licence and attribution metadata', () => {
      for (const s of registry.ALL_SOURCES) {
        assert.ok(s.meta.licence, `${s.id} missing licence`);
        assert.ok(s.meta.attribution, `${s.id} missing attribution`);
        assert.ok(s.meta.licenceUrl, `${s.id} missing licenceUrl`);
        assert.ok(s.meta.recommendedRefresh, `${s.id} missing refresh cadence`);
      }
    });

    it('marks OSM as share-alike and the government sources as not', () => {
      assert.equal(registry.osm.meta.shareAlike, true);
      assert.equal(registry.act.meta.shareAlike, false);
      assert.equal(registry.nsw.meta.shareAlike, false);
      assert.equal(registry.vic.meta.shareAlike, false);
      assert.equal(registry.qld.meta.shareAlike, false);
    });

    it('collects attribution lines for the enabled sources', () => {
      const a = registry.attributions();
      assert.equal(a.length, 6);
      assert.ok(a.some((x) => x.text.includes('Australian Capital Territory')));
      assert.ok(a.some((x) => x.text.includes('State of Tasmania')));
      assert.ok(a.some((x) => x.text.includes('OpenStreetMap')));
      assert.ok(a.some((x) => x.text.includes('New South Wales')));
    });
  });

  /* ------------------------------------------------------------------ */
  describe('osm adapter (real cached Overpass response)', () => {
    if (!have('osm-au-chargers.json')) {
      it('skipped: no cached OSM file', () => 'skip');
      return;
    }
    const raw = readJson('osm-au-chargers.json');
    const { records, issues } = osm.normalise(raw, CTX);

    it('normalises the full national extract', () => {
      assert.atLeast(records.length, 1400, 'OSM AU coverage should be >1400 sites');
    });

    it('keeps way-mapped sites via `out center` (35 were ways)', () => {
      assert.ok(records.some((r) => r.sourceRecordId.startsWith('way/')), 'expected way records');
    });

    it('every record has a valid Australian coordinate', () => {
      const bad = records.filter(
        (r) => !Number.isFinite(r.lat) || !Number.isFinite(r.lng) || r.lat > -9 || r.lat < -44
      );
      assert.equal(bad.length, 0, `${bad.length} records outside AU`);
    });

    it('extracts CCS2 connectors from socket:type2_combo tags', () => {
      const withCcs2 = records.filter((r) => (r.connectors || []).some((c) => c.standard === 'CCS2'));
      assert.atLeast(withCcs2.length, 500, 'expected many CCS2 sites (785 tagged)');
    });

    it('extracts connector power from socket:*:output tags', () => {
      const withPower = records.filter((r) => r.maxPowerKw);
      assert.atLeast(withPower.length, 150);
      const ultra = records.filter((r) => r.maxPowerKw >= 250);
      assert.atLeast(ultra.length, 1, 'expected at least one 250kW+ site');
    });

    it('canonicalises operators into a small set', () => {
      const ops = new Set(records.map((r) => r.operator).filter(Boolean));
      assert.atLeast(ops.size, 20);
      assert.ok(ops.has('Tesla') || ops.has('Chargefox'), 'expected major networks present');
    });

    it('does not emit a raw-tag blob (keeps the artefact small)', () => {
      assert.equal(records[0].raw, undefined);
    });

    it('REGRESSION: refuses a mirror whose database is stale', () => {
      // On 2026-09-05 the kumi mirror returned HTTP 200 with a complete-looking
      // 1,493-element payload against the primary's 1,590 — nothing truncated,
      // no remark, but its database was months behind. A 6% silent coverage
      // loss, small enough to slip under the record-count drift threshold.
      const validate = osm.requests()[0].validate;
      const stale = {
        elements: [{ type: 'node', id: 1, lat: -33.8, lon: 151.2, tags: {} }],
        osm3s: { timestamp_osm_base: '2026-05-06T03:25:00Z' },
      };
      const problem = validate(stale);
      assert.ok(problem, 'a stale mirror must be refused');
      assert.includes(problem, 'stale');
    });

    it('accepts a fresh response and reports its data timestamp', () => {
      const validate = osm.requests()[0].validate;
      const fresh = {
        elements: [{ type: 'node', id: 1, lat: -33.8, lon: 151.2, tags: {} }],
        osm3s: { timestamp_osm_base: new Date(Date.now() - 3600000).toISOString() },
      };
      assert.equal(validate(fresh), null);
    });

    it('rejects a partial Overpass response carrying a remark', () => {
      const validate = osm.requests()[0].validate;
      const partial = {
        elements: [],
        remark: 'runtime error: Query timed out',
        osm3s: { timestamp_osm_base: new Date().toISOString() },
      };
      assert.includes(validate(partial), 'remark');
    });

    it('rejects a response missing its data timestamp', () => {
      const validate = osm.requests()[0].validate;
      assert.ok(validate({ elements: [{ type: 'node', id: 1, lat: -33.8, lon: 151.2 }], osm3s: {} }));
    });

    it('the shipped cache is itself fresh enough to pass validation', () => {
      assert.equal(osm.requests({ maxDataAgeDays: 3650 })[0].validate(raw), null);
    });

    it('normalises cleanly, with few issues', () => {
      assert.atMost(issues.length / records.length, 0.05, 'OSM issue rate should be tiny');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('nsw adapter (real cached TfNSW CSV)', () => {
    if (!have('nsw-ev.csv')) {
      it('skipped: no cached NSW file', () => 'skip');
      return;
    }
    const raw = readText('nsw-ev.csv');
    const { records, issues } = nsw.normalise(raw, CTX);

    it('parses the published row count', () => {
      assert.atLeast(records.length, 1800);
    });

    it('flags the unbuilt "Upcoming" rows as planned, not operational', () => {
      const planned = records.filter((r) => r.status === 'planned');
      assert.atLeast(planned.length, 50, 'expected the Upcoming rows to be flagged');
      assert.atMost(planned.length, 200);
      assert.ok(
        issues.some((i) => /planned\/unbuilt/.test(i.issue)),
        'planned sites should raise an issue for the report'
      );
    });

    it('synthesises stable ids where OBJECTID is empty (94% of rows)', () => {
      const synthetic = records.filter((r) => r.sourceRecordId.startsWith('row:'));
      assert.atLeast(synthetic.length, 1000);
      const ids = new Set(records.map((r) => r.sourceRecordId));
      assert.equal(ids.size, records.length, 'record ids must be unique');
    });

    it('reports unparseable power ratings rather than inventing numbers', () => {
      const powerIssues = issues.filter((i) => /power:/.test(i.issue));
      assert.atLeast(powerIssues.length, 300, 'the bare "AC" rows must be reported');
      const withPower = records.filter((r) => r.maxPowerKw);
      assert.atLeast(withPower.length, 900);
    });

    it('never marks a fee as free, since NSW publishes no fee field', () => {
      assert.ok(records.every((r) => r.fee === null), 'fee must stay unknown');
    });

    it('backfills postcode from the PCODE column and state as NSW', () => {
      const withPostcode = records.filter((r) => r.address && r.address.postcode);
      assert.atLeast(withPostcode.length / records.length, 0.9);
      assert.ok(records.every((r) => !r.address || r.address.state === 'NSW'));
    });

    it('folds operator aliases so BP and Tesla are not double-counted', () => {
      const ops = new Set(records.map((r) => r.operator));
      assert.notOk(ops.has('BP Australia'), '"BP Australia" should fold into BP Pulse');
      assert.notOk(ops.has('Tesla Motors'), '"Tesla Motors" should fold into Tesla');
    });

    it('resolves the current CSV resource via CKAN rather than a fixed filename', () => {
      const reqs = nsw.requests();
      assert.equal(reqs.length, 1);
      assert.includes(reqs[0].urls[0], 'package_show');
      assert.equal(typeof reqs[0].then, 'function');
    });

    it('CKAN follow-up skips resources marked "Not updated"', () => {
      const next = nsw.requests()[0].then({
        result: {
          resources: [
            { format: 'CSV', name: 'EV Charging Stations in NSW - Not updated', url: 'http://old', last_modified: '2030-01-01' },
            { format: 'CSV', name: 'EV Charging Locations in NSW', url: 'http://current', last_modified: '2026-04-20' },
            { format: 'PDF', name: 'docs', url: 'http://pdf' },
          ],
        },
      });
      assert.equal(next[0].urls[0], 'http://current');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('vic adapter (real cached WFS GeoJSON)', () => {
    if (!have('vic-dcav.json')) {
      it('skipped: no cached VIC file', () => 'skip');
      return;
    }
    const raw = readJson('vic-dcav.json');
    const { records, issues } = vic.normalise(raw, CTX);

    it('normalises the full feature collection', () => {
      assert.atLeast(records.length, 140);
    });

    it('REGRESSION: a PAST completion date means built, not planned', () => {
      // 96 of 152 rows carry a completion date, but most are in the past.
      // Treating any populated value as "planned" mislabelled 96 live sites.
      const planned = records.filter((r) => r.status === 'planned');
      assert.atMost(planned.length, 25, `only future-dated sites are planned, got ${planned.length}`);
      assert.atLeast(planned.length, 1, 'expected some genuinely future sites');
    });

    it('parses structured plug types including the CCS2/SAE synonym', () => {
      const withCcs2 = records.filter((r) => r.connectors.some((c) => c.standard === 'CCS2'));
      assert.atLeast(withCcs2.length, 80);
      const withChademo = records.filter((r) => r.connectors.some((c) => c.standard === 'CHAdeMO'));
      assert.atLeast(withChademo.length, 70);
    });

    it('treats "1 x CHAdeMO and 1 x CCS2/SAE" as two connectors, not three', () => {
      const conns = vic.parsePlugTypes('1 x CHAdeMO and 1 x CCS2/SAE');
      assert.equal(conns.length, 2);
      assert.deepEqual(conns.map((c) => c.standard).sort(), ['CCS2', 'CHAdeMO']);
    });

    it('recovers power from the chargers field', () => {
      assert.equal(vic.parseChargers('3 x 22kW Charger').maxKw, 22);
      const withPower = records.filter((r) => r.maxPowerKw);
      assert.atLeast(withPower.length, 60);
    });

    it('sets state to VIC and keeps the coverage caveat visible', () => {
      assert.ok(records.every((r) => !r.address || r.address.state === 'VIC'));
      assert.includes(vic.meta.coverageCaveat, 'Government-funded');
    });

    it('does not ingest the PlugShare link as data', () => {
      // The publisher includes plugshare_link; it is proprietary, so it must
      // live only in `extra` as an outbound reference, never as a data field.
      const r = records.find((x) => x.extra && x.extra.plugshareLink);
      if (r) {
        assert.equal(r.website, null, 'plugshare link must not become the site website');
      }
    });

    it('uses the working WFS workspace prefix', () => {
      assert.includes(vic.LAYER, 'open-data-platform:');
      assert.includes(vic.wfsUrl(), 'application%2Fjson');
    });

    it('rejects a WFS error response instead of accepting zero features', () => {
      const validate = vic.requests()[0].validate;
      assert.ok(validate({ type: 'FeatureCollection', features: [] }), 'empty must be an error');
      assert.ok(validate({ type: 'ExceptionReport' }), 'exception must be an error');
      assert.equal(validate(raw), null, 'the real payload must validate');
    });

    it('reports unparseable completion dates as issues', () => {
      const bad = issues.filter((i) => /unparseable/.test(i.issue));
      assert.atMost(bad.length, 10, 'most dates should parse');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('qld adapter (real cached TMR CSV)', () => {
    if (!have('qld-ev.csv')) {
      it('skipped: no cached QLD file', () => 'skip');
      return;
    }
    const raw = readText('qld-ev.csv');
    const { records, issues } = qld.normalise(raw, CTX);

    it('REGRESSION: parses 17 records, not 33 (newlines inside quoted fields)', () => {
      assert.equal(csvLib.parse(raw).length, records.length);
      assert.atLeast(records.length, 15);
      assert.atMost(records.length, 20);
    });

    it('covers the Super Highway corridor', () => {
      const names = records.map((r) => r.name);
      assert.includes(names, 'Cairns');
      assert.includes(names, 'Townsville');
    });

    it('reports the empty plug-count column instead of treating it as zero', () => {
      assert.ok(records.every((r) => r.plugCount === null));
      assert.atLeast(issues.filter((i) => /plug count/.test(i.issue)).length, 10);
    });

    it('declares the browser User-Agent the endpoint requires', () => {
      const req = qld.requests()[0];
      assert.includes(req.headers['user-agent'], 'Mozilla');
    });

    it('REGRESSION: rejects the HTML 403 page instead of parsing it as CSV', () => {
      const validate = qld.requests()[0].validate;
      assert.ok(validate('<html>Sorry, your request has failed.</html>'), 'HTML must be rejected');
      assert.ok(validate('Location Name,Foo\nx,y'), 'CSV without Latitude must be rejected');
      assert.equal(validate(raw), null, 'the real payload must validate');
    });

    it('marks the coverage caveat so QLD is not presented as complete', () => {
      assert.includes(qld.meta.coverageCaveat, 'not a complete');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('act adapter (real cached HTML page)', () => {
    if (!have('act-chargers.html')) {
      it('skipped: no cached ACT page', () => 'skip');
      return;
    }
    const raw = readText('act-chargers.html');
    const { records, issues } = act.normalise(raw, CTX);

    it('finds one table per district, seven in total', () => {
      const tables = act.findDistrictTables(raw);
      assert.equal(tables.length, 7);
      assert.deepEqual(
        tables.map((t) => t.district),
        [
          'Belconnen',
          'Gungahlin',
          'Inner North',
          'Inner South / East Canberra',
          'Molonglo/Weston Creek',
          'Woden Valley',
          'Tuggeranong',
        ]
      );
    });

    it('reads the totals the page states about itself', () => {
      const stated = act.statedTotals(raw);
      assert.equal(stated.chargers, 74);
      assert.equal(stated.bays, 131);
      assert.equal(stated.asOf, 'December 2025');
    });

    it('SELF-CHECK: parsed row sums reconcile with the page-stated totals', () => {
      // This is what makes an HTML scrape trustworthy: the page publishes its
      // own totals, so a broken parse cannot pass silently.
      const tables = act.findDistrictTables(raw);
      let chargers = 0;
      let bays = 0;
      for (const t of tables) {
        for (const row of t.rows) {
          chargers += parseInt(row[0], 10) || 0;
          bays += parseInt(row[1], 10) || 0;
        }
      }
      const stated = act.statedTotals(raw);
      assert.equal(chargers, stated.chargers);
      assert.equal(bays, stated.bays);
      assert.equal(act.requests()[0].validate(raw), null, 'validate() must pass on the real page');
    });

    it('rejects a page whose stated totals no longer match the rows', () => {
      // Simulate the publisher updating the headline figure without the
      // tables, or vice versa. Either way the two must agree or we refuse.
      const tampered = raw.replace(
        /(\d+)(\s+public EV chargers?\s+with\s+)(\d+)(\s+charging bays)/i,
        '80$2131$4'
      );
      assert.notEqual(tampered, raw, 'tamper must actually change the page');
      const problem = act.requests()[0].validate(tampered);
      assert.ok(problem, 'a totals mismatch must be refused');
      assert.includes(problem, 'do not match');
    });

    it('rejects a page where a table cell changed but the totals did not', () => {
      // Change the first data cell of the first charger table from 2 to 7.
      // Cells carry style attributes, so this matches the real markup.
      const tampered = raw.replace(
        /(<table[^>]*>[\s\S]*?<\/thead>[\s\S]*?<td[^>]*>)2(<\/td>)/i,
        '$17$2'
      );
      assert.notEqual(tampered, raw, 'tamper must actually change the page');
      const problem = act.requests()[0].validate(tampered);
      assert.ok(problem, 'a changed row that breaks the sum must be refused');
      assert.includes(problem, 'do not match');
    });

    it('rejects a restructured page with no charger tables', () => {
      const gutted = raw.replace(/<table[\s\S]*?<\/table>/gi, '');
      assert.ok(act.requests()[0].validate(gutted));
    });

    it('REGRESSION: pairs each district with its OWN on-the-way figure', () => {
      // Taking the first regex match in the lookback window instead of the
      // last attributed every district the previous district's number.
      const tables = act.findDistrictTables(raw);
      assert.deepEqual(
        tables.map((t) => t.onTheWayBays),
        [26, 4, 28, 24, 10, 10, 16]
      );
    });

    it('parses charger types including the spaced kW variant', () => {
      assert.deepEqual(act.parseChargerType('22kW AC'), { kw: 22, current: 'AC' });
      assert.deepEqual(act.parseChargerType('150 kW DC'), { kw: 150, current: 'DC' });
      assert.deepEqual(act.parseChargerType('200kW DC'), { kw: 200, current: 'DC' });
    });

    it('parses plug types, including "Bring your own Type 1 or Type 2"', () => {
      assert.deepEqual(act.parsePlugTypes('CCS2 and CHAdeMO').map((c) => c.standard), ['CCS2', 'CHAdeMO']);
      assert.deepEqual(act.parsePlugTypes('Type 2').map((c) => c.standard), ['Type2']);
      const byo = act.parsePlugTypes('Bring your own Type 1 or Type 2');
      assert.deepEqual(byo.map((c) => c.standard), ['Type1', 'Type2']);
      assert.equal(byo[0].bringYourOwnCable, true);
    });

    it('splits a venue name from its street address', () => {
      const s = act.splitLocation('Sentinel Apartments 39 Benjamin Way, Belconnen');
      assert.equal(s.name, 'Sentinel Apartments');
      assert.equal(s.address, '39 Benjamin Way, Belconnen');
    });

    it('normalises the geocodable rows into records', () => {
      assert.atLeast(records.length, 30);
      assert.atMost(records.length, 35);
      assert.ok(records.every((r) => r.state === undefined || true));
    });

    it('marks every record as geocoded and inside Australia', () => {
      assert.ok(records.every((r) => r.geocoded === true), 'ACT coordinates are all derived');
      const bad = records.filter((r) => !geoCore.isInAustralia(r.lat, r.lng));
      assert.equal(bad.length, 0);
    });

    it('sets status to unknown, because the page reports funding not delivery', () => {
      assert.ok(records.every((r) => r.status === 'unknown'));
      assert.ok(issues.some((i) => /funding, not delivery/.test(i.issue)));
    });

    it('does not invent an operator (the page maps grants, not sites)', () => {
      assert.ok(records.every((r) => r.operator === null));
    });

    it('drops, and reports, an address that would not geocode', () => {
      const rejected = issues.filter((i) => i.kind === 'rejected');
      assert.atLeast(rejected.length, 1, 'the ANU campus row has no resolvable address');
      assert.ok(rejected.some((i) => /geocod/i.test(i.issue)));
    });

    it('keeps the ACT bay count as the plug count', () => {
      assert.ok(records.some((r) => Number.isFinite(r.plugCount) && r.plugCount > 1));
    });

    it('states the coverage caveat, since this is funded chargers only', () => {
      assert.includes(act.meta.coverageCaveat, 'Government-funded');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('tas adapter (real cached HTML page)', () => {
    if (!have('tas-chargesmart.html')) {
      it('skipped: no cached TAS page', () => 'skip');
      return;
    }
    const raw = readText('tas-chargesmart.html');
    const { records, issues } = tas.normalise(raw, CTX);

    it('finds exactly the three tables that publish a Location column', () => {
      const tables = tas.findLocationTables(raw);
      assert.equal(tables.length, 3);
      assert.deepEqual(
        tables.map((t) => tas.grantCategory(t.heading)),
        [null, 'fast', 'destination']
      );
    });

    it('SELF-CHECK: parsed grants reconcile with each table stated total', () => {
      // The strongest validation available here is financial: every table ends
      // with a "Total" row, so a mis-parse breaks the sum.
      const tables = tas.findLocationTables(raw);
      const expected = [567000, 710500, 62500];
      tables.forEach((t, i) => {
        const summed = t.rows.reduce((a, r) => a + (tas.parseMoney(r[r.length - 1]) || 0), 0);
        assert.equal(t.statedTotal, expected[i], 'stated total changed upstream');
        assert.equal(summed, t.statedTotal, `table ${i} does not reconcile`);
      });
      assert.equal(tas.requests()[0].validate(raw), null, 'validate() must pass on the real page');
    });

    /**
     * Tampering these pages is fiddly, and getting it wrong produces a test
     * that passes while proving nothing — which happened twice here. Both
     * money figures appear in the page's PROSE before they appear in a table
     * ("the Tasmanian Government is awarding $567,000..."), so a naive
     * String.replace edits the prose and leaves the tables untouched.
     *
     * So each tamper below asserts that it actually changed the PARSED table
     * data before asserting that validation rejects it.
     */
    const tamperLastOccurrence = (text, find, replaceWith) => {
      const at = text.lastIndexOf(find);
      if (at === -1) return text;
      return text.slice(0, at) + replaceWith + text.slice(at + find.length);
    };

    it('rejects a page whose stated grant total no longer reconciles', () => {
      // The LAST occurrence of the figure is the Total row; the first is prose.
      const tampered = tamperLastOccurrence(raw, '$567,000', '$999,000');
      const before = tas.findLocationTables(raw)[0].statedTotal;
      const after = tas.findLocationTables(tampered)[0].statedTotal;
      assert.equal(before, 567000);
      assert.equal(after, 999000, 'tamper must change the PARSED stated total');

      const problem = tas.requests()[0].validate(tampered);
      assert.ok(problem, 'a totals mismatch must be refused');
      assert.includes(problem, 'states');
    });

    it('rejects a page where a grant row changed but the total did not', () => {
      // Money cells are wrapped in a <p> inside the <td>, so match the text
      // node rather than assuming the figure sits directly in the cell.
      const tampered = raw.replace(/>\s*\$47,500\s*</, '>$77,500<');
      const sum = (text) =>
        tas
          .findLocationTables(text)[0]
          .rows.reduce((a, r) => a + (tas.parseMoney(r[r.length - 1]) || 0), 0);
      assert.notEqual(sum(tampered), sum(raw), 'tamper must change the PARSED row sum');

      const problem = tas.requests()[0].validate(tampered);
      assert.ok(problem, 'an edited row that breaks the sum must be refused');
      assert.includes(problem, 'states');
    });

    it('excludes the Total summary row from the data', () => {
      assert.ok(records.every((r) => !/^total/i.test(r.extra.organisationRaw || '')));
    });

    it('reports, and does NOT ingest, the 38 rows that publish no location', () => {
      const locationless = tas.findLocationlessTables(raw);
      const rows = locationless.reduce((a, t) => a + t.rows.length, 0);
      assert.equal(locationless.length, 3, 'the 2018-19 round has three tables');
      assert.atLeast(rows, 30);
      assert.ok(
        issues.some((i) => /publish no Location column/.test(i.issue)),
        'the gap must be reported, not silently dropped'
      );
      // None of those organisations should appear as records.
      assert.ok(records.every((r) => !/City of Hobart/i.test(r.name || '')));
    });

    it('ingests the located rows', () => {
      assert.atLeast(records.length, 50);
      assert.atMost(records.length, 56);
    });

    it('marks EVERY record as town-level precision', () => {
      assert.ok(
        records.every((r) => r.positionPrecision === nrmCore.POSITION_PRECISION.GEOCODED_LOCALITY),
        'a town centroid is not a charger position'
      );
      assert.ok(records.every((r) => !nrmCore.isMappable(r)));
    });

    it('places every record inside Tasmania', () => {
      const bad = records.filter(
        (r) =>
          r.lat < tas.TAS_BBOX.minLat ||
          r.lat > tas.TAS_BBOX.maxLat ||
          r.lng < tas.TAS_BBOX.minLng ||
          r.lng > tas.TAS_BBOX.maxLng
      );
      assert.equal(bad.length, 0);
      assert.ok(records.every((r) => r.address.state === 'TAS'));
    });

    it('guards against ambiguous mainland town names', () => {
      // Richmond, Kingston, Exeter, Longford and Sheffield all exist on the
      // mainland too; a mainland match must be rejected, not mapped.
      for (const town of ['Richmond', 'Kingston', 'Exeter', 'Longford', 'Sheffield']) {
        const rec = records.find((r) => r.extra.town === town);
        if (!rec) continue;
        assert.ok(
          rec.lat >= tas.TAS_BBOX.minLat && rec.lat <= tas.TAS_BBOX.maxLat,
          `${town} resolved outside Tasmania`
        );
      }
    });

    it('splits a parenthetical qualifier from the town', () => {
      assert.deepEqual(tas.parseLocation('St Helens (Upgrade)'), {
        town: 'St Helens',
        qualifier: 'Upgrade',
      });
      assert.deepEqual(tas.parseLocation('Shearwater (Port Sorell)'), {
        town: 'Shearwater',
        qualifier: 'Port Sorell',
      });
    });

    it('recovers the published plug count from "(two chargers)"', () => {
      assert.equal(tas.parseChargerCount('Stewarts Bay Lodge (two chargers)'), 2);
      assert.equal(tas.parseChargerCount('Auldington Hotel'), null);
      assert.equal(tas.cleanOrganisation('Stewarts Bay Lodge (two chargers)'), 'Stewarts Bay Lodge');
      assert.ok(records.some((r) => r.plugCount === 2));
    });

    it('decodes numeric HTML entities', () => {
      assert.equal(tas.stripTags('Bennett&#8217;s Petroleum'), 'Bennett’s Petroleum');
      assert.equal(tas.stripTags('a&#160;b'), 'a b');
    });

    it('derives connectors from the published grant category, not invented standards', () => {
      // The page states no plug types, so claiming CCS2 would be fabrication.
      const fast = records.find((r) => r.extra.grantCategory === 'fast');
      const dest = records.find((r) => r.extra.grantCategory === 'destination');
      assert.equal(fast.connectors[0].standard, nrmCore.CONNECTORS.DC_UNSPECIFIED);
      assert.equal(dest.connectors[0].standard, nrmCore.CONNECTORS.AC_UNSPECIFIED);
      assert.ok(records.every((r) => r.maxPowerKw === null), 'no power ratings are published');
    });

    it('sets status unknown, because the page reports funding not delivery', () => {
      assert.ok(records.every((r) => r.status === 'unknown'));
      assert.ok(issues.some((i) => /funding, not delivery/.test(i.issue)));
    });

    it('records the grant amount and round for provenance', () => {
      assert.ok(records.every((r) => Number.isFinite(r.extra.grantAmountAud)));
      assert.ok(records.every((r) => r.extra.round));
      assert.ok(records.some((r) => /Chargesmart 3/i.test(r.extra.round)));
    });

    it('states the coverage caveat prominently', () => {
      assert.includes(tas.meta.coverageCaveat, 'TOWN level');
      assert.includes(tas.meta.coverageCaveat, 'Excluded from the default map view');
      assert.equal(tas.meta.positionPrecision, nrmCore.POSITION_PRECISION.GEOCODED_LOCALITY);
    });

    it('flags that the licence could not be directly verified', () => {
      // Honesty about evidence: the ReCFIT copyright page is behind Cloudflare.
      assert.equal(tas.meta.licenceVerified, false);
    });

    it('uses the canonical URL, not the Cloudflare-blocked redirect', () => {
      assert.includes(tas.PAGE_URL, 'nre.tas.gov.au');
      assert.notOk(/recfit\.tas\.gov\.au/.test(tas.PAGE_URL));
    });
  });

  /* ------------------------------------------------------------------ */
  describe('ocm adapter (licence safety)', () => {
    it('emits no requests without an API key, so ingest degrades gracefully', () => {
      const saved = process.env.OCM_API_KEY;
      delete process.env.OCM_API_KEY;
      assert.equal(registry.ocm.requests({}).length, 0);
      if (saved !== undefined) process.env.OCM_API_KEY = saved;
    });

    it('pins opendata=true so proprietary provider records are excluded', () => {
      const reqs = registry.ocm.requests({ apiKey: 'test-key-123' });
      assert.equal(reqs.length, 1);
      assert.includes(reqs[0].urls[0], 'opendata=true');
    });

    it('declares the key for redaction so it never reaches the manifest', () => {
      const reqs = registry.ocm.requests({ apiKey: 'secret-abc' });
      assert.includes(reqs[0].redact, 'secret-abc');
    });

    it('drops records whose provider is not open-data licensed', () => {
      const { records, issues } = registry.ocm.normalise(
        [
          {
            ID: 1,
            AddressInfo: { Latitude: -33.87, Longitude: 151.21, Title: 'Open Site' },
            DataProvider: { Title: 'OpenAU', IsOpenDataLicensed: true },
            Connections: [],
          },
          {
            ID: 2,
            AddressInfo: { Latitude: -33.88, Longitude: 151.22, Title: 'Closed Site' },
            DataProvider: { Title: 'ProprietaryCo', IsOpenDataLicensed: false },
            Connections: [],
          },
        ],
        CTX
      );
      assert.equal(records.length, 1);
      assert.equal(records[0].name, 'Open Site');
      assert.ok(issues.some((i) => /not open-data licensed/.test(i.issue)));
    });

    it('retains the per-record Data Provider that OCM requires be displayed', () => {
      const { records } = registry.ocm.normalise(
        [
          {
            ID: 3,
            AddressInfo: { Latitude: -33.87, Longitude: 151.21, Title: 'X' },
            DataProvider: { Title: 'SomeProvider', IsOpenDataLicensed: true, License: 'CC-BY 4.0' },
            Connections: [{ ConnectionType: { Title: 'CCS (Type 2)' }, Quantity: 2, PowerKW: 350 }],
          },
        ],
        CTX
      );
      assert.equal(records[0].extra.dataProvider, 'SomeProvider');
      assert.equal(records[0].connectors[0].standard, 'CCS2');
      assert.equal(records[0].maxPowerKw, 350);
    });
  });
};
