'use strict';
/**
 * Core unit tests.
 *
 * Every case marked "REGRESSION" encodes a real defect found while building
 * against live Australian data on 2026-09-05, or a real value observed in a
 * published dataset. Those are the tests worth keeping.
 */

const { assert, describe, it } = require('./harness');

const csv = require('../src/core/csv');
const geo = require('../src/core/geo');
const nrm = require('../src/core/normalise');
const resolve = require('../src/core/resolve');
const search = require('../src/core/search');

module.exports = function run() {
  /* ------------------------------------------------------------------ */
  describe('csv', () => {
    it('parses a simple table', () => {
      const rows = csv.parse('a,b\n1,2\n3,4\n');
      assert.equal(rows.length, 2);
      assert.equal(rows[0].a, '1');
      assert.equal(rows[1].b, '4');
    });

    it('strips a UTF-8 BOM (REGRESSION: TfNSW ships one on the header row)', () => {
      const rows = csv.parse('﻿OBJECTID,Station_name\n1,Foo\n');
      assert.deepEqual(Object.keys(rows[0]), ['OBJECTID', 'Station_name']);
      assert.equal(rows[0].OBJECTID, '1');
    });

    it('handles newlines inside quoted fields (REGRESSION: QLD 34 lines = 17 records)', () => {
      const text =
        'Location Name,Nearest\n' +
        'Gatton,"Toowoomba: 55km West, \nBrisbane: 92km East"\n' +
        'Cairns,"Tully: 141km South"\n';
      const rows = csv.parse(text);
      assert.equal(rows.length, 2, 'embedded newline must not create a third record');
      assert.includes(rows[0].Nearest, 'Brisbane');
    });

    it('handles escaped double quotes', () => {
      const rows = csv.parse('a\n"say ""hi"""\n');
      assert.equal(rows[0].a, 'say "hi"');
    });

    it('handles CRLF line endings', () => {
      const rows = csv.parse('a,b\r\n1,2\r\n');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].b, '2');
    });

    it('does not lose duplicate column names', () => {
      const rows = csv.parse('a,a\n1,2\n');
      assert.equal(rows[0].a, '1');
      assert.equal(rows[0].a_2, '2');
    });

    it('round-trips through stringify', () => {
      const original = [{ a: 'x,y', b: 'line\nbreak' }];
      const reparsed = csv.parse(csv.stringify(original, ['a', 'b']));
      assert.deepEqual(reparsed, original);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('geo', () => {
    it('computes a known distance (Sydney Opera House to Harbour Bridge ~= 900m)', () => {
      const d = geo.distanceMetres(-33.8568, 151.2153, -33.8523, 151.2108);
      assert.closeTo(d, 640, 200);
    });

    it('returns zero distance for identical points', () => {
      assert.equal(geo.distanceMetres(-33.8, 151.2, -33.8, 151.2), 0);
    });

    it('rejects null island (REGRESSION: 0,0 appears in bad gov exports)', () => {
      assert.notOk(geo.isValidLatLng(0, 0));
      assert.ok(geo.isValidLatLng(-33.8, 151.2));
    });

    it('bounds Australia correctly', () => {
      assert.ok(geo.isInAustralia(-33.87, 151.21), 'Sydney');
      assert.ok(geo.isInAustralia(-31.95, 115.86), 'Perth');
      assert.notOk(geo.isInAustralia(51.5, -0.12), 'London');
      assert.notOk(geo.isInAustralia(-36.85, 174.76), 'Auckland is east of the bbox');
    });

    it('infers state from coordinates, with ACT tested before NSW', () => {
      assert.equal(geo.stateFromLatLng(-35.28, 149.13), 'ACT', 'Canberra');
      assert.equal(geo.stateFromLatLng(-33.87, 151.21), 'NSW', 'Sydney');
      assert.equal(geo.stateFromLatLng(-37.81, 144.96), 'VIC', 'Melbourne');
      assert.equal(geo.stateFromLatLng(-27.47, 153.03), 'QLD', 'Brisbane');
      assert.equal(geo.stateFromLatLng(-31.95, 115.86), 'WA', 'Perth');
      assert.equal(geo.stateFromLatLng(-34.93, 138.6), 'SA', 'Adelaide');
      assert.equal(geo.stateFromLatLng(-42.88, 147.33), 'TAS', 'Hobart');
      assert.equal(geo.stateFromLatLng(-12.46, 130.84), 'NT', 'Darwin');
    });

    it('produces neighbour keys that include the home cell', () => {
      const keys = geo.neighbourKeys(-33.87, 151.21, 250);
      assert.equal(keys.length, 9);
      assert.includes(keys, geo.cellKey(-33.87, 151.21, 250));
    });

    it('bboxAround contains the centre and excludes far points', () => {
      const b = geo.bboxAround(-33.87, 151.21, 1000);
      assert.ok(-33.87 >= b.minLat && -33.87 <= b.maxLat);
      assert.ok(151.21 >= b.minLng && 151.21 <= b.maxLng);
      assert.ok(b.maxLat - b.minLat < 0.05);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('normalise: operators', () => {
    it('folds BP aliases (REGRESSION: TfNSW has "BP" x32 and "BP Australia" x28)', () => {
      assert.equal(nrm.normaliseOperator('BP'), 'BP Pulse');
      assert.equal(nrm.normaliseOperator('BP Australia'), 'BP Pulse');
      assert.equal(nrm.normaliseOperator('bp pulse'), 'BP Pulse');
    });

    it('folds Tesla aliases (REGRESSION: "Tesla" x260 vs "Tesla Motors" x27)', () => {
      assert.equal(nrm.normaliseOperator('Tesla'), 'Tesla');
      assert.equal(nrm.normaliseOperator('Tesla Motors'), 'Tesla');
      assert.equal(nrm.normaliseOperator('Tesla Australia'), 'Tesla');
    });

    it('folds Evie and Chargefox spellings', () => {
      assert.equal(nrm.normaliseOperator('Evie'), 'Evie Networks');
      assert.equal(nrm.normaliseOperator('evie networks'), 'Evie Networks');
      assert.equal(nrm.normaliseOperator('Charge Fox'), 'Chargefox');
    });

    it('maps unknown-ish values to Non-networked', () => {
      assert.equal(nrm.normaliseOperator('Non-networked'), 'Non-networked');
      assert.equal(nrm.normaliseOperator('n/a'), 'Non-networked');
    });

    it('passes unrecognised operators through rather than discarding them', () => {
      assert.equal(nrm.normaliseOperator('Tiny Regional Council'), 'Tiny Regional Council');
    });

    it('returns null for empty input', () => {
      assert.equal(nrm.normaliseOperator(''), null);
      assert.equal(nrm.normaliseOperator(null), null);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('normalise: power ratings', () => {
    it('parses a plain rating', () => {
      const p = nrm.parsePowerRating('22 kW');
      assert.equal(p.maxKw, 22);
      assert.deepEqual(p.groups, [{ count: 1, kw: 22 }]);
    });

    it('parses multi-bank strings (REGRESSION: "2x350kW & 2x175kW" appears 85 times)', () => {
      const p = nrm.parsePowerRating('2x350kW & 2x175kW');
      assert.equal(p.maxKw, 350);
      assert.deepEqual(p.groups, [
        { count: 2, kw: 350 },
        { count: 2, kw: 175 },
      ]);
    });

    it('treats a bare current type as NO rating (REGRESSION: "AC" appears 522 times)', () => {
      const p = nrm.parsePowerRating('AC');
      assert.equal(p.maxKw, null);
      assert.deepEqual(p.groups, []);
      assert.includes(p.note, 'no rating');
    });

    it('rejects implausible values rather than trusting them', () => {
      assert.equal(nrm.parsePowerRating('99999 kW').maxKw, null);
      assert.equal(nrm.parsePowerRating('0.2 kW').maxKw, null);
    });

    it('handles Victorian "3 x 22kW Charger" phrasing', () => {
      const p = nrm.parsePowerRating('3 x 22kW Charger');
      assert.equal(p.maxKw, 22);
      assert.equal(p.groups[0].count, 3);
    });

    it('assigns speed bands at the boundaries', () => {
      assert.equal(nrm.speedBand(null), 'unknown');
      assert.equal(nrm.speedBand(3), 'trickle');
      assert.equal(nrm.speedBand(22), 'slow');
      assert.equal(nrm.speedBand(25), 'medium');
      assert.equal(nrm.speedBand(50), 'fast');
      assert.equal(nrm.speedBand(150), 'rapid');
      assert.equal(nrm.speedBand(350), 'ultra');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('normalise: connectors, status, access, fee', () => {
    it('maps OSM socket keys to canonical standards', () => {
      assert.equal(nrm.normaliseConnector('socket:type2_combo'), 'CCS2');
      assert.equal(nrm.normaliseConnector('type2_combo'), 'CCS2');
      assert.equal(nrm.normaliseConnector('chademo'), 'CHAdeMO');
      assert.equal(nrm.normaliseConnector('type2'), 'Type2');
      assert.equal(nrm.normaliseConnector('tesla_supercharger'), 'TeslaProprietary');
    });

    it('maps Victorian plug labels including the CCS2/SAE synonym', () => {
      assert.equal(nrm.normaliseConnector('CCS2'), 'CCS2');
      assert.equal(nrm.normaliseConnector('Type 2'), 'Type2');
      assert.equal(nrm.normaliseConnector('CCS2/SAE'.split('/')[0]), 'CCS2');
    });

    it('flags Upcoming as planned (REGRESSION: 98 unbuilt NSW rows)', () => {
      assert.equal(nrm.normaliseStatus('Upcoming'), 'planned');
      assert.equal(nrm.normaliseStatus('Active'), 'operational');
      assert.equal(nrm.normaliseStatus('Existing Fast Chargers'), 'operational');
      assert.equal(nrm.normaliseStatus('removed'), 'decommissioned');
      assert.equal(nrm.normaliseStatus(''), 'unknown');
    });

    it('normalises OSM access values', () => {
      assert.equal(nrm.normaliseAccess('yes'), 'public');
      assert.equal(nrm.normaliseAccess('customers'), 'restricted');
      assert.equal(nrm.normaliseAccess('private'), 'private');
      assert.equal(nrm.normaliseAccess(''), 'unknown');
    });

    it('keeps unknown fee as null, never as free', () => {
      assert.equal(nrm.normaliseFee(''), null, 'absent fee must not imply free');
      assert.equal(nrm.normaliseFee('yes'), true);
      assert.equal(nrm.normaliseFee('no'), false);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('normalise: addresses and dates', () => {
    it('parses a standard address', () => {
      const a = nrm.parseAddress('38 Abbott Rd, Seven Hills NSW 2147');
      assert.equal(a.street, '38 Abbott Rd');
      assert.equal(a.suburb, 'Seven Hills');
      assert.equal(a.state, 'NSW');
      assert.equal(a.postcode, '2147');
    });

    it('handles an empty street segment (REGRESSION: ", Muswellbrook, 2333")', () => {
      const a = nrm.parseAddress(', Muswellbrook, 2333');
      assert.equal(a.suburb, 'Muswellbrook', 'locality must not be filed as a street');
      assert.equal(a.street, null);
      assert.equal(a.postcode, '2333');
    });

    it('parses day-first dates (REGRESSION: AU "31/07/2023", not July 31 US-style)', () => {
      const d = nrm.parseLooseDate('31/07/2023');
      assert.equal(d.getUTCFullYear(), 2023);
      assert.equal(d.getUTCMonth(), 6, 'July');
      assert.equal(d.getUTCDate(), 31);
    });

    it('parses month-year and long-form dates', () => {
      assert.equal(nrm.parseLooseDate('December 2026').getUTCMonth(), 11);
      assert.equal(nrm.parseLooseDate('30 November 2023').getUTCDate(), 30);
    });

    it('returns null for unparseable dates instead of guessing', () => {
      assert.equal(nrm.parseLooseDate('sometime soon'), null);
      assert.equal(nrm.parseLooseDate(''), null);
    });

    it('scores token similarity sensibly', () => {
      assert.greaterThan(nrm.tokenSimilarity('Ampol Foodary Seven Hills', 'Ampol Seven Hills'), 0.6);
      assert.atMost(nrm.tokenSimilarity('Chargefox Ballarat', 'Tesla Geelong'), 0.05);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('resolve: matching', () => {
    const base = (over) => ({
      sourceId: 'osm',
      sourceRecordId: 'node/1',
      fetchedAt: '2026-09-05T00:00:00.000Z',
      lat: -33.87,
      lng: 151.21,
      name: null,
      operator: null,
      connectors: [],
      status: 'operational',
      ...over,
    });

    it('links two records at the same spot with no conflicting fields', () => {
      const { score } = resolve.scorePair(base({}), base({ sourceId: 'nsw', lat: -33.8701 }));
      assert.atLeast(score, resolve.MATCH.scoreThreshold);
    });

    it('refuses to link records beyond the distance ceiling', () => {
      const { score } = resolve.scorePair(base({}), base({ lat: -33.9 }));
      assert.equal(score, 0);
    });

    it('penalises conflicting operators at the same location', () => {
      const a = base({ operator: 'Tesla' });
      const b = base({ sourceId: 'nsw', operator: 'Chargefox', lat: -33.8702 });
      const { score } = resolve.scorePair(a, b);
      assert.ok(score < resolve.MATCH.scoreThreshold, `expected no link, got ${score}`);
    });

    it('keeps distinct chargers in one car park separate when operators differ', () => {
      const records = [
        base({ operator: 'Tesla', name: 'Tesla Supercharger' }),
        base({ sourceId: 'nsw', sourceRecordId: 'r2', operator: 'Chargefox', name: 'Chargefox', lat: -33.8703 }),
      ];
      const { sites } = resolve.resolve(records);
      assert.equal(sites.length, 2);
    });

    it('merges the same site reported by two sources', () => {
      const records = [
        base({ operator: 'Evie Networks', name: 'Evie Murrayville' }),
        base({ sourceId: 'vic', sourceRecordId: 'dcav:1', operator: 'Evie Networks', lat: -33.8701, lng: 151.2101 }),
      ];
      const { sites, stats } = resolve.resolve(records);
      assert.equal(sites.length, 1);
      assert.equal(sites[0].sourceCount, 2);
      assert.equal(stats.merged, 1);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('positional precision', () => {
    const site = (precision, over) => ({
      id: precision,
      name: 'X',
      displayName: 'X',
      operator: null,
      lat: -41.9,
      lng: 146.7,
      state: 'TAS',
      maxPowerKw: 50,
      speedBand: 'fast',
      connectors: [],
      status: 'operational',
      sourceCount: 1,
      confidence: 0.5,
      conflicts: {},
      address: null,
      positionPrecision: precision,
      ...over,
    });

    it('grades precision rather than treating geocoding as a boolean', () => {
      assert.equal(nrm.positionPrecision({}), 'surveyed', 'default for coordinate-publishing sources');
      assert.equal(nrm.positionPrecision({ geocoded: true }), 'geocoded_address', 'legacy flag maps forward');
      assert.equal(
        nrm.positionPrecision({ positionPrecision: 'geocoded_locality' }),
        'geocoded_locality'
      );
    });

    it('treats only surveyed and street-level positions as mappable', () => {
      assert.ok(nrm.isMappable(site('surveyed')));
      assert.ok(nrm.isMappable(site('geocoded_address')));
      assert.notOk(nrm.isMappable(site('geocoded_locality')), 'a town centroid is not a location');
    });

    it('records a nominal error budget per precision', () => {
      const e = nrm.PRECISION_ERROR_METRES;
      assert.ok(e.surveyed < e.geocoded_address);
      assert.ok(e.geocoded_address < e.geocoded_locality);
      assert.atLeast(e.geocoded_locality, 1000, 'town-level error is kilometres');
    });

    it('EXCLUDES town-level records from search by default', () => {
      const sites = [site('surveyed'), site('geocoded_address'), site('geocoded_locality')];
      const def = search.query(sites, {});
      assert.equal(def.total, 2);
      assert.notOk(def.results.some((s) => s.id === 'geocoded_locality'));
    });

    it('includes them on explicit opt-in', () => {
      const sites = [site('surveyed'), site('geocoded_address'), site('geocoded_locality')];
      assert.equal(search.query(sites, { includeApproximate: true }).total, 3);
      const only = search.query(sites, { precisions: ['geocoded_locality'] });
      assert.equal(only.total, 1);
      assert.equal(only.results[0].id, 'geocoded_locality');
    });

    it('keeps town-level records SEARCHABLE by name, which is the point', () => {
      const sites = [site('geocoded_locality', { name: 'Electric Highway Tasmania — Miena', displayName: 'Electric Highway Tasmania — Miena' })];
      assert.equal(search.query(sites, { text: 'Miena' }).total, 0, 'hidden by default');
      assert.equal(
        search.query(sites, { text: 'Miena', includeApproximate: true }).total,
        1,
        'findable when asked for'
      );
    });

    it('never offers a town centroid as the nearest charger', () => {
      // /api/nearest is the endpoint most likely to be trusted for navigation.
      const sites = [site('geocoded_locality'), site('surveyed', { id: 'real', lat: -42.5, lng: 147.3 })];
      const n = search.nearest(sites, -41.9, 146.7, 5);
      assert.equal(n.length, 1);
      assert.equal(n[0].id, 'real');
    });

    it('exposes precision as a facet', () => {
      const sites = [site('surveyed'), site('geocoded_locality')];
      const r = search.query(sites, { includeApproximate: true });
      assert.equal(r.facets.positionPrecision.surveyed, 1);
      assert.equal(r.facets.positionPrecision.geocoded_locality, 1);
    });

    it('NEVER merges a town-level record with anything', () => {
      // A town centroid can land within the 250m matching ceiling of an
      // unrelated charger, which would attach a funding record to the wrong site.
      const rec = (over) => ({
        sourceId: 'tas',
        sourceRecordId: 't1',
        fetchedAt: '2026-09-05T00:00:00.000Z',
        lat: -41.9,
        lng: 146.7,
        name: 'Miena',
        operator: null,
        connectors: [],
        status: 'unknown',
        ...over,
      });
      const locality = rec({ positionPrecision: 'geocoded_locality' });
      const surveyed = rec({
        sourceId: 'osm',
        sourceRecordId: 'node/1',
        name: 'Miena',
        positionPrecision: 'surveyed',
        lat: -41.9,
        lng: 146.7,
      });
      // Identical coordinates AND identical names — still must not merge.
      const { score, reasons } = resolve.scorePair(locality, surveyed);
      assert.equal(score, 0);
      assert.ok(reasons.some((r) => /town level/.test(r)));
      assert.equal(resolve.resolve([locality, surveyed]).sites.length, 2);
    });

    it('penalises confidence for an imprecise position', () => {
      const mk = (precision) => ({
        sourceId: 'x',
        sourceRecordId: 'r',
        fetchedAt: '2026-09-05T00:00:00.000Z',
        lat: -41.9,
        lng: 146.7,
        name: 'Somewhere',
        operator: 'Evie Networks',
        address: nrm.parseAddress('1 Test St, Hobart TAS 7000'),
        connectors: [{ standard: 'CCS2', count: 1, powerKw: 50 }],
        maxPowerKw: 50,
        status: 'operational',
        positionPrecision: precision,
      });
      const surveyed = resolve.mergeCluster([mk('surveyed')]);
      const address = resolve.mergeCluster([mk('geocoded_address')]);
      const locality = resolve.mergeCluster([mk('geocoded_locality')]);
      assert.ok(surveyed.confidence > address.confidence, 'street-level is less certain than surveyed');
      assert.ok(address.confidence > locality.confidence, 'town-level is least certain');
    });

    it('carries the best available precision through a merge', () => {
      const rec = (over) => ({
        sourceId: 'act',
        sourceRecordId: 'a1',
        fetchedAt: '2026-09-05T00:00:00.000Z',
        lat: -35.3,
        lng: 149.1,
        name: 'Shared Venue',
        operator: null,
        connectors: [],
        status: 'unknown',
        ...over,
      });
      const merged = resolve.mergeCluster([
        rec({ positionPrecision: 'geocoded_address' }),
        rec({ sourceId: 'osm', sourceRecordId: 'node/9', positionPrecision: 'surveyed' }),
      ]);
      assert.equal(merged.positionPrecision, 'surveyed', 'the better precision wins');
      assert.equal(merged.geocoded, false);
      assert.equal(merged.provenance.lat.sourceId, 'osm');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('resolve: cross-vocabulary names and geocoded coordinates', () => {
    const rec = (over) => ({
      sourceId: 'act',
      sourceRecordId: 'act:1',
      fetchedAt: '2026-09-05T00:00:00.000Z',
      lat: -35.2418,
      lng: 149.1268,
      name: null,
      operator: null,
      connectors: [],
      status: 'unknown',
      ...over,
    });

    it('treats an operator-fallback name as not describing the venue', () => {
      assert.equal(resolve.describesVenue(rec({ name: 'Eastlake Football Club' })), true);
      assert.equal(
        resolve.describesVenue(rec({ name: 'Exploren', nameFromOperator: true })),
        false
      );
      // Belt and braces: a name that merely repeats the operator is the same case.
      assert.equal(
        resolve.describesVenue(rec({ name: 'Evie Networks', operator: 'Evie Networks' })),
        false
      );
    });

    it('REGRESSION: a venue name vs an operator name must not block a 0m match', () => {
      // Measured: ACT "Next Gen Canberra" and OSM "Exploren" sit 0 metres
      // apart, but the name-conflict penalty rejected the pair (score 0.45),
      // because one source names the venue and the other names the network.
      const actRec = rec({ name: 'Next Gen Canberra', geocoded: true });
      const osmRec = {
        ...rec({ sourceId: 'osm', name: 'Exploren', nameFromOperator: true, operator: 'Exploren' }),
        geocoded: undefined,
      };
      const { score } = resolve.scorePair(actRec, osmRec);
      assert.atLeast(score, resolve.MATCH.scoreThreshold, `expected a link, got ${score}`);
    });

    it('still penalises a genuine conflict between two venue names', () => {
      const a = rec({ name: 'Eastlake Football Club', sourceId: 'act' });
      const b = rec({ name: 'Hotel Realm', sourceId: 'vic', lat: -35.2419 });
      const { score, reasons } = resolve.scorePair(a, b);
      assert.ok(
        reasons.some((r) => /name conflict/.test(r)),
        'two comparable venue names that disagree should still conflict'
      );
      assert.ok(score < 0.8);
    });

    it('REGRESSION: two geocoded records at 0m stay separate without name agreement', () => {
      // The ACT lists "Mawson Club" (10 Heard St) and "Southlands Shopping
      // Centre" (12 Heard St) separately; the geocoder resolved both to the
      // SAME coordinate. Distance carries no information between two geocoded
      // records, so merging them would invent a site that does not exist.
      const a = rec({ name: 'Mawson Club', geocoded: true });
      const b = rec({ name: 'Southlands Shopping Centre', geocoded: true, sourceRecordId: 'act:2' });
      const { score, reasons } = resolve.scorePair(a, b);
      assert.equal(score, 0);
      assert.ok(reasons.some((r) => /both coordinates are geocoded/.test(r)));

      const { sites } = resolve.resolve([a, b]);
      assert.equal(sites.length, 2, 'distinct venues must not be collapsed by the geocoder');
    });

    it('still merges two geocoded records when their names agree', () => {
      const a = rec({ name: 'Kippax Fair Shopping Centre', geocoded: true });
      const b = rec({ name: 'Kippax Fair Shopping Centre', geocoded: true, sourceId: 'vic', sourceRecordId: 'v:1' });
      const { score } = resolve.scorePair(a, b);
      assert.atLeast(score, resolve.MATCH.scoreThreshold);
    });

    it('ranks a geocoded coordinate below a surveyed one', () => {
      // OSM is trusted above ACT for lat/lng, so a merged site keeps the
      // surveyed position rather than the geocoded approximation.
      const trust = resolve.DEFAULT_FIELD_TRUST;
      // Assert the ORDERING, not a specific last element — Tasmania is now
      // ranked below the ACT because a town centroid is coarser than a
      // geocoded street address.
      for (const field of ['lat', 'lng']) {
        assert.ok(
          trust[field].indexOf('act') > trust[field].indexOf('osm'),
          `geocoded act must rank below surveyed osm for ${field}`
        );
        assert.ok(
          trust[field].indexOf('tas') > trust[field].indexOf('act'),
          `town-level tas must rank below street-level act for ${field}`
        );
        assert.ok(
          trust[field].indexOf('tas') === trust[field].length - 1,
          `the least precise source must be last for ${field}`
        );
      }
    });

    it('ranks the funding-only sources last for status, so real status wins', () => {
      const trust = resolve.DEFAULT_FIELD_TRUST;
      // Both act and tas report grant funding rather than delivery, so both
      // sit below any source that publishes a real build status.
      for (const id of ['act', 'tas']) {
        assert.ok(
          trust.status.indexOf(id) > trust.status.indexOf('osm'),
          `${id} must rank below osm for status`
        );
      }
      // A merged ACT+OSM site should therefore report OSM's operational status.
      const site = resolve.mergeCluster([
        rec({ name: 'Next Gen Canberra', status: 'unknown', geocoded: true }),
        { ...rec({ sourceId: 'osm', name: 'Exploren', nameFromOperator: true, status: 'operational' }), geocoded: undefined },
      ]);
      assert.equal(site.status, 'operational');
      assert.equal(site.provenance.status.sourceId, 'osm');
      assert.equal(site.provenance.lat.sourceId, 'osm', 'surveyed coordinate must win');
    });

    it('lists every enabled source in every field trust order it can supply', () => {
      // vic was silently ranked last everywhere because it was missing from
      // these lists; pickField ranks unlisted sources last.
      const trust = resolve.DEFAULT_FIELD_TRUST;
      for (const field of ['lat', 'lng', 'name', 'connectors', 'maxPowerKw', 'status']) {
        assert.includes(trust[field], 'vic', `vic missing from ${field} trust order`);
        assert.includes(trust[field], 'act', `act missing from ${field} trust order`);
      }
    });
  });

  /* ------------------------------------------------------------------ */
  describe('resolve: merge, provenance, ids', () => {
    const mk = (over) => ({
      sourceId: 'osm',
      sourceRecordId: 'node/1',
      fetchedAt: '2026-09-05T00:00:00.000Z',
      lat: -37.5,
      lng: 143.8,
      name: 'OSM Name',
      operator: 'Chargefox',
      address: null,
      connectors: [],
      plugCount: null,
      maxPowerKw: null,
      status: 'operational',
      access: 'unknown',
      fee: null,
      ...over,
    });

    it('records per-field provenance', () => {
      const site = resolve.mergeCluster([
        mk({}),
        mk({ sourceId: 'nsw', sourceRecordId: 'row:1', name: 'NSW Name', maxPowerKw: 350 }),
      ]);
      // name trust prefers osm; maxPowerKw trust prefers nsw
      assert.equal(site.name, 'OSM Name');
      assert.equal(site.provenance.name.sourceId, 'osm');
      assert.equal(site.maxPowerKw, 350);
      assert.equal(site.provenance.maxPowerKw.sourceId, 'nsw');
    });

    it('reports conflicts rather than hiding them', () => {
      const site = resolve.mergeCluster([mk({}), mk({ sourceId: 'nsw', name: 'Different Name' })]);
      assert.ok(site.conflicts.name, 'expected a recorded name conflict');
      assert.equal(site.conflicts.name[0].value, 'Different Name');
    });

    it('prefers a trusted coordinate over a centroid (pin must not land mid-road)', () => {
      const site = resolve.mergeCluster([
        mk({ lat: -37.5, lng: 143.8 }),
        mk({ sourceId: 'nsw', lat: -37.5008, lng: 143.8008 }),
      ]);
      assert.equal(site.lat, -37.5, 'must equal the OSM coordinate exactly');
      assert.equal(site.lng, 143.8);
      assert.greaterThan(site.spatialSpreadM, 50);
    });

    it('sums connector counts across sources, taking the maximum asserted', () => {
      const site = resolve.mergeCluster([
        mk({ connectors: [{ standard: 'CCS2', count: 1, powerKw: 50 }] }),
        mk({ sourceId: 'vic', connectors: [{ standard: 'CCS2', count: 2, powerKw: 350 }] }),
      ]);
      assert.equal(site.connectors.length, 1);
      assert.equal(site.connectors[0].count, 2);
      assert.equal(site.connectors[0].powerKw, 350);
    });

    it('builds stable ids that survive re-ingest', () => {
      const a = resolve.mergeCluster([mk({})]);
      const b = resolve.mergeCluster([mk({ sourceRecordId: 'node/999' })]);
      assert.equal(a.id, b.id, 'id must not depend on the source record id');
      assert.includes(a.id, 'chargefox');
    });

    it('resolves id collisions between genuinely distinct sites', () => {
      const records = [
        mk({ operator: 'Chargefox', name: 'A' }),
        mk({ sourceId: 'nsw', operator: 'Chargefox', name: 'B', lat: -37.50001, lng: 143.80001 }),
      ];
      // Force them apart so they do not merge, then check ids stay unique.
      const { sites } = resolve.resolve(records, { scoreThreshold: 1.01 });
      assert.equal(sites.length, 2);
      assert.notEqual(sites[0].id, sites[1].id);
    });

    it('derives a display name when none is published (73% of NSW rows)', () => {
      const site = resolve.mergeCluster([
        mk({ name: null, operator: 'Ampol', address: nrm.parseAddress('1 Test St, Seven Hills NSW 2147') }),
      ]);
      assert.equal(site.name, null, 'published name stays null');
      assert.equal(site.nameIsDerived, true);
      assert.includes(site.displayName, 'Ampol');
      assert.includes(site.displayName, 'Seven Hills');
    });

    it('scores confidence higher for corroborated, complete sites', () => {
      const thin = resolve.mergeCluster([mk({ name: null, operator: null, address: null })]);
      const rich = resolve.mergeCluster([
        mk({ maxPowerKw: 350, address: nrm.parseAddress('1 A St, Ballarat VIC 3350'), connectors: [{ standard: 'CCS2', count: 2, powerKw: 350 }] }),
        mk({ sourceId: 'vic', sourceRecordId: 'dcav:2', maxPowerKw: 350 }),
      ]);
      assert.greaterThan(rich.confidence, thin.confidence);
    });

    it('drops records with invalid coordinates and counts them', () => {
      const { stats } = resolve.resolve([mk({}), mk({ lat: NaN }), mk({ lat: 0, lng: 0 })]);
      assert.equal(stats.rejectedInvalidCoords, 2);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('search', () => {
    const sites = [
      {
        id: 'a', name: 'Chargefox Ballarat', displayName: 'Chargefox Ballarat', operator: 'Chargefox',
        lat: -37.56, lng: 143.86, state: 'VIC', maxPowerKw: 350, speedBand: 'ultra',
        connectors: [{ standard: 'CCS2', count: 2, powerKw: 350 }], status: 'operational',
        sourceCount: 2, confidence: 0.8, conflicts: {}, address: { suburb: 'Ballarat', postcode: '3350' },
      },
      {
        id: 'b', name: 'Tesla Sydney', displayName: 'Tesla Sydney', operator: 'Tesla',
        lat: -33.87, lng: 151.21, state: 'NSW', maxPowerKw: 22, speedBand: 'slow',
        connectors: [{ standard: 'Type2', count: 4, powerKw: 22 }], status: 'operational',
        sourceCount: 1, confidence: 0.5, conflicts: {}, address: { suburb: 'Sydney', postcode: '2000' },
      },
      {
        id: 'c', name: 'Future Site', displayName: 'Future Site', operator: 'NRMA',
        lat: -32.0, lng: 150.0, state: 'NSW', maxPowerKw: 150, speedBand: 'rapid',
        connectors: [{ standard: 'CCS2', count: 1, powerKw: 150 }], status: 'planned',
        sourceCount: 1, confidence: 0.4, conflicts: {}, address: null,
      },
    ];

    it('excludes planned sites by default (drivers must not be sent to empty car parks)', () => {
      const r = search.query(sites, {});
      assert.equal(r.total, 2);
      assert.notOk(r.results.some((s) => s.id === 'c'));
    });

    it('includes planned sites when explicitly requested', () => {
      const r = search.query(sites, { includePlanned: true });
      assert.equal(r.total, 3);
    });

    it('filters by state, case-insensitively', () => {
      assert.equal(search.query(sites, { states: ['vic'] }).total, 1);
      assert.equal(search.query(sites, { states: ['NSW'] }).total, 1);
    });

    it('filters by minimum power', () => {
      const r = search.query(sites, { minPowerKw: 100 });
      assert.equal(r.total, 1);
      assert.equal(r.results[0].id, 'a');
    });

    it('filters by connector standard', () => {
      assert.equal(search.query(sites, { connectors: ['Type2'] }).total, 1);
      assert.equal(search.query(sites, { connectors: ['CCS2'] }).total, 1);
    });

    it('filters by corroboration', () => {
      assert.equal(search.query(sites, { minSources: 2 }).total, 1);
    });

    it('matches text on name, operator and suburb', () => {
      assert.equal(search.query(sites, { text: 'chargefox' }).total, 1);
      assert.equal(search.query(sites, { text: 'ballarat' }).total, 1);
      assert.equal(search.query(sites, { text: 'sydney' }).total, 1);
    });

    it('REGRESSION: matches suburb on the browser\'s flattened site shape', () => {
      // build/build-web.js's slimSite() ships address as a plain display
      // string (not { suburb, street, postcode }) plus top-level suburb and
      // postcode fields, to save bytes in the embedded dataset. textScore()
      // used to read site.address.suburb unconditionally, which is undefined
      // on a string — suburb search silently did nothing on the web map while
      // working fine from the CLI and HTTP API, which keep the full shape.
      const slim = [
        {
          id: 'x', name: 'Kerbside Charger', displayName: 'Kerbside Charger', operator: 'EVX',
          lat: -37.8, lng: 145.0, state: 'VIC', maxPowerKw: 22, speedBand: 'slow',
          connectors: [], status: 'operational', sourceCount: 1, confidence: 0.5, conflicts: [],
          address: '12 Example St, Reservoir, VIC, 3073', suburb: 'Reservoir', postcode: '3073',
        },
      ];
      assert.equal(search.query(slim, { text: 'reservoir' }).total, 1);
      assert.equal(search.query(slim, { text: '3073' }).total, 1);
    });

    it('REGRESSION: a multi-word query requires every word, not any word', () => {
      // Each token used to be scored independently, so "Central Coast" also
      // matched every unrelated "Gold Coast" or "Sunshine Coast" site —
      // anything sharing just one of the two words. On the real dataset this
      // inflated an 18-site match to 105.
      const multi = [
        {
          id: 'cc', name: 'Tesla — Central Coast', displayName: 'Tesla — Central Coast', operator: 'Tesla',
          lat: -33.4, lng: 151.3, state: 'NSW', status: 'operational', sourceCount: 1, confidence: 0.5,
          conflicts: [], connectors: [], address: { suburb: 'Central Coast', postcode: '2261' },
        },
        {
          id: 'gc', name: 'Chargefox Gold Coast', displayName: 'Chargefox Gold Coast', operator: 'Chargefox',
          lat: -28.0, lng: 153.4, state: 'QLD', status: 'operational', sourceCount: 1, confidence: 0.5,
          conflicts: [], connectors: [], address: { suburb: 'Gold Coast', postcode: '4217' },
        },
      ];
      const centralCoast = search.query(multi, { text: 'central coast' });
      assert.equal(centralCoast.total, 1);
      assert.equal(centralCoast.results[0].id, 'cc');
      assert.equal(search.query(multi, { text: 'gold coast' }).total, 1);
    });

    it('sorts by distance when a centre is supplied', () => {
      const r = search.query(sites, { lat: -33.87, lng: 151.21 });
      assert.equal(r.sort, 'distance');
      assert.equal(r.results[0].id, 'b');
      assert.equal(r.results[0].distanceM, 0);
    });

    it('applies a radius filter', () => {
      const r = search.query(sites, { lat: -33.87, lng: 151.21, radiusKm: 10 });
      assert.equal(r.total, 1);
    });

    it('rejects a radius without a centre instead of returning the country', () => {
      assert.throws(() => search.query(sites, { radiusKm: 5 }));
    });

    it('rejects an unknown sort mode', () => {
      assert.throws(() => search.query(sites, { sort: 'bogus' }));
    });

    it('produces deterministic ordering for equal keys', () => {
      const a = search.query(sites, { sort: 'power' }).results.map((s) => s.id);
      const b = search.query(sites, { sort: 'power' }).results.map((s) => s.id);
      assert.deepEqual(a, b);
    });

    it('paginates with limit and offset', () => {
      const all = search.query(sites, { includePlanned: true, limit: null }).results.length;
      assert.equal(all, 3);
      const page = search.query(sites, { includePlanned: true, limit: 2, offset: 1 });
      assert.equal(page.returned, 2);
      assert.equal(page.total, 3);
    });

    it('computes facets over the matched set', () => {
      const r = search.query(sites, {});
      assert.equal(r.facets.state.NSW, 1);
      assert.equal(r.facets.state.VIC, 1);
      assert.equal(r.facets.connector.CCS2, 1);
    });

    it('finds a site by id', () => {
      assert.equal(search.byId(sites, 'b').name, 'Tesla Sydney');
      assert.equal(search.byId(sites, 'nope'), null);
    });

    it('returns nearest sites excluding planned ones', () => {
      const n = search.nearest(sites, -32.0, 150.0, 3);
      assert.notOk(n.some((s) => s.id === 'c'), 'planned site must not be offered as nearest');
    });
  });
};
