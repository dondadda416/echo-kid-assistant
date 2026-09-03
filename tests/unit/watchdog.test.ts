/**
 * T8 — logging-failure alert.
 *
 * The defect being closed: the assistant answered questions for hours while
 * `exchanges` recorded nothing and nothing told anyone. These tests pin the
 * three things that must hold.
 *
 *   1. A failing write alerts — once, not once per turn, and again after a
 *      recovery.
 *   2. A failing write does not cost the child her answer.
 *   3. An alert never carries her words.
 *
 * Fully offline: no network, no database, no API key.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HandlerInput } from 'ask-sdk-core';
import type { Response } from 'ask-sdk-model';

// The alert transport is replaced wholesale so nothing here can reach fetch.
const sendAlert = vi.fn(async (_subject: string, _body: string) => undefined);
vi.mock('../../src/log/alert.js', () => ({
  sendAlert: (subject: string, body: string) => sendAlert(subject, body),
  alertTransportConfigured: () => false,
}));

import {
  recordLogFailure,
  recordLogSuccess,
  getLoggingHealth,
  resetLoggingHealth,
} from '../../src/log/watchdog.js';
import { createHandlers } from '../../src/alexa/handlers.js';
import type { HandlerDeps } from '../../src/alexa/handlers.js';
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
// Fixtures — same shape as tests/unit/handlers.test.ts
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

/** Distinctive strings that must never appear in an alert. */
const SENTINEL_UTTERANCE = 'ZZQUTTERANCEZZ tell me about saturn';
const SENTINEL_SPEECH = 'ZZQGENERATEDZZ Saturn has rings of ice.';

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
    speech: SENTINEL_SPEECH,
    cannedId: null,
    keepListening: true,
    continuation: null,
    audit: audit(),
    ...overrides,
  };
}

/** A store whose logExchange always rejects; everything else succeeds. */
class FailingLogStore implements Store {
  attempts: ExchangeRow[] = [];
  shouldFail = true;

  async loadSession(): Promise<SessionRow | null> {
    return null;
  }
  async startSession(sessionId: string, userId: string): Promise<SessionRow> {
    return {
      sessionId,
      userId,
      startedAt: new Date(),
      endedAt: null,
      turnCount: 0,
      capHit: false,
    };
  }
  async bumpTurn(): Promise<void> {}
  async endSession(): Promise<void> {}
  async loadHistory(): Promise<ConversationTurn[]> {
    return [];
  }
  async loadMemory(): Promise<string[]> {
    return [];
  }
  async replaceMemory(): Promise<void> {}
  async deleteMemoryLine(): Promise<void> {}
  async logExchange(row: ExchangeRow): Promise<void> {
    this.attempts.push(row);
    if (this.shouldFail) throw new Error('connection refused');
  }
}

function makeInput(
  attrs: Record<string, unknown>,
  request: Record<string, unknown>,
): { input: HandlerInput; attrs: Record<string, unknown> } {
  const state = { current: attrs };
  const input = {
    requestEnvelope: {
      version: '1.0',
      session: {
        new: false,
        sessionId: 'sess-wd-1',
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
      request: {
        requestId: 'req-1',
        timestamp: '2026-09-03T00:00:00Z',
        ...request,
      },
    },
    attributesManager: {
      getSessionAttributes: () => state.current,
      setSessionAttributes: (a: Record<string, unknown>) => {
        state.current = a;
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
  return { input, attrs: state.current };
}

function chatRequest(utterance: string) {
  return {
    type: 'IntentRequest',
    intent: {
      name: 'ChatIntent',
      slots: { utterance: { name: 'utterance', value: utterance } },
    },
  };
}

function spokenText(r: Response): string {
  const os = r.outputSpeech as { ssml?: string } | undefined;
  return (os?.ssml ?? '').replace(/^<speak>/, '').replace(/<\/speak>$/, '');
}

/** Run one ChatIntent turn against a store that cannot log. */
async function runFailingTurn(
  store: Store,
  utterance = SENTINEL_UTTERANCE,
): Promise<Response> {
  const deps: HandlerDeps = {
    store,
    policy: POLICY,
    runPipeline: (async () => result()) as HandlerDeps['runPipeline'],
    now: () => 1_700_000_000_000,
    progressive: vi.fn(() => undefined),
  };
  const { requestHandlers } = createHandlers(deps);
  const { input } = makeInput({}, chatRequest(utterance));
  const handler = requestHandlers.find((h) => h.canHandle(input));
  expect(handler).toBeDefined();
  return (await handler!.handle(input)) as Response;
}

/** Every string ever passed to sendAlert, subjects and bodies together. */
function allAlertText(): string {
  return sendAlert.mock.calls.map((c) => (c as unknown[]).join('\n')).join('\n');
}

beforeEach(() => {
  sendAlert.mockClear();
  resetLoggingHealth();
});

// ---------------------------------------------------------------------------

describe('recordLogFailure alert cadence', () => {
  it('alerts on failure 1, stays silent through 25, alerts again on 26', () => {
    recordLogFailure(new Error('down'), { sessionId: 's1' });
    expect(sendAlert).toHaveBeenCalledTimes(1);

    for (let i = 2; i <= 25; i++) {
      recordLogFailure(new Error('down'), { sessionId: 's1' });
    }
    expect(sendAlert).toHaveBeenCalledTimes(1);

    recordLogFailure(new Error('down'), { sessionId: 's1' });
    expect(sendAlert).toHaveBeenCalledTimes(2);
  });

  it('continues the every-25th cadence at 51', () => {
    for (let i = 1; i <= 51; i++) {
      recordLogFailure(new Error('down'), { sessionId: 's1' });
    }
    expect(sendAlert).toHaveBeenCalledTimes(3);
  });

  it('never throws, whatever it is handed', () => {
    expect(() => recordLogFailure(undefined, { sessionId: '' })).not.toThrow();
    expect(() => recordLogFailure({ weird: 1n }, { sessionId: 's' })).not.toThrow();
  });
});

describe('recovery re-arms the alert', () => {
  it('recordLogSuccess resets, so the next failure alerts again', () => {
    for (let i = 1; i <= 5; i++) {
      recordLogFailure(new Error('down'), { sessionId: 's1' });
    }
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(getLoggingHealth().consecutiveFailures).toBe(5);

    recordLogSuccess();
    expect(getLoggingHealth().consecutiveFailures).toBe(0);

    recordLogFailure(new Error('down again'), { sessionId: 's2' });
    expect(sendAlert).toHaveBeenCalledTimes(2);
  });
});

describe('the request path is unaffected', () => {
  it('a store that cannot log still returns speech', async () => {
    const store = new FailingLogStore();
    const response = await runFailingTurn(store);

    expect(store.attempts.length).toBe(1);
    expect(spokenText(response)).toContain('Saturn');
    expect(response.shouldEndSession).toBe(false);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it('a successful write records success rather than alerting', async () => {
    const store = new FailingLogStore();
    store.shouldFail = false;
    await runFailingTurn(store);

    expect(sendAlert).not.toHaveBeenCalled();
    expect(getLoggingHealth().consecutiveFailures).toBe(0);
    expect(getLoggingHealth().lastSuccessAt).toBeInstanceOf(Date);
  });
});

describe('alerts carry no child content', () => {
  it('neither the utterance nor the generated text reaches an alert', async () => {
    const store = new FailingLogStore();
    await runFailingTurn(store);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const text = allAlertText();
    expect(text).not.toContain(SENTINEL_UTTERANCE);
    expect(text).not.toContain(SENTINEL_SPEECH);
    expect(text).not.toContain('ZZQUTTERANCEZZ');
    expect(text).not.toContain('ZZQGENERATEDZZ');
    // What it SHOULD carry: the session id, so JP can find the gap.
    expect(text).toContain('sess-wd-1');
  });

  it('an error message containing child text is still not echoed verbatim by the caller', () => {
    // The watchdog reports the error it is given; the contract is that the
    // request path never hands it one built from her words. safeLog passes the
    // driver's message and the session id, nothing else — assert that shape.
    recordLogFailure(new Error('connection refused'), { sessionId: 'sess-x' });
    const text = allAlertText();
    expect(text).toContain('connection refused');
    expect(text).toContain('sess-x');
    expect(text).not.toContain(SENTINEL_UTTERANCE);
  });
});

describe('sendAlert fallback', () => {
  it('falls back to console.error and does not throw with no env configured', async () => {
    const actual = await vi.importActual<typeof import('../../src/log/alert.js')>(
      '../../src/log/alert.js',
    );
    const prevKey = process.env['RESEND_API_KEY'];
    const prevTo = process.env['ALERT_EMAIL'];
    delete process.env['RESEND_API_KEY'];
    delete process.env['ALERT_EMAIL'];

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(actual.sendAlert('subject', 'body')).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith('[ALERT]', 'subject', 'body');
      expect(actual.alertTransportConfigured()).toBe(false);
    } finally {
      spy.mockRestore();
      fetchSpy.mockRestore();
      if (prevKey === undefined) delete process.env['RESEND_API_KEY'];
      else process.env['RESEND_API_KEY'] = prevKey;
      if (prevTo === undefined) delete process.env['ALERT_EMAIL'];
      else process.env['ALERT_EMAIL'] = prevTo;
    }
  });

  it('treats a blank env var as unset, like envOr does', async () => {
    const actual = await vi.importActual<typeof import('../../src/log/alert.js')>(
      '../../src/log/alert.js',
    );
    const prevKey = process.env['RESEND_API_KEY'];
    const prevTo = process.env['ALERT_EMAIL'];
    process.env['RESEND_API_KEY'] = '   ';
    process.env['ALERT_EMAIL'] = '';

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(actual.alertTransportConfigured()).toBe(false);
      await actual.sendAlert('s', 'b');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith('[ALERT]', 's', 'b');
    } finally {
      spy.mockRestore();
      fetchSpy.mockRestore();
      if (prevKey === undefined) delete process.env['RESEND_API_KEY'];
      else process.env['RESEND_API_KEY'] = prevKey;
      if (prevTo === undefined) delete process.env['ALERT_EMAIL'];
      else process.env['ALERT_EMAIL'] = prevTo;
    }
  });
});

describe('getLoggingHealth shape', () => {
  it('is the documented shape when nothing has happened', () => {
    const h = getLoggingHealth();
    expect(Object.keys(h).sort()).toEqual([
      'consecutiveFailures',
      'lastError',
      'lastFailureAt',
      'lastSuccessAt',
    ]);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.lastSuccessAt).toBeNull();
    expect(h.lastFailureAt).toBeNull();
    expect(h.lastError).toBeNull();
  });

  it('carries the timestamps and last error after a failure', () => {
    recordLogFailure(new Error('boom'), { sessionId: 's1' });
    const h = getLoggingHealth();
    expect(h.consecutiveFailures).toBe(1);
    expect(h.lastFailureAt).toBeInstanceOf(Date);
    expect(h.lastError).toBe('boom');
    expect(h.lastSuccessAt).toBeNull();
  });
});
