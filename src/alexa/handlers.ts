/**
 * Alexa request handlers (§5).
 *
 * SAFETY INVARIANT enforced here:
 *   Session attributes, and therefore the history sent back to the model and
 *   anything RepeatIntent can replay, may only ever contain
 *     (a) canned lines from src/pipeline/canned.ts, or
 *     (b) text the output gate returned PASS for (PipelineResult.speech).
 *   Rejected generation text (PipelineResult.audit.generationText) is written
 *   to the parent log and nowhere else. `rememberApproved()` is the only
 *   function that writes speech into session state — keep it that way.
 *
 * Handlers are built by `createHandlers(deps)` so unit tests can inject a fake
 * Store, Policy and pipeline without touching the network or the database.
 */

import type { HandlerInput, RequestHandler, ErrorHandler } from 'ask-sdk-core';
import type { Response } from 'ask-sdk-model';

import { canned } from '../pipeline/canned.js';
import type {
  CannedId,
  ConversationTurn,
  ExchangeRow,
  PipelineInput,
  PipelineResult,
  Policy,
  Store,
  TurnAudit,
} from '../types.js';
import { recordLogFailure, recordLogSuccess } from '../log/watchdog.js';
import { buildSpeech, trimToSentence, CONTINUE_OFFER } from './ssml.js';
import { sendProgressive } from './progressive.js';

/**
 * Filler for the progressive response. Sourced from the canned-lines module so
 * that every string spoken without passing the output gate lives in exactly one
 * reviewed file (src/pipeline/canned.ts). Never model output.
 */
export const PROGRESSIVE_FILLER = canned('FILLER');

/**
 * The pipeline contract (src/pipeline/index.ts).
 *
 * `onInputGateOk` is an OPTIONAL extra hook this module passes in: the
 * progressive-response filler may only be spoken once the input gate has
 * returned OK, and the gate lives inside the pipeline, so the pipeline is the
 * only place that can make that call. A pipeline that ignores the hook is
 * fully compatible — the filler simply never plays. See docs/T2-NOTES.md (A3).
 */
export type RunPipeline = (
  input: PipelineInput,
  deps: { policy: Policy; onInputGateOk?: () => void },
) => Promise<PipelineResult>;

export interface HandlerDeps {
  store: Store;
  policy: Policy;
  runPipeline: RunPipeline;
  /** Injectable clock, so cap tests do not need to wait ten minutes. */
  now?: () => number;
  /** Injectable so tests never touch the network. */
  progressive?: (
    handlerInput: Pick<HandlerInput, 'requestEnvelope'>,
    speech: string,
  ) => unknown;
}

// ---------------------------------------------------------------------------
// Session attributes
// ---------------------------------------------------------------------------

export interface SessionAttrs {
  /** Epoch ms of the LaunchRequest that opened this session. */
  startedAt: number;
  /** Turns that counted toward the cap (ChatIntent / ContinueIntent only). */
  turns: number;
  /** Last APPROVED or canned speech. The only thing RepeatIntent may replay. */
  lastApprovedSpeech: string | null;
  /** Continuation context for ContinueIntent, from an approved answer. */
  continuation: string | null;
  /** Approved conversation history, oldest first. */
  history: ConversationTurn[];
}

function readAttrs(handlerInput: HandlerInput, now: number): SessionAttrs {
  const raw = handlerInput.attributesManager.getSessionAttributes() as Partial<
    Record<keyof SessionAttrs, unknown>
  >;
  const history = Array.isArray(raw['history'])
    ? (raw['history'] as ConversationTurn[]).filter(
        (t): t is ConversationTurn =>
          !!t &&
          typeof t === 'object' &&
          (t.role === 'user' || t.role === 'assistant') &&
          typeof t.content === 'string',
      )
    : [];
  return {
    startedAt: typeof raw['startedAt'] === 'number' ? raw['startedAt'] : now,
    turns: typeof raw['turns'] === 'number' ? raw['turns'] : 0,
    lastApprovedSpeech:
      typeof raw['lastApprovedSpeech'] === 'string' ? raw['lastApprovedSpeech'] : null,
    continuation: typeof raw['continuation'] === 'string' ? raw['continuation'] : null,
    history,
  };
}

function writeAttrs(handlerInput: HandlerInput, attrs: SessionAttrs): void {
  handlerInput.attributesManager.setSessionAttributes({ ...attrs });
}

/**
 * The ONLY writer of speech into session state. Everything passed here must
 * already be canned (§8) or output-gate approved.
 */
function rememberApproved(
  attrs: SessionAttrs,
  policy: Policy,
  opts: {
    utterance?: string;
    speech: string;
    continuation: string | null;
    addToHistory: boolean;
  },
): SessionAttrs {
  const history = [...attrs.history];
  if (opts.addToHistory) {
    if (opts.utterance !== undefined && opts.utterance.length > 0) {
      history.push({ role: 'user', content: opts.utterance });
    }
    history.push({ role: 'assistant', content: opts.speech });
  }
  const maxEntries = Math.max(2, policy.historyTurns * 2);
  return {
    ...attrs,
    lastApprovedSpeech: opts.speech,
    continuation: opts.continuation,
    history: history.slice(-maxEntries),
  };
}

// ---------------------------------------------------------------------------
// Envelope accessors (deliberately defensive — never trust the shape)
// ---------------------------------------------------------------------------

function requestType(handlerInput: HandlerInput): string {
  return handlerInput.requestEnvelope.request?.type ?? '';
}

function intentName(handlerInput: HandlerInput): string {
  const req = handlerInput.requestEnvelope.request as
    | { type?: string; intent?: { name?: string } }
    | undefined;
  if (req?.type !== 'IntentRequest') return '';
  return req.intent?.name ?? '';
}

function slotValue(handlerInput: HandlerInput, name: string): string {
  const req = handlerInput.requestEnvelope.request as
    | { intent?: { slots?: Record<string, { value?: unknown } | undefined> } }
    | undefined;
  const v = req?.intent?.slots?.[name]?.value;
  return typeof v === 'string' ? v.trim() : '';
}

function userId(handlerInput: HandlerInput): string {
  const env = handlerInput.requestEnvelope as unknown as {
    session?: { user?: { userId?: unknown } };
    context?: { System?: { user?: { userId?: unknown } } };
  };
  const a = env.session?.user?.userId;
  if (typeof a === 'string' && a.length > 0) return a;
  const b = env.context?.System?.user?.userId;
  return typeof b === 'string' && b.length > 0 ? b : 'unknown-user';
}

function sessionId(handlerInput: HandlerInput): string {
  const env = handlerInput.requestEnvelope as unknown as {
    session?: { sessionId?: unknown };
  };
  const s = env.session?.sessionId;
  return typeof s === 'string' && s.length > 0 ? s : 'unknown-session';
}

// ---------------------------------------------------------------------------
// Response construction
// ---------------------------------------------------------------------------

function speakResponse(
  speech: string,
  opts: { endSession: boolean; reprompt?: string },
): Response {
  const response: Response = {
    outputSpeech: { type: 'SSML', ssml: buildSpeech(speech) },
    shouldEndSession: opts.endSession,
  };
  if (!opts.endSession) {
    const reprompt = opts.reprompt ?? canned('REPROMPT');
    response.reprompt = {
      outputSpeech: { type: 'SSML', ssml: buildSpeech(reprompt) },
    };
  }
  return response;
}

/** A canned line, mic open. */
function cannedOpen(id: CannedId): Response {
  return speakResponse(canned(id), { endSession: false });
}

/** A canned line, session over. */
function cannedFinal(id: CannedId): Response {
  return speakResponse(canned(id), { endSession: true });
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function cannedAudit(overrides: Partial<TurnAudit> = {}): TurnAudit {
  return {
    inputVerdict: 'NOISE',
    inputReason: 'clean',
    inputRaw: null,
    generationText: null,
    outputVerdict: null,
    outputRaw: null,
    flag: 'none',
    containsPII: false,
    timings: { inputGateMs: 0, generationMs: 0, outputGateMs: 0, totalMs: 0 },
    models: { gate: '', generation: '' },
    error: null,
    ...overrides,
  };
}

async function safeLog(store: Store, row: ExchangeRow): Promise<void> {
  try {
    await store.logExchange(row);
    recordLogSuccess();
  } catch (err) {
    // T8: count the failure and, on the 1st and every 25th after, alert out of
    // band. Fire-and-forget by contract -- never awaited, never throws.
    recordLogFailure(err, { sessionId: row.sessionId });
    // A logging failure must never cost the child her answer -- but it must
    // never be silent either. The parent transcript is the entire oversight
    // mechanism for this system; a log that quietly stops writing looks
    // exactly like a child who stopped talking to it.
    console.error(
      '[exchange-log] WRITE FAILED:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * One line per turn in the platform log, carrying the safety verdicts and
 * timings but NOT the child's words -- those belong in the parent page, behind
 * a password, not in a hosting provider's log viewer.
 */
function traceTurn(audit: TurnAudit, cannedId: CannedId | null): void {
  console.log(
    '[turn]',
    JSON.stringify({
      input: audit.inputVerdict,
      reason: audit.inputReason,
      inputRaw: audit.inputRaw,
      output: audit.outputVerdict,
      outputRaw: audit.outputRaw,
      flag: audit.flag,
      canned: cannedId,
      ms: audit.timings,
      models: audit.models,
      error: audit.error,
    }),
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export interface BuiltHandlers {
  requestHandlers: RequestHandler[];
  errorHandler: ErrorHandler;
}

export function createHandlers(deps: HandlerDeps): BuiltHandlers {
  const { store, policy, runPipeline } = deps;
  const now = deps.now ?? (() => Date.now());
  const progressive = deps.progressive ?? sendProgressive;

  const launchHandler: RequestHandler = {
    canHandle: (h) => requestType(h) === 'LaunchRequest',
    async handle(h) {
      const t = now();
      try {
        await store.startSession(sessionId(h), userId(h));
      } catch {
        // A DB hiccup must not stop her from talking; the turn still logs.
      }
      const greeting = canned('GREETING');
      writeAttrs(
        h,
        rememberApproved(
          {
            startedAt: t,
            turns: 0,
            lastApprovedSpeech: null,
            continuation: null,
            history: [],
          },
          policy,
          { speech: greeting, continuation: null, addToHistory: false },
        ),
      );
      return speakResponse(greeting, { endSession: false });
    },
  };

  /** Shared body of ChatIntent and ContinueIntent. */
  async function runTurn(
    h: HandlerInput,
    utterance: string,
    useContinuation: boolean,
  ): Promise<Response> {
    const t = now();
    const attrs = readAttrs(h, t);
    const sid = sessionId(h);
    const uid = userId(h);

    // --- session cap (§6) ------------------------------------------------
    const elapsedMs = t - attrs.startedAt;
    const capMs = policy.sessionCapMinutes * 60_000;
    const capHit = elapsedMs > capMs || attrs.turns >= policy.turnCap;
    if (capHit) {
      const wrap = canned('WRAP_UP');
      writeAttrs(
        h,
        rememberApproved(attrs, policy, {
          speech: wrap,
          continuation: null,
          addToHistory: false,
        }),
      );
      try {
        await store.endSession(sid, true);
      } catch {
        /* logged below; never blocks the response */
      }
      await safeLog(store, {
        sessionId: sid,
        userId: uid,
        utterance,
        spoken: wrap,
        cannedId: 'WRAP_UP',
        audit: cannedAudit({ inputVerdict: 'OK', inputReason: 'clean' }),
      });
      return speakResponse(wrap, { endSession: true });
    }

    if (utterance.length === 0 && !useContinuation) {
      return cannedOpen('DIDNT_CATCH');
    }

    // --- context ---------------------------------------------------------
    let history: ConversationTurn[] = attrs.history;
    let memoryLines: string[] = [];
    try {
      const stored = await store.loadHistory(sid, policy.historyTurns);
      if (stored.length > 0) history = stored;
    } catch {
      /* session attributes are the fallback */
    }
    try {
      memoryLines = await store.loadMemory(uid);
    } catch {
      memoryLines = [];
    }

    const input: PipelineInput = {
      utterance,
      userId: uid,
      sessionId: sid,
      history,
      memoryLines,
    };
    const continuation = useContinuation ? attrs.continuation : null;
    if (continuation) input.continuation = continuation;

    // The filler may only be spoken once the input gate has returned OK, so
    // the decision is handed to the pipeline. Fire-and-forget either way.
    let fillerSent = false;
    const onInputGateOk = (): void => {
      if (fillerSent) return;
      fillerSent = true;
      try {
        void progressive(h, PROGRESSIVE_FILLER);
      } catch {
        /* never let the filler break the turn */
      }
    };

    let result: PipelineResult;
    try {
      result = await runPipeline(input, { policy, onInputGateOk });
    } catch {
      const timeout = canned('TIMEOUT');
      await safeLog(store, {
        sessionId: sid,
        userId: uid,
        utterance,
        spoken: timeout,
        cannedId: 'TIMEOUT',
        audit: cannedAudit({
          inputVerdict: 'OK',
          inputReason: 'clean',
          flag: 'error',
          error: 'pipeline threw',
        }),
      });
      return speakResponse(timeout, { endSession: false });
    }

    // Fail closed: a result without speech is a broken result.
    if (typeof result.speech !== 'string' || result.speech.trim().length === 0) {
      return speakResponse(canned('TIMEOUT'), { endSession: false });
    }

    // --- length cap + continuation (§5) ----------------------------------
    const trimmed = trimToSentence(result.speech, policy.maxSpeechChars);
    let spoken = trimmed.spoken;
    let nextContinuation = result.continuation;
    if (trimmed.remainder.length > 0) {
      spoken = `${spoken} ${CONTINUE_OFFER}`;
      nextContinuation = trimmed.remainder;
    }

    try {
      await store.bumpTurn(sid);
    } catch {
      /* the in-session turn counter below is the backstop */
    }

    traceTurn(result.audit, result.cannedId);

    await safeLog(store, {
      sessionId: sid,
      userId: uid,
      utterance,
      spoken,
      cannedId: result.cannedId,
      audit: result.audit,
    });

    // Only approved/canned text ever reaches session state.
    writeAttrs(h, {
      ...rememberApproved(attrs, policy, {
        utterance,
        speech: spoken,
        continuation: nextContinuation,
        addToHistory: true,
      }),
      turns: attrs.turns + 1,
    });

    return speakResponse(spoken, { endSession: false });
  }

  const chatHandler: RequestHandler = {
    canHandle: (h) => intentName(h) === 'ChatIntent',
    handle: (h) => runTurn(h, slotValue(h, 'utterance'), false),
  };

  const continueHandler: RequestHandler = {
    canHandle: (h) => intentName(h) === 'ContinueIntent',
    handle: (h) => {
      const spoken = slotValue(h, 'utterance');
      return runTurn(h, spoken.length > 0 ? spoken : 'keep going', true);
    },
  };

  const fallbackHandler: RequestHandler = {
    // Does not count toward the turn cap and never touches the pipeline.
    canHandle: (h) => intentName(h) === 'AMAZON.FallbackIntent',
    handle: () => cannedOpen('DIDNT_CATCH'),
  };

  const repeatHandler: RequestHandler = {
    canHandle: (h) => intentName(h) === 'AMAZON.RepeatIntent',
    handle(h) {
      const attrs = readAttrs(h, now());
      // Only ever replays text that was canned or output-gate approved.
      if (attrs.lastApprovedSpeech && attrs.lastApprovedSpeech.trim().length > 0) {
        return speakResponse(attrs.lastApprovedSpeech, { endSession: false });
      }
      return cannedOpen('DIDNT_CATCH');
    },
  };

  const helpHandler: RequestHandler = {
    canHandle: (h) => intentName(h) === 'AMAZON.HelpIntent',
    handle: () => cannedOpen('HELP'),
  };

  const stopHandler: RequestHandler = {
    canHandle: (h) => {
      const name = intentName(h);
      return (
        name === 'AMAZON.StopIntent' ||
        name === 'AMAZON.CancelIntent' ||
        name === 'AMAZON.NavigateHomeIntent'
      );
    },
    async handle(h) {
      try {
        await store.endSession(sessionId(h), false);
      } catch {
        /* never block the goodbye */
      }
      return cannedFinal('GOODBYE');
    },
  };

  const sessionEndedHandler: RequestHandler = {
    canHandle: (h) => requestType(h) === 'SessionEndedRequest',
    async handle(h) {
      try {
        await store.endSession(sessionId(h), false);
      } catch {
        /* nothing to say either way */
      }
      // No speech at all on SessionEndedRequest.
      return { shouldEndSession: true };
    },
  };

  const errorHandler: ErrorHandler = {
    canHandle: () => true,
    handle() {
      // The exception message is NEVER spoken — canned only (§2 rule 2).
      return cannedOpen('TIMEOUT');
    },
  };

  return {
    requestHandlers: [
      launchHandler,
      chatHandler,
      continueHandler,
      fallbackHandler,
      repeatHandler,
      helpHandler,
      stopHandler,
      sessionEndedHandler,
    ],
    errorHandler,
  };
}
