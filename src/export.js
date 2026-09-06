'use strict';
/**
 * Exporters. Shared by the CLI `export` command and the HTTP API's
 * /api/export endpoints, so both emit byte-identical output.
 *
 * The `odbl` format is not a convenience feature — it is a licence
 * requirement. Because this project ingests OpenStreetMap data into its own
 * store, the resulting dataset is an ODbL "Derivative Database" rather than a
 * mere "Produced Work", and ODbL share-alike obliges the operator to offer
 * that database under ODbL on request. Shipping the export path in the tool
 * means compliance is a command, not a promise.
 */

const csv = require('./core/csv');

const FORMATS = ['csv', 'geojson', 'odbl', 'json'];

/** Flat columns for the CSV export. Nested objects are flattened, not dropped. */
const CSV_COLUMNS = [
  'id',
  'name',
  'display_name',
  'operator',
  'network',
  'lat',
  'lng',
  'state',
  'street',
  'suburb',
  'postcode',
  'status',
  'access',
  'fee',
  'plug_count',
  'max_power_kw',
  'speed_band',
  'connectors',
  'source_count',
  'sources',
  'confidence',
  'spatial_spread_m',
  'conflict_fields',
];

function siteToCsvRow(s) {
  return {
    id: s.id,
    name: s.name || '',
    display_name: s.displayName || '',
    operator: s.operator || '',
    network: s.network || '',
    lat: s.lat,
    lng: s.lng,
    state: s.state || '',
    street: (s.address && s.address.street) || '',
    suburb: (s.address && s.address.suburb) || '',
    postcode: (s.address && s.address.postcode) || '',
    status: s.status,
    access: s.access || '',
    fee: s.fee === null || s.fee === undefined ? '' : String(s.fee),
    plug_count: Number.isFinite(s.plugCount) ? s.plugCount : '',
    max_power_kw: s.maxPowerKw || '',
    speed_band: s.speedBand,
    connectors: (s.connectors || [])
      .map((c) => `${c.standard}${c.count ? `x${c.count}` : ''}${c.powerKw ? `@${c.powerKw}kW` : ''}`)
      .join('; '),
    source_count: s.sourceCount,
    sources: (s.sources || []).map((x) => x.sourceId).join('+'),
    confidence: s.confidence,
    spatial_spread_m: s.spatialSpreadM,
    conflict_fields: Object.keys(s.conflicts || {}).join('; '),
  };
}

/** Attribution header, prepended as CSV comments so it travels with the file. */
function attributionLines(dataset, prefix = '# ') {
  const lines = [
    `${prefix}ev-charge-map-au export — generated ${dataset.generatedAt}`,
    `${prefix}Effective licence: ${dataset.licence.effective}`,
    `${prefix}${dataset.licence.reason}`,
    `${prefix}`,
    `${prefix}Sources and required attribution:`,
  ];
  for (const a of dataset.attribution || []) {
    lines.push(`${prefix}  - ${a.text} (${a.licence}) ${a.licenceUrl}`);
  }
  lines.push(`${prefix}`);
  return lines;
}

function toCsv(dataset) {
  const header = attributionLines(dataset).join('\n');
  const body = csv.stringify(dataset.sites.map(siteToCsvRow), CSV_COLUMNS);
  return { body: `${header}\n${body}`, contentType: 'text/csv; charset=utf-8', filename: 'ev-chargers-au.csv' };
}

function toGeoJson(dataset) {
  const fc = {
    type: 'FeatureCollection',
    /**
     * Non-standard but widely honoured metadata members. Kept because a bare
     * FeatureCollection strips the attribution the licences require.
     */
    metadata: {
      generatedAt: dataset.generatedAt,
      licence: dataset.licence,
      attribution: dataset.attribution,
      counts: dataset.counts,
    },
    features: dataset.sites.map((s) => ({
      type: 'Feature',
      id: s.id,
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: {
        name: s.name,
        operator: s.operator,
        network: s.network,
        state: s.state,
        address: s.address,
        status: s.status,
        access: s.access,
        fee: s.fee,
        plugCount: s.plugCount,
        maxPowerKw: s.maxPowerKw,
        speedBand: s.speedBand,
        connectors: s.connectors,
        sourceCount: s.sourceCount,
        sources: s.sources,
        confidence: s.confidence,
        conflicts: s.conflicts,
        provenance: s.provenance,
      },
    })),
  };
  return {
    body: JSON.stringify(fc),
    contentType: 'application/geo+json; charset=utf-8',
    filename: 'ev-chargers-au.geojson',
  };
}

/** Full dataset as JSON, provenance and all. */
function toJson(dataset) {
  return {
    body: JSON.stringify(dataset),
    contentType: 'application/json; charset=utf-8',
    filename: 'ev-chargers-au.json',
  };
}

/**
 * The ODbL compliance bundle: the derived database plus the licence notice
 * explaining what a recipient may do with it and what they owe in return.
 */
function toOdblBundle(dataset) {
  const notice = [
    'ODbL DERIVATIVE DATABASE NOTICE',
    '===============================',
    '',
    `Generated: ${dataset.generatedAt}`,
    `Sites: ${dataset.counts.sites}`,
    '',
    'WHAT THIS IS',
    '------------',
    'This is the derived charging-site database produced by ev-charge-map-au by',
    'aggregating and reconciling the open datasets listed below. Because it',
    'incorporates OpenStreetMap data into a new database, it is a Derivative',
    'Database under the Open Database Licence 1.0, not merely a Produced Work.',
    '',
    'YOUR RIGHTS AND OBLIGATIONS',
    '---------------------------',
    'This database is offered to you under the ODbL 1.0:',
    '  https://opendatacommons.org/licenses/odbl/1-0/',
    '',
    'You may copy, distribute, use, and adapt it, including commercially,',
    'provided that you:',
    '  1. Attribute the sources listed below;',
    '  2. Keep any Derivative Database you publicly convey under the ODbL;',
    '  3. Do not apply technical measures that restrict others from using it.',
    '',
    'If you only produce a map, image, or app view from this data (a "Produced',
    'Work"), you may license that output as you wish, but you must still',
    'attribute, and you must offer recipients this database under the ODbL.',
    '',
    'SOURCES AND REQUIRED ATTRIBUTION',
    '--------------------------------',
  ];

  for (const a of dataset.attribution || []) {
    notice.push(`  ${a.text}`);
    notice.push(`    licence: ${a.licence}  ${a.licenceUrl}`);
    notice.push(`    share-alike: ${a.shareAlike ? 'yes' : 'no'}`);
    notice.push('');
  }

  notice.push('PER-SOURCE DETAIL');
  notice.push('-----------------');
  for (const s of dataset.sources || []) {
    notice.push(`  ${s.sourceId}: ${s.name}`);
    notice.push(`    jurisdiction: ${s.jurisdiction}`);
    notice.push(`    records contributed: ${s.recordCount}`);
    notice.push(`    fetched: ${s.fetchedAt || 'unknown'}`);
    if (s.coverageCaveat) notice.push(`    coverage caveat: ${s.coverageCaveat}`);
    notice.push('');
  }

  notice.push('COMPLETENESS DISCLAIMER');
  notice.push('-----------------------');
  notice.push('This database is assembled from open data only and is NOT a complete');
  notice.push('census of Australian public charging infrastructure. Independent');
  notice.push('estimates put the national total higher than what open data covers.');
  notice.push('Sites marked status=planned are not yet built. Do not present this');
  notice.push('data as authoritative or complete.');
  notice.push('');

  const bundle = {
    'LICENCE-NOTICE.txt': notice.join('\n'),
    'dataset.json': JSON.stringify(dataset, null, 2),
    'dataset.csv': toCsv(dataset).body,
    'dataset.geojson': toGeoJson(dataset).body,
  };

  // Emitted as a single JSON envelope rather than a zip so the export stays
  // dependency-free. `evmap export --format odbl --out dir/` unpacks it.
  return {
    body: JSON.stringify(bundle, null, 2),
    contentType: 'application/json; charset=utf-8',
    filename: 'ev-chargers-au-odbl-bundle.json',
    files: bundle,
  };
}

const RENDERERS = { csv: toCsv, geojson: toGeoJson, json: toJson, odbl: toOdblBundle };

function render(format, dataset) {
  const fn = RENDERERS[format];
  if (!fn) throw new Error(`Unknown export format "${format}". Valid: ${FORMATS.join(', ')}`);
  return fn(dataset);
}

module.exports = {
  CSV_COLUMNS,
  FORMATS,
  attributionLines,
  render,
  siteToCsvRow,
  toCsv,
  toGeoJson,
  toJson,
  toOdblBundle,
};
