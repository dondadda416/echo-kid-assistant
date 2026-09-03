/**
 * Logging watchdog (task T8).
 *
 * WHY THIS EXISTS. On launch day the assistant answered a child's questions
 * for several hours while `exchanges` recorded nothing, and nothing told
 * anyone. The parent transcript is the entire oversight mechanism of this
 * system. An oversight mechanism that can silently stop overseeing is worse
 * than one that fails loudly, because it looks like it is working. This module
 * is the "fails loudly" half.
 *
 * WHAT IT DOES. `recordLogFailure` is called from the catch block in
 * `safeLog` (src/alexa/handlers.ts) and counts consecutive write failures. It
 * alerts on the 1st failure and every 25th after (1, 26, 51, …) so that a
 * database that is down for an hour produces a handful of emails rather than
 * one per turn. `recordLogSuccess` resets the counter, so a recovered database
 * re-arms the alert and the next outage is announced again from failure #1.
 *
 * SERVERLESS CAVEAT — READ BEFORE TRUSTING A NUMBER FROM HERE.
 * The counter is module-level state in one Node process. On Vercel that means
 * ONE WARM SERVERLESS INSTANCE. It resets on every cold start, and concurrent
 * instances each keep their own count. Consequences:
 *
 *   - `consecutiveFailures` UNDER-REPORTS the real outage. Three instances
 *     each at 4 failures is 12 lost turns, reported as 4.
 *   - It can also OVER-ALERT: each cold instance alerts on its own failure #1,
 *     so a broken DATABASE_URL under load sends one email per instance, not
 *     one email.
 *   - A quiet period followed by a cold start looks identical to a recovery:
 *     `lastSuccessAt` is null on a fresh instance whether or not writes have
 *     been succeeding elsewhere. Null means "this instance has not written
 *     one", never "logging is broken".
 *
 * That is acceptable because it is not the system of record. The durable
 * backstop is the daily cron in scripts/watchdog-check.ts, which asks the
 * database itself — across every instance and every cold start — whether
 * sessions with turns are missing their exchanges. This module's job is
 * speed (an alert within seconds of the first failed write); the cron's job
 * is certainty. Neither replaces the other.
 *
 * NEVER THROWS, NEVER AWAITS. Every function here is safe to call from the
 * request path; `sendAlert` is fired and forgotten.
 *
 * PRIVACY. Nothing in an alert built here is derived from the child's
 * utterance or from generated text — session id, counts, timestamps and the
 * error message only (SPEC §2.4, PHASE-2 rule 4).
 */

import { sendAlert } from './alert.js';

/** Alert on failure 1, then every 25th: 1, 26, 51, 76, … */
const ALERT_EVERY = 25;

/**
 * The shape T11's parent page renders as its "Logging health" line.
 * KEEP THIS STABLE — another task depends on it.
 */
export interface LoggingHealth {
  /** Consecutive failed writes on THIS instance. See the caveat above. */
  consecutiveFailures: number;
  /** When this instance last wrote an exchange successfully; null if never. */
  lastSuccessAt: Date | null;
  /** When this instance last failed to write; null if never. */
  lastFailureAt: Date | null;
  /** Message of the most recent failure; null if there has not been one. */
  lastError: string | null;
}

let consecutiveFailures = 0;
let lastSuccessAt: Date | null = null;
let lastFailureAt: Date | null = null;
let lastError: string | null = null;

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** True on the 1st failure and every ALERT_EVERY-th one after it. */
function shouldAlert(count: number): boolean {
  return count === 1 || (count - 1) % ALERT_EVERY === 0;
}

/**
 * Record one failed exchange write. Called from `safeLog`'s catch block.
 * Fire-and-forget: it starts an alert but never waits for it, and never throws.
 */
export function recordLogFailure(err: unknown, ctx: { sessionId: string }): void {
  try {
    consecutiveFailures += 1;
    lastFailureAt = new Date();
    lastError = message(err);

    if (!shouldAlert(consecutiveFailures)) return;

    const n = consecutiveFailures;
    const subject = `Helper: exchange logging is failing (${n} in a row)`;
    // Session id, counts, timestamps, error text. No utterance, no reply.
    const body = [
      'The parent transcript is not recording.',
      '',
      `consecutive failures (this instance): ${n}`,
      `session id: ${ctx.sessionId}`,
      `at: ${lastFailureAt.toISOString()}`,
      `last success (this instance): ${lastSuccessAt?.toISOString() ?? 'none'}`,
      `error: ${lastError}`,
      '',
      'The assistant is still answering; the transcript is not being written.',
      'Counts are per serverless instance and under-report a real outage.',
      'Check DATABASE_URL, then confirm new rows appear on the parent page.',
    ].join('\n');

    void sendAlert(subject, body).catch(() => {
      /* sendAlert already falls back to stderr; nothing left to do. */
    });
  } catch {
    /* The watchdog must never be the reason a turn fails. */
  }
}

/**
 * Record one successful exchange write. Resets the counter so that a recovered
 * database re-arms the alert.
 */
export function recordLogSuccess(): void {
  consecutiveFailures = 0;
  lastSuccessAt = new Date();
}

/** Current health of exchange writing, for T11's parent-page health line. */
export function getLoggingHealth(): LoggingHealth {
  return {
    consecutiveFailures,
    lastSuccessAt,
    lastFailureAt,
    lastError,
  };
}

/** Test seam: forget everything this process has seen. */
export function resetLoggingHealth(): void {
  consecutiveFailures = 0;
  lastSuccessAt = null;
  lastFailureAt = null;
  lastError = null;
}
