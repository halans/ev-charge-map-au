'use strict';
/**
 * Field normalisation. Zero dependencies, no Node built-ins (runs in browser too).
 *
 * Every rule in this file exists because real Australian open data contains the
 * mess it handles. Measurements taken 2026-09-05 are cited inline so a future
 * maintainer can tell a defensive rule from a superstitious one.
 */

/* ------------------------------------------------------------------ *
 * Operator / network canonicalisation
 * ------------------------------------------------------------------ */

/**
 * Canonical operator names -> alias patterns.
 * Motivation: TfNSW ships "BP" (32 rows) and "BP Australia" (28 rows) as
 * distinct operators, and "Tesla" (260) alongside "Tesla Motors" (27). OSM
 * adds its own spellings. Without folding, operator facets are nonsense and
 * cross-source matching misses.
 */
const OPERATOR_ALIASES = {
  Tesla: ['tesla', 'tesla motors', 'tesla inc', 'tesla australia', 'tesla supercharger'],
  Chargefox: ['chargefox', 'charge fox'],
  'Evie Networks': ['evie', 'evie networks', 'evienetworks'],
  'BP Pulse': ['bp', 'bp australia', 'bp pulse', 'bppulse', 'bp charge', 'bp chargemaster'],
  Ampol: ['ampol', 'ampol ampcharge', 'ampcharge', 'ampol energy'],
  NRMA: ['nrma', 'nrma parks and resorts', 'the nrma'],
  JOLT: ['jolt', 'jolt charge', 'jolt energy'],
  Exploren: ['exploren'],
  EVX: ['evx', 'evx australia'],
  'PLUS ES': ['plus es', 'plused', 'plus-es', 'plusesaustralia', 'plus es australia'],
  EVUp: ['evup', 'ev up'],
  Everty: ['everty'],
  'Origin Energy': ['origin', 'origin energy'],
  AGL: ['agl', 'agl energy'],
  Engie: ['engie'],
  'Charge Post': ['charge post', 'chargepost'],
  'RAA': ['raa', 'raa charge', 'royal automobile association of south australia'],
  'RAC WA': ['rac', 'rac wa', 'rac electric highway', 'royal automobile club of wa'],
  Wattblock: ['wattblock'],
  'Schneider Electric': ['schneider', 'schneider electric'],
  ChargePoint: ['chargepoint', 'charge point'],
  Tritium: ['tritium'],
  'Non-networked': [
    'non-networked',
    'non networked',
    'nonnetworked',
    'unknown',
    'n/a',
    'na',
    'none',
    'private',
    'other',
  ],
};

// Flattened alias -> canonical lookup, built once.
const OPERATOR_LOOKUP = new Map();

/** Strip company suffixes and punctuation for alias matching. */
function operatorKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[‘’'`]/g, '')
    .replace(/\b(pty|ltd|limited|inc|llc|group|holdings|australia|aust)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Populated AFTER operatorKey is defined, because aliases must be stored under
// the same normalised form that lookups use. Storing the raw alias "n/a" would
// never match, since operatorKey turns the input into "n a".
for (const [canonical, aliases] of Object.entries(OPERATOR_ALIASES)) {
  OPERATOR_LOOKUP.set(operatorKey(canonical), canonical);
  for (const a of aliases) OPERATOR_LOOKUP.set(operatorKey(a), canonical);
}

/**
 * Canonicalise an operator/network name.
 * Unknown operators are title-cased and passed through rather than discarded —
 * an unrecognised operator is still information.
 * @param {string} raw
 * @returns {string|null}
 */
function normaliseOperator(raw) {
  const key = operatorKey(raw);
  if (!key) return null;
  const direct = OPERATOR_LOOKUP.get(key);
  if (direct) return direct;
  // Prefix/containment pass: "tesla supercharger site 12" -> Tesla.
  for (const [alias, canonical] of OPERATOR_LOOKUP) {
    if (alias.length >= 4 && (key === alias || key.startsWith(alias + ' '))) return canonical;
  }
  return String(raw).trim().replace(/\s+/g, ' ');
}

/* ------------------------------------------------------------------ *
 * Positional precision
 * ------------------------------------------------------------------ */

/**
 * How a record's coordinate was obtained, and therefore how much it can be
 * trusted as a *position*.
 *
 * This is a graded property rather than a boolean because the three cases have
 * genuinely different error budgets, and conflating them produces a map that
 * lies about where a charger is:
 *
 *  - `surveyed`          The publisher supplied coordinates. Error: metres.
 *                        (OpenStreetMap, TfNSW, Victoria, Queensland.)
 *  - `geocoded_address`  Derived from a street address. Error: tens of metres,
 *                        occasionally ~100 m. Usable on a map with a caveat.
 *                        (ACT.)
 *  - `geocoded_locality` Derived from a town or suburb NAME, because the source
 *                        publishes nothing finer. Error: hundreds of metres to
 *                        kilometres — the pin marks the town, not the charger.
 *                        (Tasmania's ChargeSmart grant list.)
 *
 * Locality precision is real information — "there is a funded charger in
 * Miena" is worth knowing and searching — but it is NOT a location. So such
 * records are excluded from the default map view, never merged with other
 * sources, and ranked last for coordinates.
 */
const POSITION_PRECISION = {
  SURVEYED: 'surveyed',
  GEOCODED_ADDRESS: 'geocoded_address',
  GEOCODED_LOCALITY: 'geocoded_locality',
};

/** Precisions considered accurate enough to plot as a charger location. */
const MAPPABLE_PRECISIONS = [
  POSITION_PRECISION.SURVEYED,
  POSITION_PRECISION.GEOCODED_ADDRESS,
];

/** Nominal positional error, for UI copy and confidence scoring. */
const PRECISION_ERROR_METRES = {
  [POSITION_PRECISION.SURVEYED]: 10,
  [POSITION_PRECISION.GEOCODED_ADDRESS]: 100,
  [POSITION_PRECISION.GEOCODED_LOCALITY]: 5000,
};

/**
 * A record's precision, defaulting to surveyed for sources that predate the
 * field (they all publish coordinates).
 */
function positionPrecision(record) {
  if (!record) return POSITION_PRECISION.SURVEYED;
  if (record.positionPrecision) return record.positionPrecision;
  return record.geocoded ? POSITION_PRECISION.GEOCODED_ADDRESS : POSITION_PRECISION.SURVEYED;
}

/** Is this coordinate precise enough to place a pin on? */
function isMappable(record) {
  return MAPPABLE_PRECISIONS.includes(positionPrecision(record));
}

/** Was this coordinate derived rather than published? */
function isGeocoded(record) {
  return positionPrecision(record) !== POSITION_PRECISION.SURVEYED;
}

/** Is this only known to town/suburb level? */
function isLocalityOnly(record) {
  return positionPrecision(record) === POSITION_PRECISION.GEOCODED_LOCALITY;
}

/* ------------------------------------------------------------------ *
 * Connector standards
 * ------------------------------------------------------------------ */

/** Canonical connector standards used across the project. */
const CONNECTORS = {
  CCS2: 'CCS2',
  CCS1: 'CCS1',
  CHADEMO: 'CHAdeMO',
  TYPE2: 'Type2',
  TYPE1: 'Type1',
  TESLA: 'TeslaProprietary',
  AC_UNSPECIFIED: 'ACUnspecified',
  DC_UNSPECIFIED: 'DCUnspecified',
};

/** DC-capable standards, for maxPower/speed classification. */
const DC_STANDARDS = new Set([CONNECTORS.CCS2, CONNECTORS.CCS1, CONNECTORS.CHADEMO, CONNECTORS.DC_UNSPECIFIED, CONNECTORS.TESLA]);

/**
 * Map a free-text or OSM socket key to a canonical connector standard.
 * @param {string} raw
 * @returns {string|null}
 */
function normaliseConnector(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!s) return null;
  /**
   * CCS must be tested before the bare Type 2 check. Open Charge Map labels
   * the standard "CCS (Type 2)", which collapses to "ccstype2" — that contains
   * "type2", so a Type-2-first order would misclassify a DC CCS2 plug as a
   * slow AC socket. Anything mentioning CCS alongside Type 2 is CCS2.
   */
  if (
    s.includes('type2combo') ||
    s.includes('ccs2') ||
    s.includes('ccscombo2') ||
    s === 'ccs' ||
    (s.includes('ccs') && s.includes('type2'))
  ) {
    return CONNECTORS.CCS2;
  }
  if (s.includes('type1combo') || s.includes('ccs1') || (s.includes('ccs') && s.includes('type1'))) {
    return CONNECTORS.CCS1;
  }
  if (s.includes('chademo')) return CONNECTORS.CHADEMO;
  if (s.includes('tesla') || s.includes('supercharger')) return CONNECTORS.TESLA;
  if (s.includes('type2') || s.includes('mennekes')) return CONNECTORS.TYPE2;
  if (s.includes('type1') || s.includes('j1772')) return CONNECTORS.TYPE1;
  if (s === 'dc' || s.includes('dcfast') || s.includes('rapid')) return CONNECTORS.DC_UNSPECIFIED;
  if (s === 'ac' || s.includes('acsocket') || s.includes('destination')) return CONNECTORS.AC_UNSPECIFIED;
  return null;
}

/* ------------------------------------------------------------------ *
 * Power ratings
 * ------------------------------------------------------------------ */

/**
 * Parse a free-text power rating into structured plug groups.
 *
 * Real TfNSW `Charger_rating` values this must survive (2026-09-05 counts):
 *   "22 kW" (634)  -> [{ count:1, kw:22 }]
 *   "AC"    (522)  -> []            (a current type, not a rating)
 *   "2x350kW & 2x175kW" (85) -> [{count:2,kw:350},{count:2,kw:175}]
 *   "6 kW" / "7 kW" / "50 kW" / "175 kW" ...
 *
 * @param {string} raw
 * @returns {{groups: Array<{count:number, kw:number}>, maxKw: number|null, note: string|null}}
 */
function parsePowerRating(raw) {
  const text = String(raw || '').trim();
  if (!text) return { groups: [], maxKw: null, note: null };

  // Bare current-type strings carry no power information at all.
  if (/^(ac|dc|ac\/dc|type\s*2|unknown|n\/a|na|tbc|upcoming)$/i.test(text)) {
    return { groups: [], maxKw: null, note: `no rating (value was "${text}")` };
  }

  const groups = [];
  // Match "2x350kW", "2 x 350 kW", "350kW", "350 kw", "350"
  const re = /(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(kw|kilowatt|mw)?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const count = m[1] ? parseInt(m[1], 10) : 1;
    let kw = parseFloat(m[2]);
    if (!Number.isFinite(kw) || kw <= 0) continue;
    if ((m[3] || '').toLowerCase() === 'mw') kw *= 1000;
    // Reject implausible values: nothing public in AU is >1000 kW per plug,
    // and sub-1kW is a parse artefact (e.g. a stray postcode fragment).
    if (kw < 1 || kw > 1000) continue;
    groups.push({ count: Math.min(Math.max(count, 1), 64), kw });
  }

  if (!groups.length) return { groups: [], maxKw: null, note: `unparsed rating "${text}"` };
  const maxKw = groups.reduce((a, g) => Math.max(a, g.kw), 0);
  return { groups, maxKw, note: null };
}

/**
 * Speed band derived from peak power. Bands chosen to match how drivers
 * actually choose a charger, not arbitrary round numbers.
 * @param {number|null} kw
 * @returns {string}
 */
function speedBand(kw) {
  if (!Number.isFinite(kw) || kw <= 0) return 'unknown';
  if (kw < 7) return 'trickle'; // <7kW  — overnight only
  if (kw < 25) return 'slow'; // 7-22kW — AC destination
  if (kw < 50) return 'medium'; // 25-49kW
  if (kw < 150) return 'fast'; // 50-149kW
  if (kw < 250) return 'rapid'; // 150-249kW
  return 'ultra'; // 250kW+
}

/* ------------------------------------------------------------------ *
 * Status / access / fee
 * ------------------------------------------------------------------ */

/**
 * Normalise operational status.
 *
 * Critical: TfNSW encodes 98 *unbuilt* chargers as Charger_Type="Upcoming".
 * Shipping those as live sites would send drivers to empty car parks, so
 * status is a first-class field and the default map view excludes planned.
 * @returns {'operational'|'planned'|'construction'|'decommissioned'|'unknown'}
 */
function normaliseStatus(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (/upcoming|planned|proposed|future|coming soon/.test(s)) return 'planned';
  if (/construction|under way|underway|building/.test(s)) return 'construction';
  if (/removed|decommission|closed|abandoned|disused|permanently/.test(s)) return 'decommissioned';
  if (/active|operational|available|in service|open|existing|yes/.test(s)) return 'operational';
  return 'unknown';
}

/**
 * Normalise public access. OSM uses access=yes/private/customers/permissive.
 * @returns {'public'|'restricted'|'private'|'unknown'}
 */
function normaliseAccess(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (/^(yes|public|permissive|designated)$/.test(s)) return 'public';
  if (/customer|guest|patron|permit|residents|members/.test(s)) return 'restricted';
  if (/^(private|no)$/.test(s)) return 'private';
  return 'unknown';
}

/**
 * Normalise a fee flag to a tri-state. `null` means genuinely unknown, which
 * is different from free — the UI must not imply free when it does not know.
 * @returns {boolean|null}
 */
function normaliseFee(raw) {
  if (raw === true || raw === false) return raw;
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return null;
  if (/^(yes|true|paid|pay)/.test(s)) return true;
  if (/^(no|false|free)/.test(s)) return false;
  return null;
}

/* ------------------------------------------------------------------ *
 * Text / address
 * ------------------------------------------------------------------ */

/** Collapse whitespace, strip control chars, trim. */
function cleanText(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s === '' ? null : s;
}

const AU_STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'];

/**
 * Pull structured parts out of a single-line Australian address.
 * TfNSW ships things like ", Muswellbrook, 2333" (leading empty street) and
 * "38 Abbott Rd, Seven Hills NSW 2147", so both shapes must work.
 * @param {string} raw
 */
function parseAddress(raw) {
  const text = cleanText(raw);
  if (!text) return { full: null, street: null, suburb: null, state: null, postcode: null };

  const postcodeMatch = text.match(/\b(\d{4})\b(?!.*\b\d{4}\b)/);
  const postcode = postcodeMatch ? postcodeMatch[1] : null;

  let state = null;
  for (const st of AU_STATES) {
    if (new RegExp(`\\b${st}\\b`, 'i').test(text)) {
      state = st;
      break;
    }
  }

  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  let street = null;
  let suburb = null;
  if (parts.length >= 2) {
    street = parts[0] || null;
    // Suburb is the last part with alphabetic content once state/postcode are stripped.
    for (let i = parts.length - 1; i >= 1; i--) {
      const cand = parts[i]
        .replace(new RegExp(`\\b(${AU_STATES.join('|')})\\b`, 'gi'), '')
        .replace(/\b\d{4}\b/g, '')
        .trim();
      if (/[a-z]{2,}/i.test(cand)) {
        suburb = cand;
        break;
      }
    }
  } else {
    street = parts[0] || null;
  }

  // TfNSW ships rows with an empty street segment, e.g. ", Muswellbrook, 2333".
  // Splitting on "," drops the empty leading field, which would misfile the
  // suburb as a street. A street line normally starts with a number or a unit
  // designator; if it does not, and we have no suburb, treat it as the suburb.
  if (street && !suburb && !/^(\d|unit|shop|lot|level|suite|cnr|corner)\b/i.test(street)) {
    suburb = street;
    street = null;
  }

  return { full: text, street, suburb, state, postcode };
}

/**
 * Normalise a name for fuzzy comparison: lowercase, drop generic charging
 * words that carry no discriminating signal, collapse to tokens.
 */
const GENERIC_NAME_WORDS = new Set([
  'ev',
  'charger',
  'chargers',
  'charging',
  'station',
  'stations',
  'site',
  'point',
  'points',
  'electric',
  'vehicle',
  'car',
  'park',
  'carpark',
  'the',
  'at',
  'of',
  'and',
]);

function nameTokens(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!s) return [];
  return s.split(' ').filter((t) => t && !GENERIC_NAME_WORDS.has(t));
}

/**
 * Jaccard token similarity in [0,1]. Cheap, order-insensitive, and good enough
 * for deciding whether "Ampol Foodary Seven Hills" and "Ampol Seven Hills"
 * describe the same site.
 */
function tokenSimilarity(a, b) {
  const A = new Set(nameTokens(a));
  const B = new Set(nameTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/* ------------------------------------------------------------------ *
 * Loose date parsing
 * ------------------------------------------------------------------ */

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8,
  sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parse the inconsistent date strings Australian agencies publish.
 *
 * Victoria's `estimated_project_completion` field alone contains all of:
 *   "31/07/2023"        DD/MM/YYYY  (22 rows)
 *   "December 2026"     month + year
 *   "30 November 2023"  D Month YYYY
 *   "16 October 2023"
 *
 * Returns a UTC Date at the START of the described period, or null. Day-first
 * is assumed for slash formats, which is correct for Australian data and the
 * opposite of what Date.parse() does.
 *
 * @param {string} raw
 * @returns {Date|null}
 */
function parseLooseDate(raw) {
  const text = cleanText(raw);
  if (!text) return null;

  // DD/MM/YYYY or DD-MM-YYYY
  let m = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const year = parseInt(m[3], 10);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      return new Date(Date.UTC(year, month, day));
    }
    return null;
  }

  // "30 November 2023" / "16 October 2023"
  m = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month === undefined) return null;
    return new Date(Date.UTC(parseInt(m[3], 10), month, parseInt(m[1], 10)));
  }

  // "December 2026" — first of that month.
  m = text.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month === undefined) return null;
    return new Date(Date.UTC(parseInt(m[2], 10), month, 1));
  }

  // ISO-ish, safe to hand to the engine.
  m = text.match(/^\d{4}-\d{2}(-\d{2})?/);
  if (m) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/** Slug for stable ID construction. */
function slug(raw, maxLen = 40) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

module.exports = {
  AU_STATES,
  CONNECTORS,
  DC_STANDARDS,
  MAPPABLE_PRECISIONS,
  OPERATOR_ALIASES,
  POSITION_PRECISION,
  PRECISION_ERROR_METRES,
  isGeocoded,
  isLocalityOnly,
  isMappable,
  positionPrecision,
  cleanText,
  nameTokens,
  normaliseAccess,
  normaliseConnector,
  normaliseFee,
  normaliseOperator,
  normaliseStatus,
  operatorKey,
  parseAddress,
  parseLooseDate,
  parsePowerRating,
  slug,
  speedBand,
  tokenSimilarity,
};
