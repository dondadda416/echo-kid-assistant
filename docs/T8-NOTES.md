# T8 — Logging-failure alert

**Status:** implemented, offline-tested. Not yet exercised against a real
outage (that is the integration acceptance, and it needs J1 first).

---

## The defect

On launch day the assistant answered a child's questions for several hours
while `exchanges` recorded nothing, and nothing told anyone. `DATABASE_URL` in
Vercel held documentation text instead of a connection string; `getStore()`
deferred the error into the query path (deliberately — see the long comment in
`src/memory/db.ts`, a *total outage* would have been worse), `safeLog` caught
it, printed one line to a platform log nobody was reading, and the turn
continued.

Every individual decision there was right. The system they compose is not: the
parent transcript is the entire oversight mechanism of this project, and it
could stop overseeing without saying so. An oversight mechanism that fails
silently is worse than one that fails loudly, because it looks like it is
working. T8 closes that.

## What was built

| File | Role |
|---|---|
| `src/log/alert.ts` | One transport. Resend REST if configured, `console.error('[ALERT]', …)` otherwise. Never throws, never blocks >3s. |
| `src/log/watchdog.ts` | In-process consecutive-failure counter. Alerts on failure 1 and every 25th after. `getLoggingHealth()` for T11. |
| `scripts/watchdog-check.ts` | Daily database-side check. The durable backstop. |
| `.github/workflows/watchdog.yml` | The cron that runs it. |
| `tests/unit/watchdog.test.ts` | 12 tests, fully offline. |

Two hooks into existing files, and nothing else:

1. `src/alexa/handlers.ts` — inside `safeLog` only: `recordLogSuccess()` after
   a successful write, `recordLogFailure(err, { sessionId })` in the existing
   catch block, alongside the `console.error` that was already there. The
   function's signature, structure and every other caller are untouched.
2. `docs/ENV.md` — three optional env-var rows plus a section.

## Two mechanisms, on purpose

**Fast, imprecise:** the in-process counter. Alerts within seconds of the first
failed write, from the instance that failed.

**Slow, certain:** the cron. Asks the database once a day whether sessions with
`turn_count > 0` are missing their `exchanges` rows, across every instance and
every cold start.

Neither replaces the other. The counter cannot see across instances; the cron
cannot tell you this afternoon.

## THE SERVERLESS CAVEAT — where an alert can mislead you

`consecutiveFailures` is module-level state in one Node process. On Vercel that
is one warm serverless instance. Four specific ways a reader can be misled:

1. **The count under-reports the outage.** Three concurrent instances each at 4
   consecutive failures is 12 lost turns, and each alert says 4. Never read
   "consecutive failures: 4" as "4 turns were lost". Read it as "at least 4,
   on one instance". The cron's orphan-session count is the number to trust.

2. **The count resets on a cold start, which reads as a recovery.** It is not
   one. A quiet ten minutes followed by a fresh instance produces a counter of
   0 with no successful write having happened anywhere. Only `recordLogSuccess`
   from an actual write means recovery, and the counter cannot distinguish the
   two after the fact.

3. **`lastSuccessAt: null` does not mean "logging is broken".** It means *this
   instance* has not written one — which is the normal state of a
   just-started instance. T11's health line must render null as "no writes from
   this instance yet", not as a red state. The red state is a `lastSuccessAt`
   older than the last session start, or a non-zero `consecutiveFailures`.

4. **The alert can arrive N times for one outage.** Each cold instance alerts
   on its own failure #1. A broken `DATABASE_URL` under load sends one email
   per instance, not one email. Several identical alerts in a minute is one
   outage, not several.

The cron in `scripts/watchdog-check.ts` is the durable backstop precisely
because it has none of these properties: it queries the database, so it sees
the whole 24 hours across every instance.

## Alert cadence

1, 26, 51, 76 … (`count === 1 || (count - 1) % 25 === 0`). One alert per outage
in the common case; a steady trickle if it stays broken, so a long outage does
not fall out of the inbox. `recordLogSuccess()` resets to 0, so a database that
recovers and breaks again is announced again from failure #1.

## Privacy

Alert bodies carry session ids, counts, timestamps and error messages. No
utterance, no generated text, no `spoken` value. Her words live only in the
password-protected parent page (SPEC §2.4, PHASE-2 rule 4) — an email inbox and
a CI log are both "somewhere else".

`scripts/watchdog-check.ts` never selects `utterance`, `spoken` or
`generation_text`; it selects ids, counts and timestamps. Keep it that way.

`tests/unit/watchdog.test.ts` pushes distinctive sentinel strings
(`ZZQUTTERANCEZZ…`, `ZZQGENERATEDZZ…`) through a turn whose logging fails and
asserts they appear in no alert subject or body.

## Cron time: `40 12 * * *` (12:40 UTC)

Roughly 07:40 US Central / 08:40 Eastern.

- The 24-hour window closes after a full evening of use, so an evening outage
  is caught the next morning rather than a day later.
- The alert lands at the start of JP's day, leaving a whole working day to fix
  `DATABASE_URL` before the device is used again that evening.
- **Off the hour on purpose.** GitHub's scheduler is heavily congested at `:00`
  and delays runs queued there; `:40` is reliably closer to on time.
- Clear of the red-team job's `15 7 * * *`, so the two never contend and a
  watchdog failure is never confused with a red-team failure.

## Why the cron job does not fail the build

A detected outage sends an alert and exits 0. The job goes red only when the
database is unreachable — i.e. when the check could not be performed at all.

The reasoning: a red X on the repo every morning of a multi-day outage is a red
X people learn to scroll past, and then the *next* red X — a real one, from a
different job — gets scrolled past too. The email is the signal; CI's job is to
guarantee the question was asked. So a green run means "checked", not "clean",
and the job summary says so in as many words.

## Known gaps

- **`scripts/` is outside `tsconfig.json`'s `include`**, so
  `npx tsc --noEmit` does not currently typecheck `watchdog-check.ts`. It was
  verified clean against a temporary config extending the project's (same
  `strict` + `noUncheckedIndexedAccess`). Adding `"scripts/**/*.ts"` to
  `include` is a one-line change outside this task's file ownership and is
  recommended to whoever next edits `tsconfig.json`.
- **The integration acceptance is unrun.** "With `DATABASE_URL` deliberately
  broken in a preview deploy, one simulator turn produces an alert within 60
  seconds" needs a deploy and a Resend key. Do it as part of J1.
- **The cron's first green run is also unrun**, for the same reason.
- **No alert deduplication across instances.** See caveat 4. A dedupe key in
  the database would fix it and would also make the alert path depend on the
  database, which is the thing that is broken. Not worth it.
- **`getLoggingHealth()` is process-local**, so the T11 health line reflects
  whichever instance served that page request. The parent page should say
  "this instance" or derive the authoritative answer from the newest
  `exchanges.created_at`, which is instance-independent.

## `getLoggingHealth()` — stable shape, T11 depends on it

```ts
interface LoggingHealth {
  consecutiveFailures: number;   // this instance only; see the caveat above
  lastSuccessAt: Date | null;    // null = no write from THIS instance yet
  lastFailureAt: Date | null;
  lastError: string | null;      // message only, never the child's words
}
```

Do not change these key names or types without telling T11.
