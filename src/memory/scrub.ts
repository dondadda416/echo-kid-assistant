/**
 * PII scrubbing. Safety-critical.
 *
 * Two jobs:
 *
 *  1. `containsPII(text, policy)` — the deterministic flag used by the input
 *     gate and the log. Matches `policy.piiPatterns`, which mixes literal
 *     phrases ("my name is") with regular expressions ("\b\d{3}-\d{4}\b").
 *
 *  2. `scrubLine(line)` — the last gate before anything is written to
 *     `user_memory`. It runs AFTER the extraction model, so a model that
 *     ignores its instructions still cannot store an identifying detail.
 *
 * Bias: aggressive. A false positive costs one line of "likes horses". A false
 * negative writes a child's school, street, or a friend's name into a database.
 * Every ambiguous case drops the line.
 */

import type { Policy } from '../types.ts';

// ---------------------------------------------------------------------------
// containsPII
// ---------------------------------------------------------------------------

/** Mirrors config/policy.yaml `piiPatterns`; used when no policy is passed. */
export const DEFAULT_PII_PATTERNS: string[] = [
  'my name is',
  'i live at',
  'i live on',
  'my address is',
  'my school is',
  'my teacher is',
  'my phone number',
  'my birthday is',
  '\\b\\d{3}[-. ]?\\d{3}[-. ]?\\d{4}\\b',
  '\\b\\d{1,5}\\s+[A-Za-z]+\\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|way|boulevard|blvd)\\b',
];

/** Regex metacharacters. A pattern containing any of these is compiled. */
const META = /[\\\[\]{}()*+?|^$]/;

/** True when a policy entry should be treated as a regular expression. */
export function isRegexPattern(pattern: string): boolean {
  return META.test(pattern);
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lowercase, normalize curly quotes, collapse whitespace. */
function normalize(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * True when the text matches any PII pattern. Never throws: a pattern that
 * fails to compile is retried as a literal substring.
 */
export function containsPII(
  text: string,
  policy?: Pick<Policy, 'piiPatterns'> | null,
): boolean {
  if (!text) return false;
  const patterns =
    policy && Array.isArray(policy.piiPatterns) && policy.piiPatterns.length > 0
      ? policy.piiPatterns
      : DEFAULT_PII_PATTERNS;
  const raw = text;
  const norm = normalize(text);

  for (const pattern of patterns) {
    if (!pattern) continue;
    if (isRegexPattern(pattern)) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(pattern, 'i');
      } catch {
        re = null;
      }
      if (re) {
        if (re.test(raw) || re.test(norm)) return true;
        continue;
      }
      // Uncompilable: fall through to literal matching.
    }
    const lit = normalize(pattern);
    if (lit && norm.includes(lit)) return true;
    // Also try a word-boundary match on the raw text for short literals.
    try {
      if (new RegExp(`\\b${escapeLiteral(lit)}\\b`, 'i').test(raw)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// scrubLine
// ---------------------------------------------------------------------------

/** Why a line was dropped — returned by `scrubReason`, used in tests/docs. */
export type DropReason =
  | 'empty'
  | 'too_long'
  | 'name'
  | 'phone'
  | 'address'
  | 'school'
  | 'birthday'
  | 'place'
  | 'alone'
  | 'family'
  | 'schedule'
  | 'health'
  | 'contact'
  | 'proper_noun'
  | 'meta';

interface Rule {
  reason: DropReason;
  re: RegExp;
}

/**
 * Capitalized words that are safe to keep. Everything else that is capitalized
 * mid-line is treated as a possible person, school, or place name.
 */
const SAFE_CAPITALS = new Set(
  [
    'i',
    'a',
    'the',
    'tv',
    'ok',
    // astronomy — the one place a proper noun is a genuine preference
    'mercury',
    'venus',
    'earth',
    'mars',
    'jupiter',
    'saturn',
    'uranus',
    'neptune',
    'pluto',
    'sun',
    'moon',
    'milky',
    'way',
    'orion',
    // languages / subjects that can legitimately show up capitalized
    'english',
    'spanish',
    'french',
    'math',
    'maths',
    'science',
    'lego',
    'legos',
  ].map((w) => w.toLowerCase()),
);

const RULES: Rule[] = [
  // --- names --------------------------------------------------------------
  // Any mention of a name at all: "name is", "named", "her name", "call me".
  { reason: 'name', re: /\bnam(e|es|ed|ing)\b/i },
  { reason: 'name', re: /\bname's\b/i },
  { reason: 'name', re: /\b(call|calls|called)\s+(me|him|her|them|us)\b/i },
  { reason: 'name', re: /\bgoes\s+by\b/i },
  { reason: 'name', re: /\bi\s+am\s+[A-Z][a-z]+\b/ },
  { reason: 'name', re: /\bi'?m\s+[A-Z][a-z]+\b/ },
  { reason: 'name', re: /\bfirst\s+(and\s+last\s+)?name\b/i },
  { reason: 'name', re: /\bl(ast|ast-)\s*name\b/i },
  { reason: 'name', re: /\bsurname\b/i },
  { reason: 'name', re: /\binitials\b/i },

  // --- phone numbers ------------------------------------------------------
  { reason: 'phone', re: /\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b/ },
  { reason: 'phone', re: /\(\s*\d{3}\s*\)\s*\d{3}[-. ]?\d{4}/ },
  { reason: 'phone', re: /\b\d{7,}\b/ },
  { reason: 'phone', re: /\bphone|\bcell\b|\bmobile\s+number|\btelephone\b/i },
  { reason: 'phone', re: /\bnumber\s+is\s+\d/i },

  // --- addresses ----------------------------------------------------------
  {
    reason: 'address',
    re: /\b\d{1,5}\s+[A-Za-z][A-Za-z'.-]*\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|way|boulevard|blvd|circle|cir|place|pl|terrace|trail|parkway|pkwy)\b/i,
  },
  { reason: 'address', re: /\baddress\b/i },
  { reason: 'address', re: /\bi\s+live\s+(at|on|in|near)\b/i },
  { reason: 'address', re: /\b(lives|living|we\s+live|they\s+live)\s+(at|on|in|near)\b/i },
  { reason: 'address', re: /\b(apartment|apt\.?|unit\s+\d|house\s+number|po\s+box)\b/i },
  { reason: 'address', re: /\bzip\s*code\b|\bpostal\s*code\b/i },
  { reason: 'address', re: /\b\d{5}(-\d{4})?\b/ },
  { reason: 'address', re: /\bmoved\s+(to|from)\b/i },

  // --- school / teacher ---------------------------------------------------
  { reason: 'school', re: /\bschool\b|\bschools\b/i },
  { reason: 'school', re: /\bteacher\b|\bteachers\b/i },
  { reason: 'school', re: /\bclassroom\b|\bclassmate\b|\bmy\s+class\b/i },
  { reason: 'school', re: /\bprincipal\b|\bhomeroom\b|\brecess\s+at\b/i },
  { reason: 'school', re: /\b(kindergarten|preschool|pre-?k|daycare|elementary|academy)\b/i },
  { reason: 'school', re: /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+grade\b/i },
  { reason: 'school', re: /\bgrade\s*\d\b|\bin\s+grade\b|\bmy\s+grade\b/i },
  { reason: 'school', re: /\bbus\s*(number|#)?\s*\d+\b/i },
  { reason: 'school', re: /\b(mrs?|ms|miss|mister)\.?\s+[A-Z][a-z]+/ },

  // --- birthday / age / dates --------------------------------------------
  { reason: 'birthday', re: /\bbirth\s*day\b|\bbirthday\b|\bbirthdate\b|\bdate\s+of\s+birth\b/i },
  { reason: 'birthday', re: /\bborn\s+(on|in|at)\b/i },
  { reason: 'birthday', re: /\b\d{1,2}\s*[\/.-]\s*\d{1,2}(\s*[\/.-]\s*\d{2,4})?\b/ },
  {
    reason: 'birthday',
    re: /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/i,
  },
  { reason: 'birthday', re: /\b\d{1,2}\s+years?\s+old\b|\bturns?\s+\d{1,2}\b|\bage\s+\d{1,2}\b/i },
  { reason: 'birthday', re: /\b(19|20)\d{2}\b/ },

  // --- town / city / place ------------------------------------------------
  { reason: 'place', re: /\b(town|city|village|county|neighborhood|neighbourhood|state|province|country)\b/i },
  { reason: 'place', re: /\bfrom\s+[A-Z][a-z]+,\s*[A-Z]/ },
  { reason: 'place', re: /\bstreet\b|\bavenue\b|\bcul-de-sac\b/i },
  { reason: 'place', re: /\bnear\s+the\s+[A-Z]/ },

  // --- home alone / parents' whereabouts ----------------------------------
  { reason: 'alone', re: /\bhome\s+alone\b|\balone\s+at\s+home\b|\ball\s+by\s+(my|her|him)self\b/i },
  { reason: 'alone', re: /\bno\s*(body|one)\s+(is\s+)?home\b/i },
  { reason: 'alone', re: /\bnobody\s+else\s+is\s+here\b/i },
  { reason: 'alone', re: /\b(mom|mommy|mum|mother|dad|daddy|father|parents?|grandma|grandpa|babysitter)\b[^.]{0,30}\b(is|are|works?|working|goes|went|leaves?|left|gets\s+home|comes\s+home|at\s+work|out\s+of\s+town|away|night\s+shift)\b/i },
  { reason: 'alone', re: /\bwatches?\s+(her|him|me)\s+after\b/i },
  { reason: 'alone', re: /\bwhen\s+(mom|dad|my\s+parents)\b/i },

  // --- family / friends ---------------------------------------------------
  { reason: 'family', re: /\b(brother|sister|cousin|aunt|uncle|grandma|grandpa|grandmother|grandfather|stepmom|stepdad|babysitter|nanny|neighbou?r)\b/i },
  { reason: 'family', re: /\b(friend|friends|bestie)\b\s+[A-Z][a-z]+/ },
  { reason: 'family', re: /\bmy\s+(best\s+)?friend\s+(is|named|called)\b/i },
  { reason: 'family', re: /\b(my\s+)?(mom|dad|mommy|daddy)\b\s+[A-Z][a-z]+/ },

  // --- schedule -----------------------------------------------------------
  { reason: 'schedule', re: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i },
  { reason: 'schedule', re: /\b\d{1,2}\s*(:\s*\d{2})?\s*(am|pm|o'clock)\b/i },
  { reason: 'schedule', re: /\bevery\s+(day|week|morning|night|afternoon)\s+at\b/i },
  { reason: 'schedule', re: /\b(bedtime|wakes?\s+up|gets?\s+picked\s+up|after\s+school|practice\s+at|lessons?\s+at)\b/i },

  // --- health -------------------------------------------------------------
  { reason: 'health', re: /\b(allerg\w*|asthma|inhaler|epipen|medicine|medication|pills?|doctor|dentist|hospital|clinic|diagnos\w*|therapy|therapist|surgery|diabet\w*|seizure)\b/i },

  // --- contact / online ---------------------------------------------------
  { reason: 'contact', re: /https?:\/\/|www\.|\.com\b|\.org\b|\.net\b/i },
  { reason: 'contact', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/ },
  { reason: 'contact', re: /\b(email|e-mail|username|password|account|instagram|tiktok|youtube\s+channel|snapchat|discord)\b/i },

  // --- meta / prompt leakage ---------------------------------------------
  { reason: 'meta', re: /\b(system\s+prompt|instructions?\s+say|as\s+an\s+ai|ignore\s+(the\s+)?rules)\b/i },
];

const MAX_LINE_CHARS = 120;

/**
 * Full result of scrubbing. `scrubLine` is the thin wrapper most callers want.
 */
export function scrubReason(line: string): DropReason | null {
  const trimmed = cleanWhitespace(line);
  if (trimmed.length < 3) return 'empty';
  if (trimmed.length > MAX_LINE_CHARS) return 'too_long';

  // Rules run against the raw line as well as the cleaned one: the cleaner
  // strips leading punctuation and digits, and must never be able to hide a
  // phone number or house number from a rule.
  const raw = String(line);
  for (const rule of RULES) {
    if (rule.re.test(trimmed) || rule.re.test(raw)) return rule.reason;
  }

  // Any capitalized token after the first word that isn't on the allowlist is
  // treated as a person / school / place name and the line is dropped.
  const words = trimmed.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const bare = w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    if (bare.length < 2) continue;
    const first = bare[0]!;
    if (first !== first.toUpperCase() || first === first.toLowerCase()) continue;
    if (SAFE_CAPITALS.has(bare.toLowerCase())) continue;
    // Allow a capital that starts a new sentence ("Likes horses. Reads a lot.")
    const prev = words[i - 1]!;
    if (/[.!?]$/.test(prev)) continue;
    return 'proper_noun';
  }

  return null;
}

function cleanWhitespace(line: string): string {
  return line
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/^[\s\-*•>"'`\[\](){}0-9.]+/, '')
    .replace(/["'`]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns a cleaned memory line, or null when the line must not be stored.
 *
 * Drops: names, phone shapes, addresses, schools and teachers, birthdays and
 * dates, towns and places, home-alone or parent-whereabouts statements, family
 * and friend references, schedules, health details, contact handles, and any
 * unrecognised capitalized proper noun.
 */
export function scrubLine(line: string | null | undefined): string | null {
  if (typeof line !== 'string') return null;
  if (scrubReason(line) !== null) return null;
  return cleanWhitespace(line);
}

/** Convenience: scrub a batch, dropping anything that fails. */
export function scrubLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const clean = scrubLine(l);
    if (clean !== null) out.push(clean);
  }
  return out;
}
