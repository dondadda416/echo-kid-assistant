/**
 * Loads and validates config/policy.yaml, and owns the text normalisation the
 * deterministic input gate matches against.
 *
 * Patterns are compiled once at module load. A malformed policy file throws at
 * cold start rather than silently disabling a blocklist — a pipeline running
 * with no blocklist is worse than a pipeline that will not start.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Policy } from '../types.js';

const POLICY_URL = new URL('../../config/policy.yaml', import.meta.url);

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Leet substitutions applied before matching. `1` is ambiguous (i or l) so
 * normalisation produces one variant per reading and the gate matches against
 * both. Digits inside genuine numbers get mangled by this, which is harmless:
 * no blocklist term contains a digit.
 */
const LEET: Record<string, string> = {
  '0': 'o',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '@': 'a',
  $: 's',
};

function applyLeet(s: string, one: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '1') out += one;
    else out += LEET[ch] ?? ch;
  }
  return out;
}

/**
 * Joins runs of two or more single letters into one word, so "s e x",
 * "s.e.x" and "s-e-x" all normalise to "sex" while ordinary words keep their
 * boundaries ("i am hurt" stays three tokens).
 */
function collapseLetterRuns(s: string): string {
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length >= 2) out.push(run.join(''));
    else if (run.length === 1) out.push(run[0]!);
    run = [];
  };
  for (const t of s.split(' ')) {
    if (t === '') continue;
    if (t.length === 1 && t >= 'a' && t <= 'z') {
      run.push(t);
      continue;
    }
    flush();
    out.push(t);
  }
  flush();
  return out.join(' ');
}

function normalizeOne(text: string, one: string): string {
  const leeted = applyLeet(text.toLowerCase(), one);
  let cleaned = '';
  for (const ch of leeted) {
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    cleaned += ok ? ch : ' ';
  }
  return collapseLetterRuns(cleaned.split(' ').filter(Boolean).join(' '));
}

/**
 * Normalised readings of an utterance for deterministic matching. Returns one
 * or two strings; a match against ANY of them counts as a hit.
 */
export function normalizeForMatch(text: string): string[] {
  const a = normalizeOne(text, 'i');
  const b = normalizeOne(text, 'l');
  return a === b ? [a] : [a, b];
}

/** Light normalisation for the PII scan: digits and punctuation survive. */
export function normalizeForPII(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export interface CompiledPolicy {
  policy: Policy;
  /** Word-boundary matchers over normalised text. */
  blocklist: RegExp[];
  /** Word-boundary matchers over normalised text. */
  distress: RegExp[];
  /** Word-boundary matchers over normalised text. */
  injection: RegExp[];
  /** Case-insensitive matchers over lightly-normalised text. */
  pii: RegExp[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a policy phrase to a word-boundary regex over normalized text.
 *
 * Word boundaries are NOT optional here. Bare substring matching made "him"
 * match the normalized form of "i'm" ("im"), so "make him hurt the dragon",
 * "the storm made him scared" and "tim hurt his knee" all routed to DISTRESS.
 * That fails closed, so it was never unsafe — but "him" is everywhere in the
 * story register this assistant exists for, and a distress line that fires on
 * ordinary play teaches a child to ignore the one response that has to land
 * when it is real. Every phrase list goes through this function.
 */
function toPhraseRe(term: string): RegExp {
  const norm = normalizeOne(term, 'i');
  return new RegExp(`\\b${escapeRe(norm).replace(/ /g, '\\s+')}\\b`);
}

/** @deprecated Kept as an alias; all phrase lists now use the same compiler. */
const toBlocklistRe = toPhraseRe;

function requireStringArray(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`policy: bad ${name}`);
  }
  return v as string[];
}

function requireNumber(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`policy: bad ${name}`);
  }
  return v;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`policy: bad ${name}`);
  }
  return v;
}

/**
 * Parse + validate a policy file. Throws on anything unexpected.
 * Defaults to the repo's config/policy.yaml so callers outside the pipeline
 * (api/alexa.ts) can just call `loadPolicy()`.
 */
export function loadPolicy(path: string | URL = POLICY_URL): Policy {
  const raw: unknown = parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new Error('policy: empty');
  const o = raw as Record<string, unknown>;

  const gen = o['generation'];
  if (typeof gen !== 'object' || gen === null) {
    throw new Error('policy: bad generation');
  }
  const g = gen as Record<string, unknown>;

  return {
    personaName: requireString(o['personaName'], 'personaName'),
    invocationName: requireString(o['invocationName'], 'invocationName'),
    sessionCapMinutes: requireNumber(o['sessionCapMinutes'], 'sessionCap'),
    turnCap: requireNumber(o['turnCap'], 'turnCap'),
    historyTurns: requireNumber(o['historyTurns'], 'historyTurns'),
    maxSpeechChars: requireNumber(o['maxSpeechChars'], 'maxSpeechChars'),
    deadlineMs: requireNumber(o['deadlineMs'], 'deadlineMs'),
    generation: {
      maxTokens: requireNumber(g['maxTokens'], 'maxTokens'),
      storyMaxTokens: requireNumber(g['storyMaxTokens'], 'storyMax'),
      temperature: requireNumber(g['temperature'], 'temperature'),
    },
    blocklist: requireStringArray(o['blocklist'], 'blocklist'),
    distressPatterns: requireStringArray(o['distressPatterns'], 'distress'),
    injectionPatterns: requireStringArray(o['injectionPatterns'], 'injection'),
    piiPatterns: requireStringArray(o['piiPatterns'], 'pii'),
  };
}

/** Compile the pattern lists once. */
export function compilePolicy(policy: Policy): CompiledPolicy {
  if (policy.blocklist.length === 0) throw new Error('policy: no blocklist');
  return {
    policy,
    blocklist: policy.blocklist.map(toBlocklistRe),
    distress: policy.distressPatterns.map(toPhraseRe),
    injection: policy.injectionPatterns.map(toPhraseRe),
    pii: policy.piiPatterns.map((p) => new RegExp(p, 'i')),
  };
}

/** Load + compile in one step (used by tests with a fixture path). */
export function loadCompiledPolicy(
  path: string | URL = POLICY_URL,
): CompiledPolicy {
  return compilePolicy(loadPolicy(path));
}

/** Cold-start singletons. */
export const policy: Policy = loadPolicy(POLICY_URL);
export const compiledPolicy: CompiledPolicy = compilePolicy(policy);
