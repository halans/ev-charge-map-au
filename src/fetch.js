'use strict';
/**
 * Fetch layer: network retrieval, on-disk cache, checksums, offline mode.
 *
 * Design requirements this satisfies:
 *  1. `--offline` must fully rebuild from the cached raw files, so the repo is
 *     self-verifying without network access.
 *  2. Every cached file records its checksum, byte size, source URL and fetch
 *     time, so a rebuild is reproducible and auditable.
 *  3. A failed fetch must never overwrite good cached data with an error page.
 *  4. Secrets (API keys in query strings) must never be written to the manifest.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RAW_DIR = path.join(__dirname, '..', 'data', 'raw');
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const MANIFEST_PATH = path.join(CACHE_DIR, 'manifest.json');

/**
 * Default request headers.
 *
 * Both of these are the result of a real failure on 2026-09-05, not
 * boilerplate. The Overpass API returned **HTTP 406 Not Acceptable** to
 * requests carrying our original descriptive User-Agent
 * (`ev-charge-map-au/1.0 (+https://github.com/...) open-data aggregation`)
 * with no `Accept` header, while the identical query succeeded from curl.
 * Isolating it showed that sending an explicit `Accept` fixes it, and that the
 * parenthesised URL in the agent string was the trigger.
 *
 * So: keep the User-Agent short and identifying (public APIs reasonably want
 * to know who is calling), and always state what we accept.
 */
const DEFAULT_USER_AGENT = 'ev-charge-map-au/1.0 open-data-aggregation';

const DEFAULT_ACCEPT = 'application/json, application/geo+json, text/csv, text/plain;q=0.9, */*;q=0.8';

function ensureDirs() {
  for (const dir of [RAW_DIR, CACHE_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Strip secrets from a URL before it is logged or written to the manifest. */
function redactUrl(url, redactions = []) {
  let out = String(url);
  for (const secret of redactions) {
    if (secret) out = out.split(secret).join('REDACTED');
  }
  // Blanket removal of common key parameter names, even if not declared.
  out = out.replace(/([?&](?:key|apikey|api_key|token|access_token)=)[^&]*/gi, '$1REDACTED');
  return out;
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeManifest(manifest) {
  ensureDirs();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * HTTP(S) GET/POST with redirect handling and a hard timeout.
 * Uses global fetch (Node 18+) — no dependencies.
 */
async function httpRequest(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 120000);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'user-agent': DEFAULT_USER_AGENT,
        accept: DEFAULT_ACCEPT,
        ...(opts.headers || {}),
      },
      body: opts.body,
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, headers: res.headers };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Retrieve one request descriptor, honouring the cache and offline mode.
 *
 * @param {object} req descriptor from a source's requests()
 * @param {object} opts { offline, refresh, log }
 * @returns {Promise<{key:string, text:string, parsed:any, fromCache:boolean, meta:object}>}
 */
async function retrieve(req, opts = {}) {
  ensureDirs();
  const log = opts.log || (() => {});
  const cachePath = path.join(RAW_DIR, req.key);
  const manifest = readManifest();
  const existing = manifest.entries[req.key];
  const haveCache = fs.existsSync(cachePath);

  const parseIfNeeded = (text) => {
    if (req.format !== 'json') return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`${req.key}: response was not valid JSON (${err.message})`);
    }
  };

  // ---- Offline path -------------------------------------------------------
  if (opts.offline) {
    if (!haveCache) {
      throw new Error(
        `${req.key}: --offline requested but no cached file at data/raw/${req.key}. ` +
          `Run an online ingest first, or ship the cache with the repo.`
      );
    }
    const buf = fs.readFileSync(cachePath);
    const text = buf.toString('utf8');
    const digest = sha256(buf);
    if (existing && existing.sha256 && existing.sha256 !== digest) {
      log(
        `  ! ${req.key}: cached file checksum differs from manifest ` +
          `(manifest ${existing.sha256.slice(0, 12)}, file ${digest.slice(0, 12)}) — file edited by hand?`
      );
    }
    log(`  · ${req.key}: offline, ${buf.length} bytes from cache`);
    return {
      key: req.key,
      text,
      parsed: parseIfNeeded(text),
      fromCache: true,
      meta: { ...(existing || {}), sha256: digest, bytes: buf.length, offline: true },
    };
  }

  // ---- Network path -------------------------------------------------------
  const errors = [];
  for (const url of req.urls) {
    const safeUrl = redactUrl(url, req.redact);
    try {
      log(`  → ${req.key}: fetching ${safeUrl}`);
      const res = await httpRequest(url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        timeoutMs: req.timeoutMs,
      });

      if (!res.ok) {
        errors.push(`HTTP ${res.status} from ${safeUrl}`);
        continue;
      }

      // Validate BEFORE writing, so an error page never clobbers good cache.
      let parsed = null;
      if (req.format === 'json') {
        try {
          parsed = JSON.parse(res.text);
        } catch (err) {
          errors.push(`invalid JSON from ${safeUrl}: ${err.message}`);
          continue;
        }
      }
      if (typeof req.validate === 'function') {
        const problem = req.validate(req.format === 'json' ? parsed : res.text);
        if (problem) {
          errors.push(`validation failed for ${safeUrl}: ${problem}`);
          continue;
        }
      }

      const buf = Buffer.from(res.text, 'utf8');
      const digest = sha256(buf);
      const changed = !existing || existing.sha256 !== digest;

      fs.writeFileSync(cachePath, buf);
      manifest.entries[req.key] = {
        url: safeUrl,
        fetchedAt: new Date().toISOString(),
        sha256: digest,
        bytes: buf.length,
        previousSha256: existing ? existing.sha256 : null,
        previousBytes: existing ? existing.bytes : null,
        changed,
      };
      writeManifest(manifest);

      log(
        `  ✓ ${req.key}: ${buf.length} bytes, sha256 ${digest.slice(0, 12)}` +
          (changed ? ' (CHANGED)' : ' (unchanged)')
      );

      return {
        key: req.key,
        text: res.text,
        parsed,
        fromCache: false,
        meta: manifest.entries[req.key],
      };
    } catch (err) {
      errors.push(`${safeUrl}: ${err.message}`);
    }
  }

  // ---- All mirrors failed: fall back to cache if we have it ---------------
  if (haveCache) {
    const buf = fs.readFileSync(cachePath);
    const text = buf.toString('utf8');
    log(
      `  ! ${req.key}: all fetches failed (${errors.join('; ')}) — ` +
        `falling back to cached copy from ${(existing && existing.fetchedAt) || 'unknown time'}`
    );
    return {
      key: req.key,
      text,
      parsed: parseIfNeeded(text),
      fromCache: true,
      meta: { ...(existing || {}), staleFallback: true, fetchErrors: errors },
    };
  }

  throw new Error(`${req.key}: could not fetch and no cache available. ${errors.join('; ')}`);
}

module.exports = {
  CACHE_DIR,
  DEFAULT_ACCEPT,
  DEFAULT_USER_AGENT,
  MANIFEST_PATH,
  RAW_DIR,
  ensureDirs,
  httpRequest,
  readManifest,
  redactUrl,
  retrieve,
  sha256,
  writeManifest,
};
