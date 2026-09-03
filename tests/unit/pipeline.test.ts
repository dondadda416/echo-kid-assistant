/**
 * Pipeline orchestration tests — spec §7.5 decision table and §4.1 deadline.
 *
 * Every model call is stubbed. Nothing here touches the network.
 */

import { describe, expect, it } from 'vitest';
import { runPipeline, truncateAtSentence } from '../../src/pipeline/index.ts';
import { buildSystemPrompt } from '../../src/pipeline/generate.ts';
import { allCanned, canned } from '../../src/pipeline/canned.ts';
import { policy as basePolicy } from '../../src/pipeline/policy.ts';
import type { CallModelFn } from '../../src/pipeline/anthropic.ts';
import type { PipelineInput } from '../../src/types.ts';

const SEED = 0;

function input(utterance: string, extra: Partial<PipelineInput> = {}) {
  return {
    utterance,
    userId: 'u1',
    sessionId: 's1',
    history: [],
    memoryLines: [],
    ...extra,
  } satisfies PipelineInput;
}

interface Recorder {
  fn: CallModelFn;
  calls: Array<{ system: string; messages: unknown; maxTokens: number }>;
}

/** A recording stub that returns fixed text. */
function rec(reply: string | (() => Promise<string>)): Recorder {
  const calls: Recorder['calls'] = [];
  const fn: CallModelFn = async (opts) => {
    calls.push({
      system: opts.system,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
    });
    return typeof reply === 'string' ? reply : await reply();
  };
  return { fn, calls };
}

/** A gate stub that answers the input gate and the output gate differently. */
function gates(inputVerdict: string, outputVerdict: string): Recorder {
  const calls: Recorder['calls'] = [];
  const fn: CallModelFn = async (opts) => {
    calls.push({
      system: opts.system,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
    });
    // The input gate asks for up to 10 tokens; the output gate asks for 5.
    return opts.maxTokens === 10 ? inputVerdict : outputVerdict;
  };
  return { fn, calls };
}

const boom: CallModelFn = async () => {
  throw new Error('model down');
};

// ---------------------------------------------------------------------------
// §7.5 decision table
// ---------------------------------------------------------------------------

describe('decision table §7.5', () => {
  it('NOISE (stage A) -> DIDNT_CATCH, flag none, no generation', async () => {
    const gen = rec('should never run');
    const r = await runPipeline(input('um'), {
      gateCall: rec('OK').fn,
      genCall: gen.fn,
      cannedSeed: SEED,
    });
    expect(r.cannedId).toBe('DIDNT_CATCH');
    expect(r.speech).toBe(canned('DIDNT_CATCH', SEED));
    expect(r.audit.flag).toBe('none');
    expect(r.audit.inputVerdict).toBe('NOISE');
    expect(gen.calls.length).toBe(0);
  });

  it('NOISE (classifier) -> DIDNT_CATCH', async () => {
    const gen = rec('nope');
    const r = await runPipeline(input('why is the sky blue'), {
      gateCall: gates('NOISE', 'PASS').fn,
      genCall: gen.fn,
      cannedSeed: SEED,
    });
    expect(r.cannedId).toBe('DIDNT_CATCH');
    expect(r.audit.flag).toBe('none');
    expect(gen.calls.length).toBe(0);
  });

  it('SENSITIVE -> REDIRECT, flag redirected, no generation', async () => {
    const gen = rec('nope');
    const r = await runPipeline(input('why is the sky blue'), {
      gateCall: gates('SENSITIVE', 'PASS').fn,
      genCall: gen.fn,
      cannedSeed: SEED,
    });
    expect(r.cannedId).toBe('REDIRECT');
    expect(allCanned('REDIRECT')).toContain(r.speech);
    expect(r.audit.flag).toBe('redirected');
    expect(gen.calls.length).toBe(0);
  });

  it('DISTRESS -> DISTRESS line, flag distress, no generation', async () => {
    const gen = rec('nope');
    const r = await runPipeline(input("I'm bleeding"), {
      gateCall: rec('OK').fn,
      genCall: gen.fn,
      cannedSeed: SEED,
    });
    expect(r.cannedId).toBe('DISTRESS');
    expect(r.speech).toBe(canned('DISTRESS', SEED));
    expect(r.audit.flag).toBe('distress');
    expect(r.audit.inputReason).toBe('distress_pattern');
    expect(gen.calls.length).toBe(0);
  });

  it('OK + generation error -> TIMEOUT, flag error', async () => {
    const r = await runPipeline(input('why is the sky blue'), {
      gateCall: gates('OK', 'PASS').fn,
      genCall: boom,
      cannedSeed: SEED,
    });
    expect(r.cannedId).toBe('TIMEOUT');
    expect(r.audit.flag).toBe('error');
    expect(r.audit.error).toBe('model down');
    expect(r.audit.outputVerdict).toBeNull();
  });

  it('OK + empty generation -> TIMEOUT, flag error', async () => {
    const r = await runPipeline(input('why is the sky blue'), {
      gateCall: gates('OK', 'PASS').fn,
      genCall: rec('   ').fn,
      cannedSeed: SEED,
    });
    expect(r.cannedId).toBe('TIMEOUT');
    expect(r.audit.flag).toBe('error');
  });

  it('OK + PASS -> the generated text is spoken', async () => {
    const draft = 'The sky looks blue because sunlight scatters in the air.';
    const r = await runPipeline(input('why is the sky blue'), {
      gateCall: gates('OK', 'PASS').fn,
      genCall: rec(draft).fn,
      cannedSeed: SEED,
    });
    expect(r.speech).toBe(draft);
    expect(r.cannedId).toBeNull();
    expect(r.audit.flag).toBe('none');
    expect(r.audit.outputVerdict).toBe('PASS');
    expect(r.audit.generationText).toBe(draft);
    expect(r.continuation).toBeNull();
  });

  const badOutputVerdicts = [
    'FAIL',
    'pass',
    'Pass',
    'PASS.',
    '',
    'PASS - looks fine',
    '{"verdict":"PASS"}',
  ];

  for (const v of badOutputVerdicts) {
    it(`OK + output gate ${JSON.stringify(v)} -> REDIRECT, gate_fail`, async () => {
      const draft = 'Something the gate did not clearly approve.';
      const r = await runPipeline(input('why is the sky blue'), {
        gateCall: gates('OK', v).fn,
        genCall: rec(draft).fn,
        cannedSeed: SEED,
      });
      expect(r.cannedId).toBe('REDIRECT');
      expect(r.audit.flag).toBe('gate_fail');
      expect(r.audit.outputVerdict).toBe('FAIL');
      // The rejected draft is kept for the parent log but never spoken.
      expect(r.audit.generationText).toBe(draft);
      expect(r.speech).not.toContain('Something');
    });
  }

  it('OK + output gate error -> REDIRECT, gate_fail', async () => {
    const gateCall: CallModelFn = async (opts) => {
      if (opts.maxTokens === 10) return 'OK';
      throw new Error('gate down');
    };
    const r = await runPipeline(input('why is the sky blue'), {
      gateCall,
      genCall: rec('A perfectly nice answer.').fn,
      cannedSeed: SEED,
    });
    expect(r.cannedId).toBe('REDIRECT');
    expect(r.audit.flag).toBe('gate_fail');
    expect(r.audit.outputRaw).toBe('gate down');
  });

  it('input classifier garbage -> REDIRECT (fails closed to SENSITIVE)', async () => {
    const gen = rec('nope');
    const r = await runPipeline(input('why is the sky blue'), {
      gateCall: gates('ok', 'PASS').fn,
      genCall: gen.fn,
      cannedSeed: SEED,
    });
    expect(r.cannedId).toBe('REDIRECT');
    expect(r.audit.flag).toBe('redirected');
    expect(r.audit.inputReason).toBe('classifier_error');
    expect(gen.calls.length).toBe(0);
  });

  it('any escaping exception -> TIMEOUT, flag error', async () => {
    // A structurally broken policy makes generate() throw a TypeError from
    // inside the orchestrated body — the last-resort catch must handle it.
    const brokenPolicy = {
      ...basePolicy,
      generation: undefined,
    } as unknown as typeof basePolicy;
    const r = await runPipeline(input('why is the sky blue'), {
      gateCall: gates('OK', 'PASS').fn,
      genCall: rec('hello').fn,
      policy: brokenPolicy,
      cannedSeed: SEED,
    });
    expect(r.cannedId).toBe('TIMEOUT');
    expect(r.audit.flag).toBe('error');
    expect(r.audit.error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------

describe('deadline (§4.1)', () => {
  it('a slow generation model yields TIMEOUT', async () => {
    const slow: CallModelFn = (opts) =>
      new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => resolve('too late'), 5000);
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });

    const fastDeadline = { ...basePolicy, deadlineMs: 40 };
    const started = Date.now();
    const r = await runPipeline(input('why is the sky blue'), {
      gateCall: gates('OK', 'PASS').fn,
      genCall: slow,
      policy: fastDeadline,
      cannedSeed: SEED,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.cannedId).toBe('TIMEOUT');
    expect(r.speech).toBe(canned('TIMEOUT', SEED));
    expect(r.audit.flag).toBe('error');
    expect(r.audit.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('a slow input gate also yields TIMEOUT and never generates', async () => {
    const gen = rec('nope');
    const slowGate: CallModelFn = (opts) =>
      new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => resolve('OK'), 5000);
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
    const r = await runPipeline(input('why is the sky blue'), {
      gateCall: slowGate,
      genCall: gen.fn,
      policy: { ...basePolicy, deadlineMs: 40 },
      cannedSeed: SEED,
    });
    expect(r.cannedId).toBe('TIMEOUT');
    expect(r.audit.flag).toBe('error');
    expect(gen.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prompt hygiene
// ---------------------------------------------------------------------------

describe('prompt hygiene', () => {
  const UTT = 'tell me about zebras and quokkas please';

  it('never puts the utterance in the generation system prompt', async () => {
    const gen = rec('Zebras have stripes.');
    await runPipeline(input(UTT), {
      gateCall: gates('OK', 'PASS').fn,
      genCall: gen.fn,
      cannedSeed: SEED,
    });
    expect(gen.calls.length).toBe(1);
    const sys = gen.calls[0]!.system;
    expect(sys).not.toContain(UTT);
    expect(sys).not.toContain('zebras');
    expect(sys).not.toContain('quokkas');
  });

  it('sends the utterance as the final user message', async () => {
    const gen = rec('Zebras have stripes.');
    await runPipeline(
      input(UTT, {
        history: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'Hello!' },
        ],
      }),
      {
        gateCall: gates('OK', 'PASS').fn,
        genCall: gen.fn,
        cannedSeed: SEED,
      },
    );
    const msgs = gen.calls[0]!.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(msgs.length).toBe(3);
    expect(msgs[2]).toEqual({ role: 'user', content: UTT });
  });

  it('the output gate never sees the conversation', async () => {
    const draft = 'Zebras have stripes.';
    const g = gates('OK', 'PASS');
    await runPipeline(
      input(UTT, { history: [{ role: 'user', content: 'secret history' }] }),
      { gateCall: g.fn, genCall: rec(draft).fn, cannedSeed: SEED },
    );
    const outputCall = g.calls.find((c) => c.maxTokens === 5)!;
    expect(outputCall.system).toContain(draft);
    expect(outputCall.system).not.toContain('secret history');
    expect(outputCall.system).not.toContain(UTT);
  });

  it('buildSystemPrompt fills placeholders and leaves none behind', () => {
    const sys = buildSystemPrompt('Helper', ['likes horses']);
    expect(sys).toContain('Helper');
    expect(sys).toContain('likes horses');
    expect(sys).not.toContain('{{');
  });

  it('uses storyMaxTokens when a continuation context is present', async () => {
    const gen = rec('And then the dragon flew home.');
    await runPipeline(input('keep going', { continuation: 'the dragon flew' }), {
      gateCall: gates('OK', 'PASS').fn,
      genCall: gen.fn,
      cannedSeed: SEED,
    });
    expect(gen.calls[0]!.maxTokens).toBe(basePolicy.generation.storyMaxTokens);
  });

  it('uses maxTokens without a continuation context', async () => {
    const gen = rec('Zebras have stripes.');
    await runPipeline(input('why do zebras have stripes'), {
      gateCall: gates('OK', 'PASS').fn,
      genCall: gen.fn,
      cannedSeed: SEED,
    });
    expect(gen.calls[0]!.maxTokens).toBe(basePolicy.generation.maxTokens);
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe('speech truncation', () => {
  it('leaves short text alone', () => {
    expect(truncateAtSentence('Hello there.', 600)).toEqual({
      head: 'Hello there.',
      rest: '',
    });
  });

  it('cuts at a sentence boundary under the cap', () => {
    const text = 'One two three. Four five six. Seven eight nine.';
    const { head, rest } = truncateAtSentence(text, 30);
    expect(head).toBe('One two three. Four five six.');
    expect(rest).toBe('Seven eight nine.');
    expect(head.length).toBeLessThanOrEqual(30);
  });

  it('falls back to a word boundary when there is no sentence end', () => {
    const text = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj';
    const { head, rest } = truncateAtSentence(text, 20);
    expect(head.length).toBeLessThanOrEqual(20);
    expect(head.endsWith(' ')).toBe(false);
    expect(`${head} ${rest}`).toBe(text);
  });

  it('sets continuation on an over-long approved reply', async () => {
    const sentence = 'The dragon flew over the quiet green valley again. ';
    const draft = sentence.repeat(20).trim();
    expect(draft.length).toBeGreaterThan(basePolicy.maxSpeechChars);
    const r = await runPipeline(input('tell me a dragon story'), {
      gateCall: gates('OK', 'PASS').fn,
      genCall: rec(draft).fn,
      cannedSeed: SEED,
    });
    expect(r.cannedId).toBeNull();
    expect(r.speech.length).toBeLessThanOrEqual(basePolicy.maxSpeechChars);
    expect(r.continuation).not.toBeNull();
    expect(`${r.speech} ${r.continuation}`).toBe(draft);
  });
});

// ---------------------------------------------------------------------------
// Audit completeness
// ---------------------------------------------------------------------------

describe('audit', () => {
  it('is fully populated on the happy path', async () => {
    const r = await runPipeline(input('my name is Ellie, why is the sky blue'), {
      gateCall: gates('OK', 'PASS').fn,
      genCall: rec('Sunlight scatters.').fn,
      gateModelId: 'gate-x',
      genModelId: 'gen-x',
      cannedSeed: SEED,
    });
    expect(r.audit.inputVerdict).toBe('OK');
    expect(r.audit.inputReason).toBe('classifier');
    expect(r.audit.inputRaw).toBe('OK');
    expect(r.audit.outputVerdict).toBe('PASS');
    expect(r.audit.outputRaw).toBe('PASS');
    expect(r.audit.containsPII).toBe(true);
    expect(r.audit.models).toEqual({ gate: 'gate-x', generation: 'gen-x' });
    expect(r.audit.error).toBeNull();
    for (const k of ['inputGateMs', 'generationMs', 'outputGateMs', 'totalMs'] as const) {
      expect(typeof r.audit.timings[k]).toBe('number');
      expect(r.audit.timings[k]).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps the mic open on every branch', async () => {
    const cases: Array<[string, string]> = [
      ['um', 'OK'],
      ['why is the sky blue', 'SENSITIVE'],
      ["I'm scared", 'OK'],
      ['why is the sky blue', 'OK'],
    ];
    for (const [utt, verdict] of cases) {
      const r = await runPipeline(input(utt), {
        gateCall: gates(verdict, 'PASS').fn,
        genCall: rec('Fine.').fn,
        cannedSeed: SEED,
      });
      expect(r.keepListening, utt).toBe(true);
    }
  });
});
