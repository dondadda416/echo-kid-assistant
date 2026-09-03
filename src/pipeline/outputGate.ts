/**
 * Output gate — spec §7.4.
 *
 * Sees ONLY the candidate reply, never the conversation, so it cannot be
 * talked into leniency by context. Only an exact, case-sensitive `PASS` after
 * trimming passes. `pass`, `PASS.`, an empty string, an explanation, a thrown
 * error and an abort are all FAIL. This function never throws.
 */

import { readFileSync } from 'node:fs';
import type { OutputVerdict } from '../types.js';
import { callModel, gateModel, type CallModelFn } from './anthropic.js';

const TEMPLATE = readFileSync(
  new URL('../prompts/outputGate.md', import.meta.url),
  'utf8',
);

const REPLY_SLOT = '{{reply}}';
const ASK = 'PASS or FAIL';

export interface OutputGateResult {
  verdict: OutputVerdict;
  /** Raw model text, verbatim, or the error message on a throw. */
  raw: string | null;
}

export interface OutputGateDeps {
  call?: CallModelFn;
  model?: string;
  signal?: AbortSignal;
}

/** Render the rubric with the reply between the markers. */
export function buildRubric(reply: string): string {
  return TEMPLATE.split(REPLY_SLOT).join(reply);
}

export async function outputGate(
  reply: string,
  deps: OutputGateDeps = {},
): Promise<OutputGateResult> {
  const call = deps.call ?? callModel;
  const model = deps.model ?? gateModel();

  let raw: string | null = null;
  try {
    const out = await call({
      system: buildRubric(reply),
      messages: [{ role: 'user', content: ASK }],
      maxTokens: 5,
      temperature: 0,
      model,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    raw = typeof out === 'string' ? out : null;
  } catch (err) {
    return {
      verdict: 'FAIL',
      raw: err instanceof Error ? err.message : null,
    };
  }

  return { verdict: (raw ?? '').trim() === 'PASS' ? 'PASS' : 'FAIL', raw };
}
