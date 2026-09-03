/**
 * Session history and the 10-minute cap (spec §6).
 *
 * The only assistant text this module will ever hand back is text that was
 * actually spoken — i.e. already approved by the output gate or a canned line.
 * Rejected generations live in the log, never in history.
 */

import type { ConversationTurn, Policy, SessionRow, Store } from '../types.ts';

/** How a session may end. */
export type CapReason = 'none' | 'minutes' | 'turns';

export interface CapState {
  /** True when the next turn must return WRAP_UP and end the session. */
  capHit: boolean;
  reason: CapReason;
  elapsedMinutes: number;
  turnCount: number;
}

/**
 * Load the last `limit` approved turns for a session, oldest first.
 *
 * Never throws: a storage error yields an empty history so the turn can still
 * be answered (fail closed on safety, fail soft on context).
 */
export async function loadRecentTurns(
  store: Store,
  sessionId: string,
  limit: number,
): Promise<ConversationTurn[]> {
  try {
    const turns = await store.loadHistory(sessionId, Math.max(0, limit));
    return sanitizeHistory(turns, limit);
  } catch (err) {
    console.error('loadRecentTurns: falling back to empty history', err);
    return [];
  }
}

/**
 * Drop anything empty or malformed and trim to the last `limit` exchanges
 * (one exchange = one user turn + one assistant turn).
 */
export function sanitizeHistory(
  turns: readonly ConversationTurn[],
  limit: number,
): ConversationTurn[] {
  const clean = turns.filter(
    (t) =>
      t &&
      (t.role === 'user' || t.role === 'assistant') &&
      typeof t.content === 'string' &&
      t.content.trim().length > 0,
  );
  const max = Math.max(0, limit) * 2;
  const trimmed = clean.slice(Math.max(0, clean.length - max));
  // History must start with a user turn for the generation call.
  if (trimmed.length > 0 && trimmed[0]!.role === 'assistant') trimmed.shift();
  return trimmed;
}

/** Whole minutes elapsed since the session started. */
export function elapsedMinutes(session: SessionRow, now: Date = new Date()): number {
  const started = session.startedAt?.getTime?.();
  if (typeof started !== 'number' || Number.isNaN(started)) return 0;
  const ms = now.getTime() - started;
  return ms > 0 ? ms / 60_000 : 0;
}

/** Evaluate the session cap for the turn that is about to be handled. */
export function capState(
  session: SessionRow,
  policy: Pick<Policy, 'sessionCapMinutes' | 'turnCap'>,
  now: Date = new Date(),
): CapState {
  const mins = elapsedMinutes(session, now);
  const turns = session.turnCount ?? 0;
  if (mins >= policy.sessionCapMinutes) {
    return { capHit: true, reason: 'minutes', elapsedMinutes: mins, turnCount: turns };
  }
  if (turns >= policy.turnCap) {
    return { capHit: true, reason: 'turns', elapsedMinutes: mins, turnCount: turns };
  }
  return { capHit: false, reason: 'none', elapsedMinutes: mins, turnCount: turns };
}

/**
 * Load (or start) the session row for this turn. Falls back to a synthetic,
 * un-persisted row if storage is unavailable — a database outage must not stop
 * the child from being answered, and the cap still works from that row.
 */
export async function ensureSession(
  store: Store,
  sessionId: string,
  userId: string,
): Promise<SessionRow> {
  try {
    const existing = await store.loadSession(sessionId, userId);
    if (existing) return existing;
    return await store.startSession(sessionId, userId);
  } catch (err) {
    console.error('ensureSession: using ephemeral session', err);
    return {
      sessionId,
      userId,
      startedAt: new Date(),
      endedAt: null,
      turnCount: 0,
      capHit: false,
    };
  }
}

/** Duration of a session in whole minutes, for the parent page. */
export function sessionDurationMinutes(session: SessionRow): number {
  const end = session.endedAt ?? new Date();
  const ms = end.getTime() - session.startedAt.getTime();
  return ms > 0 ? Math.round(ms / 60_000) : 0;
}
