/**
 * Pipeline orchestrator — spec §4.1 (deadline) and §7.5 (decision table).
 *
 * SAFETY INVARIANT
 * ----------------
 * Exactly two expressions in this file assign `speech`:
 *   1. `canned(id, seed)` inside `cannedResult` — the approved, hardcoded lines.
 *   2. `approvedSpeech`, which is only ever produced from generation text that
 *      the output gate returned an exact `PASS` for.
 * tests/unit/canned-invariant.check.ts enforces this by grep. Do not add a
 * third, and never build speech by concatenating model text with anything.
 *
 * The whole body is wrapped in try/catch and raced against
 * `policy.deadlineMs`. Anything that escapes becomes the TIMEOUT canned line
 * with flag `error`.
 */

import { canned } from './canned.js';
import type {
  CannedId,
  ExchangeFlag,
  InputReason,
  InputVerdict,
  PipelineInput,
  PipelineResult,
  Policy,
  TurnAudit,
} from '../types.js';
import {
  compiledPolicy as defaultCompiled,
  policy as defaultPolicy,
  type CompiledPolicy,
} from './policy.js';
import {
  callModel,
  gateModel,
  generationModel,
  type CallModelFn,
} from './anthropic.js';
import { inputGate } from './inputGate.js';
import { generate } from './generate.js';
import { outputGate } from './outputGate.js';

export interface PipelineDeps {
  /** Transport for every model call unless a narrower dep is supplied. */
  call?: CallModelFn;
  /** Transport for the two gate calls. */
  gateCall?: CallModelFn;
  /** Transport for the generation call. */
  genCall?: CallModelFn;
  policy?: Policy;
  compiled?: CompiledPolicy;
  gateModelId?: string;
  genModelId?: string;
  /** Makes canned variant choice deterministic in tests. */
  cannedSeed?: number;
  /**
   * Fired the moment the input gate clears an utterance for generation, so the
   * caller can play a progressive-response filler while the model thinks.
   * Never fired for SENSITIVE / DISTRESS / NOISE — those answer instantly, and
   * a filler ahead of a redirect would be a tell. Must not throw; exceptions
   * are swallowed so a filler can never affect the response path.
   */
  onInputGateOk?: () => void;
}

class DeadlineError extends Error {}

// ---------------------------------------------------------------------------
// Speech length handling
// ---------------------------------------------------------------------------

const ENDERS = ['.', '!', '?'];

/**
 * Trim approved text to `max` characters at a sentence boundary. The remainder
 * becomes the continuation context so the next turn can pick it up.
 */
export function truncateAtSentence(
  text: string,
  max: number,
): { head: string; rest: string } {
  const t = text.trim();
  if (t.length <= max) return { head: t, rest: '' };

  const window = t.slice(0, max);
  let cut = -1;
  for (const e of ENDERS) {
    const i = window.lastIndexOf(e);
    if (i > cut) cut = i;
  }
  // Reject a boundary so early that the child would hear almost nothing.
  if (cut < Math.floor(max * 0.4)) {
    const sp = window.lastIndexOf(' ');
    cut = sp > 0 ? sp - 1 : max - 1;
  }
  return {
    head: t.slice(0, cut + 1).trim(),
    rest: t.slice(cut + 1).trim(),
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function cannedResult(
  id: CannedId,
  flag: ExchangeFlag,
  audit: TurnAudit,
  seed?: number,
): PipelineResult {
  return {
    speech: canned(id, seed),
    cannedId: id,
    keepListening: true,
    continuation: null,
    audit: { ...audit, flag },
  };
}

export async function runPipeline(
  input: PipelineInput,
  deps: PipelineDeps = {},
): Promise<PipelineResult> {
  const pol = deps.policy ?? defaultPolicy;
  const compiled = deps.compiled ?? defaultCompiled;
  const gateCall = deps.gateCall ?? deps.call ?? callModel;
  const genCall = deps.genCall ?? deps.call ?? callModel;
  const gateId = deps.gateModelId ?? gateModel();
  const genId = deps.genModelId ?? generationModel();
  const seed = deps.cannedSeed;

  const started = Date.now();
  const audit: TurnAudit = {
    inputVerdict: 'SENSITIVE',
    inputReason: 'classifier_error',
    inputRaw: null,
    generationText: null,
    outputVerdict: null,
    outputRaw: null,
    flag: 'error',
    containsPII: false,
    timings: { inputGateMs: 0, generationMs: 0, outputGateMs: 0, totalMs: 0 },
    models: { gate: gateId, generation: genId },
    error: null,
  };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineError('deadline'));
    }, pol.deadlineMs);
  });

  const core = async (): Promise<PipelineResult> => {
    // ---- Stage 1: input gate --------------------------------------------
    const tA = Date.now();
    const gate = await inputGate(input.utterance, {
      call: gateCall,
      compiled,
      model: gateId,
      signal: controller.signal,
    });
    audit.timings.inputGateMs = Date.now() - tA;
    audit.inputVerdict = gate.verdict as InputVerdict;
    audit.inputReason = gate.reason as InputReason;
    audit.inputRaw = gate.raw;
    audit.containsPII = gate.containsPII;

    if (gate.verdict === 'NOISE') {
      return cannedResult('DIDNT_CATCH', 'none', audit, seed);
    }
    if (gate.verdict === 'DISTRESS') {
      return cannedResult('DISTRESS', 'distress', audit, seed);
    }
    if (gate.verdict !== 'OK') {
      return cannedResult('REDIRECT', 'redirected', audit, seed);
    }

    // Cleared for generation: let the caller start a filler. Swallow anything
    // it throws — a cosmetic filler must never break the response path.
    try {
      deps.onInputGateOk?.();
    } catch {
      /* ignore */
    }

    // ---- Stage 2: generation --------------------------------------------
    const tB = Date.now();
    let draft: string;
    try {
      draft = await generate(
        {
          utterance: input.utterance,
          history: input.history,
          memoryLines: input.memoryLines,
          continuation: input.continuation,
        },
        {
          call: genCall,
          policy: pol,
          model: genId,
          signal: controller.signal,
        },
      );
    } catch (err) {
      audit.timings.generationMs = Date.now() - tB;
      if (err instanceof DeadlineError || controller.signal.aborted) throw err;
      audit.error = err instanceof Error ? err.message : null;
      return cannedResult('TIMEOUT', 'error', audit, seed);
    }
    audit.timings.generationMs = Date.now() - tB;
    audit.generationText = draft;

    // ---- Stage 3: output gate -------------------------------------------
    const tC = Date.now();
    const verdict = await outputGate(draft, {
      call: gateCall,
      model: gateId,
      signal: controller.signal,
    });
    audit.timings.outputGateMs = Date.now() - tC;
    audit.outputVerdict = verdict.verdict;
    audit.outputRaw = verdict.raw;

    if (verdict.verdict !== 'PASS') {
      return cannedResult('REDIRECT', 'gate_fail', audit, seed);
    }

    const { head: approvedSpeech, rest } = truncateAtSentence(
      draft,
      pol.maxSpeechChars,
    );
    return {
      speech: approvedSpeech,
      cannedId: null,
      keepListening: true,
      continuation: rest === '' ? null : rest,
      audit: { ...audit, flag: 'none' },
    };
  };

  try {
    const running = core();
    // Whichever branch loses the race must not surface as an unhandled
    // rejection; both losing outcomes are already accounted for.
    running.catch(() => undefined);
    deadline.catch(() => undefined);
    const out = await Promise.race([running, deadline]);
    out.audit.timings.totalMs = Date.now() - started;
    return out;
  } catch (err) {
    audit.error = err instanceof Error ? err.message : null;
    audit.timings.totalMs = Date.now() - started;
    return cannedResult('TIMEOUT', 'error', audit, seed);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}

export { inputGate } from './inputGate.js';
export { generate } from './generate.js';
export { outputGate } from './outputGate.js';
