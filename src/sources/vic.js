'use strict';
/**
 * Source adapter: Victoria — DEECA "Government Funded Public EV Chargers"
 * (Destination Charging Across Victoria and related programmes).
 *
 * Verified 2026-09-05: WFS GetFeature with outputFormat=application/json
 * returns HTTP 200 and 152 features from layer `open-data-platform:dcav_site`.
 *
 * Note for maintainers: the layer is NOT under the `datavic:` workspace that
 * some documentation implies — `datavic:dcav_site` returns HTTP 400
 * InvalidParameterValue. The working workspace prefix is `open-data-platform:`.
 *
 * Beware of near-miss layers: `nv1750_evcbcs` and `nv2005_evcbcs` match a
 * naive "evc" search but are Ecological Vegetation Class datasets, nothing to
 * do with EV charging.
 *
 * Data quality is notably better than NSW: plug types are structured
 * ("1 x CCS2, 1 x CHAdeMO") and charger power is stated ("3 x 22kW Charger").
 *
 * Coverage caveat: government-funded chargers only. Commercial networks that
 * built in Victoria without state funding are absent, so this must never be
 * presented as a complete Victorian inventory.
 *
 * Licence: CC-BY 4.0.
 */

const geo = require('../core/geo');
const nrm = require('../core/normalise');

const id = 'vic';

const meta = {
  id,
  name: 'Victoria DEECA — Government Funded Public EV Chargers',
  jurisdiction: 'VIC',
  licence: 'CC-BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution:
    '© State of Victoria (Department of Energy, Environment and Climate Action)',
  attributionRequired: true,
  shareAlike: false,
  homepage:
    'https://discover.data.vic.gov.au/dataset/government-funded-public-ev-chargers',
  changeCadence: 'monthly',
  recommendedRefresh: 'weekly',
  coverageCaveat:
    'Government-funded chargers only — not a complete Victorian inventory.',
};

const LAYER = 'open-data-platform:dcav_site';
const WFS_BASE = 'https://opendata.maps.vic.gov.au/geoserver/wfs';

function wfsUrl(layer = LAYER) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: layer,
    outputFormat: 'application/json',
  });
  return `${WFS_BASE}?${params.toString()}`;
}

function requests() {
  return [
    {
      key: 'vic-dcav.json',
      urls: [wfsUrl()],
      format: 'json',
      /**
       * GeoServer signals failure with an XML ExceptionReport and HTTP 400,
       * but can also return a 200 with zero features if the layer is renamed.
       * Both are failures for our purposes.
       */
      validate: (parsed) => {
        if (!parsed || parsed.type !== 'FeatureCollection') {
          return 'response is not a GeoJSON FeatureCollection (layer renamed or WFS error?)';
        }
        if (!Array.isArray(parsed.features) || parsed.features.length === 0) {
          return 'FeatureCollection contained zero features';
        }
        return null;
      },
    },
  ];
}

/**
 * Parse Victoria's structured plug_type strings into connectors.
 * Observed values include:
 *   "1 x CCS2, 1 x CHAdeMO"        (74 rows)
 *   "1 x CHAdeMO and 1 x CCS2/SAE" (18)
 *   "2 x CCS2" / "CCS2" / "2 x Type 2" / "3 x Type 2" / "Type 2"
 * Both "," and "and" are used as separators, sometimes together.
 */
function parsePlugTypes(plugType) {
  const text = nrm.cleanText(plugType);
  if (!text) return [];
  const parts = text
    .split(/,|\band\b|\+|;|\n/i)
    .map((p) => p.trim())
    .filter(Boolean);

  const out = [];
  for (const part of parts) {
    // "2 x CCS2" -> count 2, label CCS2. Bare "CCS2" -> count null.
    const m = part.match(/^(?:(\d+)\s*[x×]\s*)?(.+)$/);
    if (!m) continue;
    const count = m[1] ? parseInt(m[1], 10) : null;
    const label = m[2].trim();
    // "CCS2/SAE" is a single CCS2 plug described with its SAE synonym, not two.
    const standard = nrm.normaliseConnector(label.split('/')[0]);
    if (!standard) continue;
    out.push({ standard, count, powerKw: null });
  }
  return out;
}

/**
 * Parse Victoria's `chargers` field, e.g. "3 x 22kW Charger", to recover power.
 * @returns {{maxKw: number|null, groups: Array<{count:number,kw:number}>}}
 */
function parseChargers(chargers) {
  const parsed = nrm.parsePowerRating(chargers);
  return { maxKw: parsed.maxKw, groups: parsed.groups };
}

function normalise(raw, ctx = {}) {
  const fetchedAt = ctx.fetchedAt || new Date().toISOString();
  const features = (raw && raw.features) || [];
  const records = [];
  const issues = [];

  features.forEach((feature, index) => {
    const p = feature.properties || {};
    // Prefer the geometry, fall back to the latitude/longitude columns.
    const coords = (feature.geometry && feature.geometry.coordinates) || [];
    const lng = Number.isFinite(coords[0]) ? coords[0] : parseFloat(p.longitude);
    const lat = Number.isFinite(coords[1]) ? coords[1] : parseFloat(p.latitude);

    const recordId = `dcav:${feature.id || nrm.slug(p.location || String(index), 30)}`;

    if (!geo.isValidLatLng(lat, lng) || !geo.isInAustralia(lat, lng)) {
      issues.push({ sourceId: id, sourceRecordId: recordId, kind: 'rejected', issue: 'missing or invalid coordinates' });
      return;
    }

    const connectors = parsePlugTypes(p.plug_type);
    if (!connectors.length && nrm.cleanText(p.plug_type)) {
      issues.push({
        sourceId: id,
        sourceRecordId: recordId,
        kind: 'parse_failure',
        issue: `unparsed plug_type "${p.plug_type}"`,
      });
    }
    const power = parseChargers(p.chargers);
    // Distribute the site's power figure across connectors that lack one.
    if (power.maxKw) {
      for (const c of connectors) if (!c.powerKw) c.powerKw = power.maxKw;
    }

    /**
     * Status from `estimated_project_completion`.
     *
     * IMPORTANT: a populated value does NOT mean "not yet built". Measured
     * 2026-09-05, 96 of 152 rows carry a value and most are PAST dates
     * ("31/07/2023" x22, "30 November 2023", "10/10/2022") describing
     * completed projects. Only a FUTURE date indicates an unbuilt site.
     * Treating any populated value as planned mislabelled 96 sites; comparing
     * against today reduces that to the genuinely pending handful.
     *
     * An unparseable date is treated as unknown rather than guessed at.
     */
    const completion = nrm.cleanText(p.estimated_project_completion);
    let status = 'operational';
    if (completion) {
      const due = nrm.parseLooseDate(completion);
      if (!due) {
        status = 'unknown';
        issues.push({
          sourceId: id,
          sourceRecordId: recordId,
          kind: 'parse_failure',
          issue: `unparseable estimated_project_completion "${completion}"`,
        });
      } else if (due.getTime() > (ctx.now || Date.now())) {
        status = 'planned';
        issues.push({
          sourceId: id,
          sourceRecordId: recordId,
          kind: 'status_flag',
          issue: `planned/unbuilt site (completion due ${completion})`,
        });
      }
      // Past date: the project finished, so the site is operational.
    }

    const address = nrm.parseAddress(p.address);
    if (address && !address.state) address.state = 'VIC';

    const plugCount = Number.isFinite(p.number_of_chargers)
      ? p.number_of_chargers
      : /^\d+$/.test(String(p.number_of_chargers || '').trim())
        ? parseInt(p.number_of_chargers, 10)
        : null;

    records.push({
      sourceId: id,
      sourceRecordId: recordId,
      sourceUrl: meta.homepage,
      fetchedAt,
      lat,
      lng,
      // `location` is a locality name (e.g. "Tatura"); the site host is a
      // better site name when present.
      name: nrm.cleanText(p.lead_organisation || p.location),
      operator: nrm.normaliseOperator(p.company || p.lead_organisation),
      network: nrm.normaliseOperator(p.company),
      address,
      connectors,
      plugCount,
      maxPowerKw: power.maxKw,
      status: nrm.normaliseStatus(status),
      access: 'unknown',
      fee: null,
      openingHours: null,
      website: null,
      extra: {
        locality: nrm.cleanText(p.location),
        region: nrm.cleanText(p.region),
        leadOrganisation: nrm.cleanText(p.lead_organisation),
        nearbyAmenities: nrm.cleanText(p.nearby_amenities_attractions),
        isDcavSite: /^yes$/i.test(String(p.dcav_site || '').trim()),
        plugTypeRaw: nrm.cleanText(p.plug_type),
        chargersRaw: nrm.cleanText(p.chargers),
        // Deliberately NOT ingested as data: PlugShare is proprietary. Kept
        // only as an outbound reference the publisher themselves provided.
        plugshareLink: nrm.cleanText(p.plugshare_link),
      },
    });
  });

  return { records, issues };
}

module.exports = { id, meta, requests, normalise, parsePlugTypes, parseChargers, LAYER, wfsUrl };
