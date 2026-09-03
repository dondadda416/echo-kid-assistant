/**
 * Input gate — spec §7.1 (deterministic stage A) then §7.2 (classifier stage B).
 *
 * Fail-closed contract: this function never throws. Every error path resolves
 * to SENSITIVE, which the orchestrator turns into a canned redirect. The one
 * behaviour that matters most in this file is the classifier parse: only an
 * exact, case-sensitive `OK` / `SENSITIVE` / `DISTRESS` / `NOISE` after
 * trimming is accepted. Everything else is SENSITIVE with reason
 * `classifier_error`.
 */

import { readFileSync } from 'node:fs';
import type { InputReason, InputVerdict } from '../types.js';
import {
  compiledPolicy,
  normalizeForMatch,
  normalizeForPII,
  type CompiledPolicy,
} from './policy.js';
import { callModel, gateModel, type CallModelFn } from './anthropic.js';

const PROMPT = readFileSync(
  new URL('../prompts/inputGate.md', import.meta.url),
  'utf8',
);

/** Tokens that carry no meaning on their own. */
const FILLER = new Set([
  'um',
  'umm',
  'uh',
  'uhh',
  'hm',
  'hmm',
  'hmmm',
  'er',
  'erm',
  'ah',
  'eh',
  'mm',
  'mmm',
  'huh',
  'oh',
  'uhm',
]);

const VERDICTS = new Set<string>(['OK', 'SENSITIVE', 'DISTRESS', 'NOISE']);

export interface InputGateResult {
  verdict: InputVerdict;
  reason: InputReason;
  /** Raw classifier text, verbatim, or null when stage A decided. */
  raw: string | null;
  containsPII: boolean;
}

export interface InputGateDeps {
  call?: CallModelFn;
  compiled?: CompiledPolicy;
  model?: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Stage A helpers
// ---------------------------------------------------------------------------

function isNoise(variants: string[]): boolean {
  const text = variants[0] ?? '';
  if (text.length < 2) return true;
  const toks = text.split(' ').filter(Boolean);
  if (toks.length === 0) return true;
  return toks.every((t) => FILLER.has(t) || t.length === 1);
}

function hitsSubstring(variants: string[], needles: string[]): boolean {
  for (const v of variants) {
    for (const n of needles) {
      if (n !== '' && v.includes(n)) return true;
    }
  }
  return false;
}

function hitsRegex(variants: string[], res: RegExp[]): boolean {
  for (const v of variants) {
    for (const re of res) {
      if (re.test(v)) return true;
    }
  }
  return false;
}

/** Deterministic PII scan. Sets a flag; never blocks. */
export function scanPII(utterance: string, compiled: CompiledPolicy): boolean {
  const text = normalizeForPII(utterance);
  return compiled.pii.some((re) => re.test(text));
}

/**
 * Stage A only. Exported for tests and for the red-team runner, which asserts
 * that stage-A hits never reach the generation model.
 */
export function deterministicGate(
  utterance: string,
  compiled: CompiledPolicy,
): { verdict: InputVerdict; reason: InputReason } | null {
  const variants = normalizeForMatch(utterance);

  // 1. Too short / pure filler.
  if (utterance.trim().length < 2 || isNoise(variants)) {
    return { verdict: 'NOISE', reason: 'too_short' };
  }
  // 2. Distress wins over the blocklist when both match.
  if (hitsRegex(variants, compiled.distress)) {
    return { verdict: 'DISTRESS', reason: 'distress_pattern' };
  }
  // 3. Hard blocklist.
  if (hitsRegex(variants, compiled.blocklist)) {
    return { verdict: 'SENSITIVE', reason: 'blocklist' };
  }
  // 4. Prompt-injection shapes.
  if (hitsRegex(variants, compiled.injection)) {
    return { verdict: 'SENSITIVE', reason: 'injection_pattern' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage B
// ---------------------------------------------------------------------------

/**
 * Full input gate. Never throws; never returns a verdict it is not certain of.
 */
export async function inputGate(
  utterance: string,
  deps: InputGateDeps = {},
): Promise<InputGateResult> {
  const compiled = deps.compiled ?? compiledPolicy;

  // The PII flag is informational and is always reported, including on
  // early stage-A returns, so the parent log is complete.
  let containsPII = false;
  try {
    containsPII = scanPII(utterance, compiled);
  } catch {
    containsPII = false;
  }

  let stageA: { verdict: InputVerdict; reason: InputReason } | null = null;
  try {
    stageA = deterministicGate(utterance, compiled);
  } catch {
    return {
      verdict: 'SENSITIVE',
      reason: 'classifier_error',
      raw: null,
      containsPII,
    };
  }
  if (stageA) {
    return { ...stageA, raw: null, containsPII };
  }

  const call = deps.call ?? callModel;
  const model = deps.model ?? gateModel();

  let raw: string | null = null;
  try {
    const out = await call({
      system: PROMPT,
      messages: [{ role: 'user', content: utterance }],
      maxTokens: 10,
      temperature: 0,
      model,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    raw = typeof out === 'string' ? out : null;
  } catch (err) {
    return {
      verdict: 'SENSITIVE',
      reason: 'classifier_error',
      raw: err instanceof Error ? err.message : null,
      containsPII,
    };
  }

  const trimmed = (raw ?? '').trim();
  if (!VERDICTS.has(trimmed)) {
    return {
      verdict: 'SENSITIVE',
      reason: 'classifier_error',
      raw,
      containsPII,
    };
  }

  return {
    verdict: trimmed as InputVerdict,
    reason: 'classifier',
    raw,
    containsPII,
  };
}
