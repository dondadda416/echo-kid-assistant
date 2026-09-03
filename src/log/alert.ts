/**
 * Out-of-band alerting for oversight failures (task T8).
 *
 * One transport, deliberately simple: an HTTP POST to Resend if it is
 * configured, otherwise a distinctive `[ALERT]` line on stderr. No SDK, no new
 * dependency, no retry queue. The thing this alerts about — the parent
 * transcript silently not recording — is rare and durable; a missed alert is
 * caught by the daily cron in scripts/watchdog-check.ts.
 *
 * TWO PROPERTIES THIS FILE MUST NEVER LOSE:
 *
 *   1. It never throws. Every caller is on, or one `void` away from, the
 *      request path. An alert that breaks the turn it is warning about is
 *      worse than no alert.
 *   2. Alert bodies carry NO child utterance and NO generated text — session
 *      ids, counts, timestamps and error messages only. Her words live in the
 *      password-protected parent page and nowhere else (SPEC §2.4, PHASE-2
 *      rule 4). An email inbox and a hosting provider's log viewer are both
 *      "somewhere else". Callers are responsible for what they pass in;
 *      tests/unit/watchdog.test.ts asserts the callers in this repo comply.
 */

/** Hard ceiling on how long an alert may hold anything up. */
const ALERT_TIMEOUT_MS = 3000;

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'onboarding@resend.dev';

/**
 * Read an env var treating blank as absent — the same rule as `envOr` in
 * src/pipeline/anthropic.ts. A dashboard row created with an empty value is
 * unset, not set-to-empty; Phase 1 lost an hour to the other reading.
 */
function env(name: string): string {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

/** True when a real email transport is configured. Exported for the health line. */
export function alertTransportConfigured(): boolean {
  return env('RESEND_API_KEY') !== '' && env('ALERT_EMAIL') !== '';
}

function fallback(subject: string, body: string): void {
  console.error('[ALERT]', subject, body);
}

/**
 * Send one alert. Resolves either way; never rejects.
 *
 * On any transport problem — unset env, non-2xx, network error, the 3s
 * timeout — the alert is written to stderr instead, so the information is
 * never simply dropped.
 */
export async function sendAlert(subject: string, body: string): Promise<void> {
  const key = env('RESEND_API_KEY');
  const to = env('ALERT_EMAIL');
  if (key === '' || to === '') {
    fallback(subject, body);
    return;
  }

  const from = env('ALERT_FROM') || DEFAULT_FROM;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!res.ok) {
      fallback(subject, body);
      console.error('[ALERT] email transport returned', res.status);
    }
  } catch (err) {
    fallback(subject, body);
    console.error(
      '[ALERT] email transport failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
