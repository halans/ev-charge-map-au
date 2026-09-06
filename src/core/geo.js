'use strict';
/**
 * Geospatial primitives. Zero dependencies.
 *
 * Everything here is used by BOTH the ingest/resolve pipeline (Node) and the
 * generated web page (browser). Keep it free of Node built-ins.
 */

const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius

/** Australia's rough bounding box, incl. external territories margin. */
const AU_BBOX = { minLat: -44.0, maxLat: -9.0, minLng: 112.0, maxLng: 154.5 };

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres (haversine).
 * @returns {number}
 */
function distanceMetres(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Cheap squared-degree distance for pre-filtering, longitude-corrected.
 * Much faster than haversine and monotonic with it over small spans.
 */
function roughMetres(lat1, lng1, lat2, lng2) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(toRad((lat1 + lat2) / 2));
  const dy = (lat2 - lat1) * mPerDegLat;
  const dx = (lng2 - lng1) * mPerDegLng;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Is this a plausible coordinate anywhere on earth? */
function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0) // null island — a real failure mode in gov exports
  );
}

/** Is this coordinate inside the Australian bounding box? */
function isInAustralia(lat, lng) {
  return (
    isValidLatLng(lat, lng) &&
    lat >= AU_BBOX.minLat &&
    lat <= AU_BBOX.maxLat &&
    lng >= AU_BBOX.minLng &&
    lng <= AU_BBOX.maxLng
  );
}

/**
 * Best-effort state/territory inference from a coordinate.
 * Uses coarse rectangles, deliberately simple: it is a fallback for records
 * with no stated jurisdiction, never an override of a stated one.
 * @returns {string|null}
 */
function stateFromLatLng(lat, lng) {
  if (!isInAustralia(lat, lng)) return null;
  // ACT sits inside NSW, so test it first.
  if (lat <= -35.1 && lat >= -35.95 && lng >= 148.75 && lng <= 149.4) return 'ACT';
  if (lng < 129.0) return 'WA';
  if (lat < -39.5) return 'TAS';
  if (lng >= 129.0 && lng < 141.0) return lat > -26.0 ? 'NT' : 'SA';
  if (lat > -29.0) return 'QLD';
  if (lat < -34.0 && lng < 150.0 && lat > -39.5 && lng >= 141.0) return 'VIC';
  return 'NSW';
}

/**
 * Grid cell key for spatial bucketing at an approximate metre resolution.
 * Used by the resolver to avoid an O(n^2) all-pairs comparison.
 */
function cellKey(lat, lng, cellMetres) {
  const latStep = cellMetres / 111320;
  const lngStep = cellMetres / (111320 * Math.max(0.2, Math.cos(toRad(lat))));
  return `${Math.floor(lat / latStep)}:${Math.floor(lng / lngStep)}`;
}

/**
 * The 9 cell keys covering a point and its neighbours, so clusters that
 * straddle a cell boundary are still found.
 */
function neighbourKeys(lat, lng, cellMetres) {
  const latStep = cellMetres / 111320;
  const lngStep = cellMetres / (111320 * Math.max(0.2, Math.cos(toRad(lat))));
  const gy = Math.floor(lat / latStep);
  const gx = Math.floor(lng / lngStep);
  const keys = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) keys.push(`${gy + dy}:${gx + dx}`);
  }
  return keys;
}

/** Round a coordinate to a fixed precision (7dp ~= 11mm; 5dp ~= 1.1m). */
const roundCoord = (v, dp = 6) => Number(Number(v).toFixed(dp));

/** Mean centre of a list of {lat,lng}. Adequate at charging-site scale. */
function centroid(points) {
  if (!points.length) return null;
  let lat = 0;
  let lng = 0;
  for (const p of points) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: roundCoord(lat / points.length), lng: roundCoord(lng / points.length) };
}

/** Bounding box around a point with a metre radius, for bbox queries. */
function bboxAround(lat, lng, radiusMetres) {
  const dLat = radiusMetres / 111320;
  const dLng = radiusMetres / (111320 * Math.max(0.2, Math.cos(toRad(lat))));
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLng: lng - dLng,
    maxLng: lng + dLng,
  };
}

module.exports = {
  AU_BBOX,
  bboxAround,
  cellKey,
  centroid,
  distanceMetres,
  isInAustralia,
  isValidLatLng,
  neighbourKeys,
  roughMetres,
  roundCoord,
  stateFromLatLng,
};
