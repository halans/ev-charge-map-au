'use strict';
/**
 * Source adapter: Queensland Department of Transport and Main Roads,
 * "Find a charging station — Electric vehicle".
 *
 * Verified 2026-09-05: HTTP 200 (33 rows) — but ONLY with a browser-like
 * User-Agent. The default curl/node UA gets an HTML 403 error page, which a
 * naive pipeline would happily parse as a zero-row CSV and report as "QLD
 * dataset shrank to 0". The fetch layer therefore sets a UA, and the drift
 * check treats a collapse to zero rows as a hard failure rather than a change.
 *
 * Coverage caveat: this is the Queensland Electric Super Highway (QESH) only —
 * government-supported sites, not a census of QLD public charging.
 *
 * Licence: CC-BY 4.0.
 */

const csv = require('../core/csv');
const geo = require('../core/geo');
const nrm = require('../core/normalise');

const id = 'qld';

const meta = {
  id,
  name: 'QLD Transport and Main Roads — Find a charging station (QESH)',
  jurisdiction: 'QLD',
  licence: 'CC-BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: '© State of Queensland (Department of Transport and Main Roads)',
  attributionRequired: true,
  shareAlike: false,
  homepage: 'https://data.gov.au/data/dataset/find-a-charging-station-electric-vehicle',
  changeCadence: 'infrequent',
  recommendedRefresh: 'weekly',
  coverageCaveat:
    'Queensland Electric Super Highway sites only — not a complete QLD inventory.',
};

const CSV_URL =
  'https://www.tmr.qld.gov.au/-/media/aboutus/corpinfo/Open%20data/findachargingev/csl_ev.csv';

function requests() {
  return [
    {
      key: 'qld-ev.csv',
      urls: [CSV_URL],
      format: 'text',
      /**
       * Mandatory: tmr.qld.gov.au returns 403 to non-browser agents.
       * Documented here rather than buried in the fetch layer so nobody
       * "cleans it up" and silently breaks the source.
       */
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        accept: 'text/csv,*/*',
      },
      /** A valid response is CSV; an HTML error page is a failure, not data. */
      validate: (text) => {
        if (/^\s*</.test(text) || /request has failed/i.test(text)) {
          return 'received an HTML error page instead of CSV (missing browser User-Agent?)';
        }
        if (!/latitude/i.test(text)) return 'CSV does not contain a Latitude column';
        return null;
      },
    },
  ];
}

function normalise(raw, ctx = {}) {
  const fetchedAt = ctx.fetchedAt || new Date().toISOString();
  const rows = csv.parse(raw);
  const records = [];
  const issues = [];

  rows.forEach((row, index) => {
    const lat = parseFloat(row.Latitude);
    const lng = parseFloat(row.Longitude);
    const name = nrm.cleanText(row['Location Name']);
    const recordId = `qesh:${nrm.slug(name || String(index), 30)}`;

    if (!geo.isValidLatLng(lat, lng) || !geo.isInAustralia(lat, lng)) {
      issues.push({ sourceId: id, sourceRecordId: recordId, kind: 'rejected', issue: 'missing or invalid coordinates' });
      return;
    }

    const status = nrm.normaliseStatus(row.Status);
    const host = nrm.cleanText(row.Host);

    // QLD publishes a "Charging plugs available" column that is empty on every
    // row observed — recorded as an issue rather than silently treated as 0.
    const plugsRaw = String(row['Charging plugs available'] || '').trim();
    const plugCount = /^\d+$/.test(plugsRaw) ? parseInt(plugsRaw, 10) : null;
    if (!plugsRaw) {
      issues.push({ sourceId: id, sourceRecordId: recordId, kind: 'data_gap', issue: 'plug count column empty' });
    }

    const address = nrm.parseAddress(row.Address);
    if (address && !address.state) address.state = 'QLD';

    records.push({
      sourceId: id,
      sourceRecordId: recordId,
      sourceUrl: meta.homepage,
      fetchedAt,
      lat,
      lng,
      name,
      // The "Host" is the site host (a council, a university), which is the
      // closest thing QLD publishes to an operator. Flagged in extra so the
      // resolver does not over-trust it as a charging network.
      operator: nrm.normaliseOperator(host),
      network: null,
      address,
      connectors: [],
      plugCount,
      maxPowerKw: null,
      status,
      access: 'unknown',
      fee: null,
      openingHours: null,
      website: null,
      extra: {
        host,
        description: nrm.cleanText(row.Description),
        nearestStation: nrm.cleanText(row['Nearest QESH charging station']),
        programme: 'Queensland Electric Super Highway',
      },
    });
  });

  return { records, issues };
}

module.exports = { id, meta, requests, normalise, CSV_URL };
