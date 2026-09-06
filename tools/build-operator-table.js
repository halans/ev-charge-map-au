/**
 * Build the operator table data for the blog post.
 *
 * Sites and plug counts come from the reconciled dataset. Websites come from a
 * hand-curated map where EVERY url was verified with a live HTTP request (or,
 * where a site blocks automated clients, a real browser). Per-site `website`
 * tags in the source data were deliberately NOT used: they yielded Tesla deep
 * links, and a merge handed "Central Victorian Greenhouse Alliance" Evie's URL.
 */
const path = require('path');
const REPO = path.join(__dirname, '..');
const pipeline = require(path.join(REPO, 'src/pipeline'));
const nrm = require(path.join(REPO, 'src/core/normalise'));

/** operator -> { url, note }. Only verified URLs appear. */
const SITES_VERIFIED = {
  Chargefox: { url: 'https://www.chargefox.com/', note: 'Owned by NRMA, RACV, RACQ, RAA, RAC and RACT' },
  Tesla: { url: 'https://www.tesla.com/en_AU/findus/list/superchargers/Australia', note: 'Supercharger + Destination' },
  Exploren: { url: 'https://exploren.com.au/', note: 'OCPP platform; many host-operated sites' },
  'Evie Networks': { url: 'https://evie.com.au/', note: 'OSM still lists the old goevie.com.au' },
  NRMA: { url: 'https://www.mynrma.com.au/electric-vehicles/charging', note: '' },
  'PLUS ES': { url: 'https://www.pluses.com.au/', note: 'Ausgrid subsidiary; kerbside AC' },
  EVX: { url: 'https://evx.tech/', note: 'Pole-mounted kerbside' },
  'BP Pulse': { url: 'https://www.bppulse.com/en-au', note: '' },
  Ampol: { url: 'https://www.ampol.com.au/ampcharge', note: 'AmpCharge' },
  JOLT: { url: 'https://joltcharge.com/au/', note: '' },
  Yurika: { url: 'https://www.yurika.com.au/', note: 'Energy Queensland' },
  EVUp: { url: 'https://www.evup.com.au/', note: '' },
  Everty: { url: 'https://everty.com.au/', note: '' },
  'Central Victorian Greenhouse Alliance': { url: 'https://www.cvga.org.au/', note: 'Council alliance, not a network' },
  'Electric Highway Tasmania': {
    url: 'https://www.mynrma.com.au/electric-vehicles/charging/electric-highway-tasmania',
    note: 'Own domain now redirects to NRMA',
  },
  'Smart Charge': { url: 'https://smartcharge.com.au/', note: '' },
  ChargePoint: { url: 'https://www.chargepoint.com/', note: 'Global hardware/network' },
  EVSE: { url: 'https://evse.com.au/', note: 'Possibly the same firm as "EVE Australia"' },
  EVNet: { url: 'https://chargengo.au/', note: 'Rebranded — evnet.com.au now redirects here' },
  Elanga: { url: 'https://elanga.com.au/', note: '' },
  'Viva Energy A': { url: 'https://www.vivaenergy.com.au/', note: 'Name truncated in the TfNSW export' },
  'INTELLIHUB AUSTRALIA Pty Ltd': { url: 'https://www.intellihub.com.au/', note: '' },
  'Electrona Pty Ltd': { url: 'https://electrona.com.au/', note: '' },
  Noodoe: { url: 'https://www.noodoe.com/', note: '' },
  CasaCharge: { url: 'https://casacharge.com.au/', note: '' },
  'Charge Post': { url: 'https://www.chargepost.com.au/', note: '' },
  'Brisbane Airport Corporation': { url: 'https://www.bne.com.au/', note: 'Airport, not a network' },
  Engie: { url: null, note: 'Site returns an authorisation error from Australia' },
  'Fast Cities A': { url: null, note: 'Name truncated in the TfNSW export; no site found' },
  'EVE Australia': { url: null, note: 'No site resolved; may be EVSE Australia' },
  ChargeHub: { url: null, note: 'No site resolved' },
  'Charge Hub': { url: null, note: 'Possibly the same as "ChargeHub" — unresolved' },
  'Porsche Smart Mobility': { url: null, note: 'Destination charging at dealers' },
  'Non-networked': { url: null, note: 'A TfNSW placeholder, not an operator' },
  '(unattributed)': { url: null, note: 'No operator published by any source' },
  EVlink: { url: null, note: 'No site resolved' },
  Saascharge: { url: null, note: 'No site resolved' },
  '360 EV Charge': { url: null, note: 'No site resolved' },
};

const dataset = pipeline.loadDataset();
const ops = {};

for (const s of dataset.sites) {
  const key = s.operator || '(unattributed)';
  const o = (ops[key] = ops[key] || {
    operator: key,
    sites: 0,
    mappable: 0,
    approximate: 0,
    plugs: 0,
    sitesWithPlugCount: 0,
    maxKw: 0,
    dcSites: 0,
    acSites: 0,
    states: new Set(),
    planned: 0,
  });
  o.sites++;
  if (nrm.isMappable(s)) o.mappable++;
  else o.approximate++;
  if (Number.isFinite(s.plugCount)) {
    o.plugs += s.plugCount;
    o.sitesWithPlugCount++;
  }
  if (s.state) o.states.add(s.state);
  if (s.maxPowerKw) o.maxKw = Math.max(o.maxKw, s.maxPowerKw);
  if (s.status === 'planned') o.planned++;
  const stds = (s.connectors || []).map((c) => c.standard);
  if (stds.some((x) => ['CCS2', 'CHAdeMO', 'DCUnspecified', 'TeslaProprietary'].includes(x))) o.dcSites++;
  if (stds.some((x) => ['Type2', 'Type1', 'ACUnspecified'].includes(x))) o.acSites++;
}

const rows = Object.values(ops)
  .map((o) => {
    const meta = SITES_VERIFIED[o.operator] || { url: null, note: '' };
    return {
      operator: o.operator,
      sites: o.sites,
      mappable: o.mappable,
      approximate: o.approximate,
      plugs: o.plugs,
      plugCoverage: o.sites ? o.sitesWithPlugCount / o.sites : 0,
      maxKw: o.maxKw || null,
      dcSites: o.dcSites,
      acSites: o.acSites,
      states: [...o.states].sort(),
      planned: o.planned,
      url: meta.url || null,
      note: meta.note || '',
    };
  })
  .sort((a, b) => b.sites - a.sites);

const listed = rows.filter((r) => r.sites >= 5);
const tail = rows.filter((r) => r.sites < 5);

const summary = {
  generatedAt: dataset.generatedAt,
  totalSites: dataset.counts.sites,
  mappableSites: rows.reduce((a, r) => a + r.mappable, 0),
  approximateSites: rows.reduce((a, r) => a + r.approximate, 0),
  totalKnownPlugs: rows.reduce((a, r) => a + r.plugs, 0),
  distinctOperatorValues: rows.length,
  listedCount: listed.length,
  listedSites: listed.reduce((a, r) => a + r.sites, 0),
  tailCount: tail.length,
  tailSites: tail.reduce((a, r) => a + r.sites, 0),
  tailPlugs: tail.reduce((a, r) => a + r.plugs, 0),
  singleSiteOperators: rows.filter((r) => r.sites === 1).length,
  withVerifiedUrl: listed.filter((r) => r.url).length,
};

require('fs').writeFileSync(
  path.join(REPO, 'data/cache/operators.json'),
  JSON.stringify({ summary, listed, tail: tail.map((t) => t.operator) }, null, 2)
);

console.log('summary:', JSON.stringify(summary, null, 1));
console.log('\nlisted operators:', listed.length, '| with a verified URL:', summary.withVerifiedUrl);
console.log('\ntop 12:');
listed.slice(0, 12).forEach((r) =>
  console.log(
    '  ' + r.operator.slice(0, 34).padEnd(35),
    String(r.sites).padStart(4),
    'sites',
    String(r.plugs).padStart(5),
    'plugs',
    (r.url ? 'URL ok' : 'no URL').padEnd(7),
    r.states.join(' ')
  )
);
