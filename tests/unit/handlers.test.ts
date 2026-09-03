import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HandlerInput } from 'ask-sdk-core';
import type { Response } from 'ask-sdk-model';

import { createHandlers } from '../../src/alexa/handlers.js';
import type { HandlerDeps, SessionAttrs } from '../../src/alexa/handlers.js';
import { allCanned } from '../../src/pipeline/canned.js';
import { escapeSsml, sanitizeForSpeech } from '../../src/alexa/ssml.js';
import type {
  ConversationTurn,
  ExchangeRow,
  PipelineResult,
  Policy,
  SessionRow,
  Store,
  TurnAudit,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POLICY: Policy = {
  personaName: 'Helper',
  invocationName: 'my helper',
  sessionCapMinutes: 10,
  turnCap: 40,
  historyTurns: 12,
  maxSpeechChars: 600,
  deadlineMs: 7000,
  generation: { maxTokens: 350, storyMaxTokens: 500, temperature: 0.7 },
  blocklist: [],
  distressPatterns: [],
  injectionPatterns: [],
  piiPatterns: [],
};

function audit(overrides: Partial<TurnAudit> = {}): TurnAudit {
  return {
    inputVerdict: 'OK',
    inputReason: 'clean',
    inputRaw: null,
    generationText: null,
    outputVerdict: 'PASS',
    outputRaw: 'PASS',
    flag: 'none',
    containsPII: false,
    timings: { inputGateMs: 1, generationMs: 1, outputGateMs: 1, totalMs: 3 },
    models: { gate: 'gate-model', generation: 'gen-model' },
    error: null,
    ...overrides,
  };
}

function result(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    speech: 'Saturn has beautiful rings made of ice and rock.',
    cannedId: null,
    keepListening: true,
    continuation: null,
    audit: audit(),
    ...overrides,
  };
}

class FakeStore implements Store {
  startSessionCalls: string[] = [];
  endSessionCalls: Array<{ sessionId: string; capHit: boolean }> = [];
  bumpTurnCalls: string[] = [];
  logged: ExchangeRow[] = [];
  history: ConversationTurn[] = [];
  memory: string[] = [];

  async loadSession(): Promise<SessionRow | null> {
    return null;
  }
  async startSession(sessionId: string, userId: string): Promise<SessionRow> {
    this.startSessionCalls.push(sessionId);
    return {
      sessionId,
      userId,
      startedAt: new Date(),
      endedAt: null,
      turnCount: 0,
      capHit: false,
    };
  }
  async bumpTurn(sessionId: string): Promise<void> {
    this.bumpTurnCalls.push(sessionId);
  }
  async endSession(sessionId: string, capHit: boolean): Promise<void> {
    this.endSessionCalls.push({ sessionId, capHit });
  }
  async loadHistory(): Promise<ConversationTurn[]> {
    return this.history;
  }
  async loadMemory(): Promise<string[]> {
    return this.memory;
  }
  async replaceMemory(): Promise<void> {}
  async deleteMemoryLine(): Promise<void> {}
  async logExchange(row: ExchangeRow): Promise<void> {
    this.logged.push(row);
  }
}

interface Harness {
  store: FakeStore;
  runPipeline: ReturnType<typeof vi.fn>;
  progressive: ReturnType<typeof vi.fn>;
  attrs: Record<string, unknown>;
  now: number;
  deps: HandlerDeps;
}

function harness(overrides: Partial<HandlerDeps> = {}): Harness {
  const store = new FakeStore();
  const runPipeline = vi.fn(async () => result());
  const progressive = vi.fn(() => undefined);
  const h: Harness = {
    store,
    runPipeline,
    progressive,
    attrs: {},
    now: 1_700_000_000_000,
    deps: {} as HandlerDeps,
  };
  h.deps = {
    store,
    policy: POLICY,
    runPipeline: runPipeline as unknown as HandlerDeps['runPipeline'],
    now: () => h.now,
    progressive,
    ...overrides,
  };
  return h;
}

function makeInput(
  h: Harness,
  request: Record<string, unknown>,
): HandlerInput {
  return {
    requestEnvelope: {
      version: '1.0',
      session: {
        new: false,
        sessionId: 'sess-1',
        application: { applicationId: 'amzn1.ask.skill.TEST' },
        user: { userId: 'user-1' },
      },
      context: {
        System: {
          application: { applicationId: 'amzn1.ask.skill.TEST' },
          user: { userId: 'user-1' },
          apiEndpoint: 'https://api.amazonalexa.com',
          apiAccessToken: 'token',
        },
      },
      request: { requestId: 'req-1', timestamp: '2026-09-03T00:00:00Z', ...request },
    },
    attributesManager: {
      getSessionAttributes: () => h.attrs,
      setSessionAttributes: (a: Record<string, unknown>) => {
        h.attrs = a;
      },
      getPersistentAttributes: async () => ({}),
      setPersistentAttributes: () => undefined,
      savePersistentAttributes: async () => undefined,
      getRequestAttributes: () => ({}),
      setRequestAttributes: () => undefined,
      deletePersistentAttributes: async () => undefined,
    },
    responseBuilder: {} as HandlerInput['responseBuilder'],
  } as unknown as HandlerInput;
}

function intent(name: string, slots?: Record<string, { name: string; value: string }>) {
  return {
    type: 'IntentRequest',
    intent: { name, ...(slots ? { slots } : {}) },
  };
}

function utteranceSlot(value: string) {
  return { utterance: { name: 'utterance', value } };
}

/** Pull the plain text back out of an SSML response for assertions. */
function spokenText(r: Response): string {
  const os = r.outputSpeech as { ssml?: string } | undefined;
  return (os?.ssml ?? '').replace(/^<speak>/, '').replace(/<\/speak>$/, '');
}

function repromptText(r: Response): string {
  const os = r.reprompt?.outputSpeech as { ssml?: string } | undefined;
  return (os?.ssml ?? '').replace(/^<speak>/, '').replace(/<\/speak>$/, '');
}

function attrsOf(h: Harness): SessionAttrs {
  return h.attrs as unknown as SessionAttrs;
}

/** Find the single handler that claims a request. */
async function dispatch(h: Harness, request: Record<string, unknown>) {
  const { requestHandlers } = createHandlers(h.deps);
  const input = makeInput(h, request);
  const matches = [];
  for (const handler of requestHandlers) {
    if (await handler.canHandle(input)) matches.push(handler);
  }
  expect(matches.length).toBe(1);
  const handler = matches[0]!;
  return { response: (await handler.handle(input)) as Response, input };
}

const CANNED_SETS = {
  GREETING: allCanned('GREETING'),
  DIDNT_CATCH: allCanned('DIDNT_CATCH'),
  HELP: allCanned('HELP'),
  GOODBYE: allCanned('GOODBYE'),
  WRAP_UP: allCanned('WRAP_UP'),
  TIMEOUT: allCanned('TIMEOUT'),
  REPROMPT: allCanned('REPROMPT'),
} as const;

/** Compare against the canned variants as they appear once escaped for SSML. */
function expectCanned(text: string, id: keyof typeof CANNED_SETS): void {
  const escaped = CANNED_SETS[id].map((s) => escapeSsml(sanitizeForSpeech(s)));
  expect(escaped).toContain(text);
}

// ---------------------------------------------------------------------------

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('routing', () => {
  it('LaunchRequest greets, keeps the mic open and starts the session', async () => {
    const { response } = await dispatch(h, { type: 'LaunchRequest' });
    expectCanned(spokenText(response), 'GREETING');
    expect(response.shouldEndSession).toBe(false);
    expect(h.store.startSessionCalls).toEqual(['sess-1']);
    expect(attrsOf(h).startedAt).toBe(h.now);
    expect(attrsOf(h).turns).toBe(0);
  });

  it('ChatIntent runs the pipeline and speaks the approved text', async () => {
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    const { response } = await dispatch(
      h,
      intent('ChatIntent', utteranceSlot('why does Saturn have rings')),
    );
    expect(h.runPipeline).toHaveBeenCalledTimes(1);
    expect(spokenText(response)).toContain('Saturn has beautiful rings');
    expect(response.shouldEndSession).toBe(false);
    expect(h.store.bumpTurnCalls).toEqual(['sess-1']);
    expect(h.store.logged).toHaveLength(1);
    expect(h.store.logged[0]?.utterance).toBe('why does Saturn have rings');
  });

  it('ChatIntent passes the utterance, history and memory to the pipeline', async () => {
    h.store.history = [{ role: 'user', content: 'hi' }];
    h.store.memory = ['likes stories about horses'];
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    await dispatch(h, intent('ChatIntent', utteranceSlot('tell me about horses')));
    const arg = h.runPipeline.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['utterance']).toBe('tell me about horses');
    expect(arg['history']).toEqual([{ role: 'user', content: 'hi' }]);
    expect(arg['memoryLines']).toEqual(['likes stories about horses']);
    expect(arg['sessionId']).toBe('sess-1');
    expect(arg['userId']).toBe('user-1');
  });

  it('ContinueIntent reuses the stored continuation context', async () => {
    h.attrs = {
      startedAt: h.now,
      turns: 1,
      history: [],
      continuation: 'and then the lighthouse keeper found a map.',
      lastApprovedSpeech: 'Once upon a time.',
    };
    await dispatch(h, intent('ContinueIntent'));
    const arg = h.runPipeline.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['continuation']).toBe('and then the lighthouse keeper found a map.');
  });

  it('FallbackIntent says DIDNT_CATCH without touching the pipeline or turn count', async () => {
    h.attrs = { startedAt: h.now, turns: 3, history: [] };
    const { response } = await dispatch(h, intent('AMAZON.FallbackIntent'));
    expectCanned(spokenText(response), 'DIDNT_CATCH');
    expect(response.shouldEndSession).toBe(false);
    expect(h.runPipeline).not.toHaveBeenCalled();
    expect(h.store.bumpTurnCalls).toEqual([]);
    // Turn counter untouched.
    expect((h.attrs as { turns?: number }).turns).toBe(3);
  });

  it('HelpIntent says HELP with the mic open', async () => {
    const { response } = await dispatch(h, intent('AMAZON.HelpIntent'));
    expectCanned(spokenText(response), 'HELP');
    expect(response.shouldEndSession).toBe(false);
  });

  for (const name of [
    'AMAZON.StopIntent',
    'AMAZON.CancelIntent',
    'AMAZON.NavigateHomeIntent',
  ]) {
    it(`${name} says GOODBYE, ends the session and closes it in the store`, async () => {
      const { response } = await dispatch(h, intent(name));
      expectCanned(spokenText(response), 'GOODBYE');
      expect(response.shouldEndSession).toBe(true);
      expect(response.reprompt).toBeUndefined();
      expect(h.store.endSessionCalls).toEqual([
        { sessionId: 'sess-1', capHit: false },
      ]);
    });
  }

  it('SessionEndedRequest ends the session and speaks nothing', async () => {
    const { response } = await dispatch(h, { type: 'SessionEndedRequest' });
    expect(response.outputSpeech).toBeUndefined();
    expect(response.reprompt).toBeUndefined();
    expect(response.shouldEndSession).toBe(true);
    expect(h.store.endSessionCalls).toEqual([
      { sessionId: 'sess-1', capHit: false },
    ]);
  });

  it('an unknown intent matches no handler', async () => {
    const { requestHandlers } = createHandlers(h.deps);
    const input = makeInput(h, intent('SomeOtherIntent'));
    for (const handler of requestHandlers) {
      expect(await handler.canHandle(input)).toBe(false);
    }
  });
});

describe('every non-final response is open with a reprompt', () => {
  const openCases: Array<[string, Record<string, unknown>]> = [
    ['LaunchRequest', { type: 'LaunchRequest' }],
    ['ChatIntent', intent('ChatIntent', utteranceSlot('why is the sky blue'))],
    ['ContinueIntent', intent('ContinueIntent')],
    ['FallbackIntent', intent('AMAZON.FallbackIntent')],
    ['HelpIntent', intent('AMAZON.HelpIntent')],
    ['RepeatIntent', intent('AMAZON.RepeatIntent')],
  ];

  for (const [label, request] of openCases) {
    it(`${label} sets shouldEndSession=false and includes a reprompt`, async () => {
      h = harness();
      h.attrs = { startedAt: h.now, turns: 0, history: [] };
      const { response } = await dispatch(h, request);
      expect(response.shouldEndSession).toBe(false);
      const reprompt = repromptText(response);
      expect(reprompt.length).toBeGreaterThan(0);
      expectCanned(reprompt, 'REPROMPT');
    });
  }
});

describe('session cap (§6)', () => {
  it('returns WRAP_UP and ends the session past sessionCapMinutes', async () => {
    h.attrs = {
      startedAt: h.now - 11 * 60_000,
      turns: 4,
      history: [],
    };
    const { response } = await dispatch(
      h,
      intent('ChatIntent', utteranceSlot('one more question')),
    );
    expectCanned(spokenText(response), 'WRAP_UP');
    expect(response.shouldEndSession).toBe(true);
    expect(h.runPipeline).not.toHaveBeenCalled();
    expect(h.store.endSessionCalls).toEqual([{ sessionId: 'sess-1', capHit: true }]);
    expect(h.store.logged[0]?.cannedId).toBe('WRAP_UP');
  });

  it('returns WRAP_UP at the turn cap', async () => {
    h.attrs = { startedAt: h.now, turns: POLICY.turnCap, history: [] };
    const { response } = await dispatch(
      h,
      intent('ChatIntent', utteranceSlot('another one')),
    );
    expectCanned(spokenText(response), 'WRAP_UP');
    expect(response.shouldEndSession).toBe(true);
    expect(h.runPipeline).not.toHaveBeenCalled();
  });

  it('does not fire just under the cap', async () => {
    h.attrs = {
      startedAt: h.now - 9 * 60_000,
      turns: POLICY.turnCap - 1,
      history: [],
    };
    const { response } = await dispatch(
      h,
      intent('ChatIntent', utteranceSlot('why do leaves change colour')),
    );
    expect(response.shouldEndSession).toBe(false);
    expect(h.runPipeline).toHaveBeenCalledTimes(1);
  });

  it('counts chat turns toward the cap', async () => {
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    await dispatch(h, intent('ChatIntent', utteranceSlot('a')));
    expect(attrsOf(h).turns).toBe(1);
    await dispatch(h, intent('ChatIntent', utteranceSlot('b')));
    expect(attrsOf(h).turns).toBe(2);
  });
});

describe('session attributes hold approved text only', () => {
  it('stores the spoken text, never the rejected generation', async () => {
    h.runPipeline.mockResolvedValue(
      result({
        speech: 'That is a great question for Mom or Dad.',
        cannedId: 'REDIRECT',
        audit: audit({
          outputVerdict: 'FAIL',
          flag: 'gate_fail',
          generationText: 'REJECTED UNSAFE TEXT THAT MUST NEVER BE STORED',
        }),
      }),
    );
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    await dispatch(h, intent('ChatIntent', utteranceSlot('something risky')));
    const serialised = JSON.stringify(h.attrs);
    expect(serialised).not.toContain('REJECTED UNSAFE TEXT');
    expect(attrsOf(h).lastApprovedSpeech).toBe(
      'That is a great question for Mom or Dad.',
    );
    // The rejected draft still reaches the parent log.
    expect(h.store.logged[0]?.audit.generationText).toContain('REJECTED UNSAFE TEXT');
  });

  it('history contains only the utterance and the approved reply', async () => {
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    await dispatch(h, intent('ChatIntent', utteranceSlot('why is snow white')));
    expect(attrsOf(h).history).toEqual([
      { role: 'user', content: 'why is snow white' },
      { role: 'assistant', content: 'Saturn has beautiful rings made of ice and rock.' },
    ]);
  });

  it('trims history to the policy window', async () => {
    const long: ConversationTurn[] = [];
    for (let i = 0; i < 40; i++) {
      long.push({ role: 'user', content: `u${i}` });
      long.push({ role: 'assistant', content: `a${i}` });
    }
    h.attrs = { startedAt: h.now, turns: 0, history: long };
    await dispatch(h, intent('ChatIntent', utteranceSlot('hi')));
    expect(attrsOf(h).history.length).toBeLessThanOrEqual(POLICY.historyTurns * 2);
  });
});

describe('RepeatIntent', () => {
  it('replays the last approved speech', async () => {
    h.attrs = {
      startedAt: h.now,
      turns: 1,
      history: [],
      lastApprovedSpeech: 'Saturn has beautiful rings made of ice and rock.',
    };
    const { response } = await dispatch(h, intent('AMAZON.RepeatIntent'));
    expect(spokenText(response)).toContain('Saturn has beautiful rings');
    expect(response.shouldEndSession).toBe(false);
  });

  it('falls back to DIDNT_CATCH when nothing approved has been said', async () => {
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    const { response } = await dispatch(h, intent('AMAZON.RepeatIntent'));
    expectCanned(spokenText(response), 'DIDNT_CATCH');
  });

  it('never replays rejected generation text left in session state', async () => {
    // Simulate a hostile / buggy attribute blob.
    h.attrs = {
      startedAt: h.now,
      turns: 1,
      history: [],
      lastApprovedSpeech: null,
      generationText: 'UNSAFE REJECTED DRAFT',
      rejected: 'UNSAFE REJECTED DRAFT',
    };
    const { response } = await dispatch(h, intent('AMAZON.RepeatIntent'));
    expect(spokenText(response)).not.toContain('UNSAFE');
    expectCanned(spokenText(response), 'DIDNT_CATCH');
  });

  it('after a redirect turn, repeat replays the redirect, not the draft', async () => {
    h.runPipeline.mockResolvedValue(
      result({
        speech: "That's a Mom-or-Dad question! What else are you curious about?",
        cannedId: 'REDIRECT',
        audit: audit({ generationText: 'UNSAFE DRAFT', outputVerdict: 'FAIL' }),
      }),
    );
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    await dispatch(h, intent('ChatIntent', utteranceSlot('bad thing')));
    const { response } = await dispatch(h, intent('AMAZON.RepeatIntent'));
    expect(spokenText(response)).toContain('Mom-or-Dad question');
    expect(spokenText(response)).not.toContain('UNSAFE DRAFT');
  });
});

describe('length cap and continuation (§5)', () => {
  it('trims a long answer at a sentence boundary and offers to continue', async () => {
    const long = `${'This is a sentence about dragons. '.repeat(30)}`;
    h.runPipeline.mockResolvedValue(result({ speech: long }));
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    const { response } = await dispatch(
      h,
      intent('ChatIntent', utteranceSlot('tell me a dragon story')),
    );
    const spoken = spokenText(response);
    expect(spoken.length).toBeLessThan(700);
    expect(spoken).toContain('Want me to keep going?');
    expect(attrsOf(h).continuation).not.toBeNull();
    expect(attrsOf(h).continuation!.length).toBeGreaterThan(0);
  });

  it('does not add the offer when the answer fits', async () => {
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    const { response } = await dispatch(h, intent('ChatIntent', utteranceSlot('hi')));
    expect(spokenText(response)).not.toContain('Want me to keep going?');
    expect(attrsOf(h).continuation).toBeNull();
  });
});

describe('failure paths never leak', () => {
  it('a pipeline exception becomes TIMEOUT with the mic open', async () => {
    h.runPipeline.mockRejectedValue(
      new Error('ANTHROPIC_API_KEY missing: secret sk-ant-XYZ'),
    );
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    const { response } = await dispatch(h, intent('ChatIntent', utteranceSlot('hi')));
    const spoken = spokenText(response);
    expectCanned(spoken, 'TIMEOUT');
    expect(spoken).not.toContain('sk-ant');
    expect(spoken).not.toContain('ANTHROPIC');
    expect(response.shouldEndSession).toBe(false);
  });

  it('an empty pipeline result fails closed to TIMEOUT', async () => {
    h.runPipeline.mockResolvedValue(result({ speech: '   ' }));
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    const { response } = await dispatch(h, intent('ChatIntent', utteranceSlot('hi')));
    expectCanned(spokenText(response), 'TIMEOUT');
  });

  it('a store failure does not stop the answer', async () => {
    h.store.logExchange = async () => {
      throw new Error('db down');
    };
    h.store.bumpTurn = async () => {
      throw new Error('db down');
    };
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    const { response } = await dispatch(h, intent('ChatIntent', utteranceSlot('hi')));
    expect(spokenText(response)).toContain('Saturn');
  });

  it('an empty utterance says DIDNT_CATCH without calling the pipeline', async () => {
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    const { response } = await dispatch(h, intent('ChatIntent', utteranceSlot('')));
    expectCanned(spokenText(response), 'DIDNT_CATCH');
    expect(h.runPipeline).not.toHaveBeenCalled();
  });
});

describe('ErrorHandler', () => {
  it('handles everything and speaks only the canned TIMEOUT line', async () => {
    const { errorHandler } = createHandlers(h.deps);
    const input = makeInput(h, intent('ChatIntent'));
    const err = new Error('DATABASE_URL=postgres://user:hunter2@host/db exploded');
    expect(await errorHandler.canHandle(input, err)).toBe(true);
    const response = (await errorHandler.handle(input, err)) as Response;
    const spoken = spokenText(response);
    expectCanned(spoken, 'TIMEOUT');
    expect(spoken).not.toContain('hunter2');
    expect(spoken).not.toContain('postgres');
    expect(spoken).not.toContain('DATABASE_URL');
    expect(spoken).not.toContain('exploded');
    expect(response.shouldEndSession).toBe(false);
    expect(repromptText(response).length).toBeGreaterThan(0);
  });

  it('does not leak a thrown string either', async () => {
    const { errorHandler } = createHandlers(h.deps);
    const input = makeInput(h, intent('ChatIntent'));
    const response = (await errorHandler.handle(
      input,
      new Error('secret-leak-marker'),
    )) as Response;
    expect(spokenText(response)).not.toContain('secret-leak-marker');
  });
});

describe('progressive response', () => {
  it('is only sent when the pipeline reports the input gate returned OK', async () => {
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    // Pipeline that never signals OK (e.g. SENSITIVE).
    h.runPipeline.mockImplementation(async () =>
      result({ speech: 'Ask Mom or Dad.', cannedId: 'REDIRECT' }),
    );
    await dispatch(h, intent('ChatIntent', utteranceSlot('bad thing')));
    expect(h.progressive).not.toHaveBeenCalled();
  });

  it('is sent once when the pipeline signals OK', async () => {
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    h.runPipeline.mockImplementation(
      async (_input: unknown, deps: { onInputGateOk?: () => void }) => {
        deps.onInputGateOk?.();
        deps.onInputGateOk?.();
        return result();
      },
    );
    await dispatch(h, intent('ChatIntent', utteranceSlot('why is the sky blue')));
    expect(h.progressive).toHaveBeenCalledTimes(1);
  });

  it('a throwing progressive sender does not break the turn', async () => {
    h.attrs = { startedAt: h.now, turns: 0, history: [] };
    h.progressive.mockImplementation(() => {
      throw new Error('network down');
    });
    h.runPipeline.mockImplementation(
      async (_input: unknown, deps: { onInputGateOk?: () => void }) => {
        deps.onInputGateOk?.();
        return result();
      },
    );
    const { response } = await dispatch(h, intent('ChatIntent', utteranceSlot('hi')));
    expect(spokenText(response)).toContain('Saturn');
  });
});
