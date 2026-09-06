'use strict';
/**
 * Source adapter: Open Charge Map, restricted to the openly-licensed subset.
 *
 * DISABLED BY DEFAULT — requires a free API key in OCM_API_KEY. Verified
 * 2026-09-05: the API returns HTTP 403 with no key.
 *
 * LICENCE WARNING (the reason for the hard-coded opendata filter):
 * OCM redistributes a mix of licences. Its own terms state that
 * user-contributed data is CC-BY 4.0, but "Data imported from 3rd party Data
 * Providers is copyright the original Data Provider in each case and is not
 * provided under the same terms". The API docs direct you to
 * `opendata=true` to "return data marked specifically with Open Data
 * licenses".
 *
 * This adapter therefore pins `opendata=true` and refuses to run without it.
 * Ingesting unfiltered OCM into a redistributable database would mix
 * proprietary operator data into an openly-licensed product.
 *
 * Attribution: OCM additionally requires that the per-record Data Provider
 * attribution be shown to end users, so we retain dataProvider per record and
 * the web surface renders it.
 */

const geo = require('../core/geo');
const nrm = require('../core/normalise');

const id = 'ocm';

const meta = {
  id,
  name: 'Open Charge Map (open-licensed subset)',
  jurisdiction: 'AU (national)',
  licence: 'CC-BY 4.0 (user-contributed); per-provider for imported records',
  licenceUrl: 'https://openchargemap.io/about/terms',
  attribution: 'Data © Open Charge Map contributors and listed Data Providers',
  attributionRequired: true,
  shareAlike: false,
  homepage: 'https://openchargemap.org/',
  changeCadence: 'continuous',
  recommendedRefresh: 'daily',
  requiresApiKey: true,
  apiKeyEnvVar: 'OCM_API_KEY',
  enabledByDefault: false,
  coverageCaveat:
    'Only records the provider has flagged as open-licensed (opendata=true); a subset of OCM.',
  /**
   * OCM asks callers to stay under ~10,000 requests/day and to debounce.
   * One paginated national pull per day is comfortably inside that.
   */
  rateLimitNote: 'Assess before exceeding ~10,000 requests/day; self-host a mirror for heavy use.',
  bulkExport: 'https://github.com/openchargemap/ocm-export',
};

const API_BASE = 'https://api.openchargemap.io/v3/poi';

/**
 * Build the request list. Returns [] when no key is configured, so the
 * pipeline reports the source as skipped rather than failing the whole run.
 */
function requests(ctx = {}) {
  const key = ctx.apiKey || process.env.OCM_API_KEY;
  if (!key) return [];

  const params = new URLSearchParams({
    output: 'json',
    countrycode: 'AU',
    // Non-negotiable: see the licence warning above.
    opendata: 'true',
    maxresults: '10000',
    compact: 'false',
    verbose: 'false',
    key,
  });

  return [
    {
      key: 'ocm-au.json',
      urls: [`${API_BASE}?${params.toString()}`],
      format: 'json',
      /** Never log or cache the key itself. */
      redact: [key],
      validate: (parsed) => {
        if (!Array.isArray(parsed)) return 'expected a JSON array of POIs';
        return null;
      },
    },
  ];
}

/** OCM connection types -> our canonical standards. */
function connectorsFromConnections(connections) {
  const out = [];
  for (const c of connections || []) {
    const title = (c.ConnectionType && c.ConnectionType.Title) || c.ConnectionTypeID;
    const standard = nrm.normaliseConnector(String(title));
    if (!standard) continue;
    out.push({
      standard,
      count: Number.isFinite(c.Quantity) ? c.Quantity : null,
      powerKw: Number.isFinite(c.PowerKW) ? c.PowerKW : null,
    });
  }
  return out;
}

function normalise(raw, ctx = {}) {
  const fetchedAt = ctx.fetchedAt || new Date().toISOString();
  const pois = Array.isArray(raw) ? raw : [];
  const records = [];
  const issues = [];

  for (const poi of pois) {
    const addr = poi.AddressInfo || {};
    const lat = parseFloat(addr.Latitude);
    const lng = parseFloat(addr.Longitude);
    const recordId = `ocm:${poi.ID}`;

    if (!geo.isValidLatLng(lat, lng) || !geo.isInAustralia(lat, lng)) {
      issues.push({ sourceId: id, sourceRecordId: recordId, kind: 'rejected', issue: 'missing or invalid coordinates' });
      continue;
    }

    // Defence in depth: even with opendata=true requested, drop any record
    // whose provider is not flagged as open-licensed.
    const provider = poi.DataProvider || {};
    if (provider.IsOpenDataLicensed === false) {
      issues.push({
        sourceId: id,
        sourceRecordId: recordId,
        kind: 'policy',
        issue: `skipped: provider "${provider.Title}" is not open-data licensed`,
      });
      continue;
    }

    const connectors = connectorsFromConnections(poi.Connections);
    const maxKw = connectors.reduce((a, c) => Math.max(a, c.powerKw || 0), 0);

    const addressJoined = [addr.AddressLine1, addr.Town, addr.StateOrProvince, addr.Postcode]
      .filter(Boolean)
      .join(', ');

    records.push({
      sourceId: id,
      sourceRecordId: recordId,
      sourceUrl: `https://openchargemap.org/site/poi/details/${poi.ID}`,
      fetchedAt,
      lat,
      lng,
      name: nrm.cleanText(addr.Title),
      operator: nrm.normaliseOperator(
        (poi.OperatorInfo && poi.OperatorInfo.Title) || null
      ),
      network: nrm.normaliseOperator((poi.OperatorInfo && poi.OperatorInfo.Title) || null),
      address: addressJoined ? nrm.parseAddress(addressJoined) : null,
      connectors,
      plugCount: Number.isFinite(poi.NumberOfPoints) ? poi.NumberOfPoints : null,
      maxPowerKw: maxKw || null,
      status: nrm.normaliseStatus(
        (poi.StatusType && poi.StatusType.Title) || (poi.StatusType && poi.StatusType.IsOperational ? 'operational' : '')
      ),
      access: nrm.normaliseAccess((poi.UsageType && poi.UsageType.Title) || null),
      fee: poi.UsageCost ? true : nrm.normaliseFee((poi.UsageType && poi.UsageType.IsPayAtLocation) || null),
      openingHours: null,
      website: null,
      extra: {
        /** OCM requires this be surfaced to end users. */
        dataProvider: nrm.cleanText(provider.Title),
        dataProviderLicence: nrm.cleanText(provider.License),
        usageCost: nrm.cleanText(poi.UsageCost),
      },
    });
  }

  return { records, issues };
}

module.exports = { id, meta, requests, normalise, connectorsFromConnections, API_BASE };
