/**
 * Shared contracts. Every module codes against these.
 * DO NOT change a signature here without updating all consumers.
 *
 * Safety invariant: the only strings that may ever reach the speaker without
 * passing the output gate are the values of CANNED (src/pipeline/canned.ts),
 * addressed by CannedId. Everything else must carry outputGate === 'PASS'.
 */

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** Input gate classification. Anything not exactly one of these fails closed to SENSITIVE. */
export type InputVerdict = 'OK' | 'SENSITIVE' | 'DISTRESS' | 'NOISE';

/** Output gate verdict. Anything not exactly PASS fails closed to FAIL. */
export type OutputVerdict = 'PASS' | 'FAIL';

/** Why an input gate decision was made — for the parent log, not for the child. */
export type InputReason =
  | 'blocklist'
  | 'distress_pattern'
  | 'injection_pattern'
  | 'too_short'
  | 'classifier'
  | 'classifier_error'
  | 'clean';

/** How a turn was resolved, shown in the parent log. */
export type ExchangeFlag =
  | 'none'
  | 'redirected'
  | 'distress'
  | 'gate_fail'
  | 'error';

// ---------------------------------------------------------------------------
// Canned lines — the only unchecked speech
// ---------------------------------------------------------------------------

export type CannedId =
  | 'GREETING'
  | 'REPROMPT'
  | 'DIDNT_CATCH'
  | 'REDIRECT'
  | 'DISTRESS'
  | 'TIMEOUT'
  | 'WRAP_UP'
  | 'GOODBYE'
  | 'HELP'
  /** Progressive-response filler played while the model thinks. */
  | 'FILLER'
  /** Appended when an answer was truncated and can continue next turn. */
  | 'CONTINUE_OFFER';

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineInput {
  /** Raw utterance as Alexa transcribed it. */
  utterance: string;
  /** Opaque Amazon user id. Not PII, safe as a database key. */
  userId: string;
  /** Alexa session id. */
  sessionId: string;
  /** Prior approved turns, oldest first. Never contains rejected text. */
  history: ConversationTurn[];
  /** Long-term memory lines (topics/preferences only, already PII-scrubbed). */
  memoryLines: string[];
  /** Set when the child is continuing a long story. */
  continuation?: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface PipelineResult {
  /** Exactly what should be spoken. Already trimmed; still needs SSML escaping. */
  speech: string;
  /** Set when `speech` came from CANNED rather than the model. */
  cannedId: CannedId | null;
  /** True when the mic should stay open. */
  keepListening: boolean;
  /** Continuation context to store if the answer was truncated. */
  continuation: string | null;
  /** Everything the parent log needs. */
  audit: TurnAudit;
}

export interface TurnAudit {
  inputVerdict: InputVerdict;
  inputReason: InputReason;
  /** Raw classifier output, verbatim, for debugging. */
  inputRaw: string | null;
  /** Model draft, kept even when rejected, so JP can judge the gate. */
  generationText: string | null;
  outputVerdict: OutputVerdict | null;
  /** Raw output-gate response, verbatim. */
  outputRaw: string | null;
  flag: ExchangeFlag;
  /** True when the deterministic PII scan matched; memory extraction is skipped. */
  containsPII: boolean;
  timings: {
    inputGateMs: number;
    generationMs: number;
    outputGateMs: number;
    totalMs: number;
  };
  models: { gate: string; generation: string };
  error: string | null;
}

// ---------------------------------------------------------------------------
// Policy config (config/policy.yaml)
// ---------------------------------------------------------------------------

export interface Policy {
  personaName: string;
  invocationName: string;
  sessionCapMinutes: number;
  turnCap: number;
  historyTurns: number;
  maxSpeechChars: number;
  deadlineMs: number;
  generation: { maxTokens: number; storyMaxTokens: number; temperature: number };
  blocklist: string[];
  distressPatterns: string[];
  injectionPatterns: string[];
  piiPatterns: string[];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface ExchangeRow {
  id?: number;
  sessionId: string;
  userId: string;
  createdAt?: Date;
  utterance: string;
  spoken: string;
  cannedId: CannedId | null;
  audit: TurnAudit;
}

export interface SessionRow {
  sessionId: string;
  userId: string;
  startedAt: Date;
  endedAt: Date | null;
  turnCount: number;
  capHit: boolean;
}

export interface MemoryLine {
  id: number;
  userId: string;
  line: string;
  createdAt: Date;
}

/**
 * Storage contract. api/alexa.ts depends only on this interface, so the
 * pipeline can be unit-tested against an in-memory implementation.
 */
export interface Store {
  loadSession(sessionId: string, userId: string): Promise<SessionRow | null>;
  startSession(sessionId: string, userId: string): Promise<SessionRow>;
  bumpTurn(sessionId: string): Promise<void>;
  endSession(sessionId: string, capHit: boolean): Promise<void>;
  loadHistory(sessionId: string, limit: number): Promise<ConversationTurn[]>;
  loadMemory(userId: string): Promise<string[]>;
  replaceMemory(userId: string, lines: string[]): Promise<void>;
  deleteMemoryLine(userId: string, id: number): Promise<void>;
  logExchange(row: ExchangeRow): Promise<void>;
}
