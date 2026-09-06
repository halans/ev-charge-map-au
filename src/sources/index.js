'use strict';
/**
 * Source registry.
 *
 * Adding a source means writing one adapter module that exports
 * { id, meta, requests(), normalise(raw, ctx) } and listing it here. Nothing
 * else in the codebase needs to change — the pipeline, CLI, API and web build
 * all iterate this registry.
 */

const osm = require('./osm');
const nsw = require('./nsw');
const qld = require('./qld');
const vic = require('./vic');
const act = require('./act');
const tas = require('./tas');
const ocm = require('./ocm');

/** Sources enabled by default: all keyless, openly-licensed, verified working. */
const DEFAULT_SOURCES = [osm, nsw, vic, qld, act, tas];

/** Every known adapter, including ones that need configuration to run. */
const ALL_SOURCES = [osm, nsw, vic, qld, act, tas, ocm];

/** @param {string} id */
function bySourceId(id) {
  return ALL_SOURCES.find((s) => s.id === id) || null;
}

/**
 * Resolve a source selection.
 * @param {string[]|null} ids null/empty selects DEFAULT_SOURCES
 */
function select(ids) {
  if (!ids || !ids.length) return DEFAULT_SOURCES.slice();
  const out = [];
  for (const id of ids) {
    const src = bySourceId(id);
    if (!src) {
      const known = ALL_SOURCES.map((s) => s.id).join(', ');
      throw new Error(`Unknown source "${id}". Known sources: ${known}`);
    }
    out.push(src);
  }
  return out;
}

/** Attribution lines required by the enabled sources. Used by every surface. */
function attributions(sources = DEFAULT_SOURCES) {
  return sources
    .filter((s) => s.meta.attributionRequired)
    .map((s) => ({
      sourceId: s.id,
      text: s.meta.attribution,
      licence: s.meta.licence,
      licenceUrl: s.meta.licenceUrl,
      shareAlike: !!s.meta.shareAlike,
    }));
}

module.exports = {
  ALL_SOURCES,
  DEFAULT_SOURCES,
  attributions,
  bySourceId,
  select,
  osm,
  nsw,
  qld,
  vic,
  act,
  tas,
  ocm,
};
