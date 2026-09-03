# T4 (database, memory, logging) and T6 (parent page) — implementation notes

## Files

**T4**
- `src/memory/schema.sql` — `sessions`, `exchanges`, `user_memory` + the four required indexes. Every statement is `IF NOT EXISTS`; statements are separated by `--;` lines so the migrator can split without a SQL parser.
- `src/memory/db.ts` — `getStore()` (Neon, `DATABASE_URL`) and `createInMemoryStore()`. Both return `ReviewStore`, which is `Store` plus four read-only queries the parent page needs (`listFlagged`, `listSessions`, `loadTranscript`, `listAllMemory`). `createNeonStore(sql)` is exported so the SQL layer can be tested with a fake tagged-template function.
- `src/memory/migrate.ts` — `npm run migrate`. Idempotent, prints one line per statement.
- `src/memory/scrub.ts` — `containsPII`, `scrubLine`, `scrubReason`, `scrubLines`.
- `src/memory/longTerm.ts` — `extractMemory`, `updateMemoryAfterResponse`, `mergeMemory`.
- `src/memory/session.ts` — history loading/sanitising and the session-cap helpers.
- `src/log/exchange.ts` — `logExchange(store, row)` and `deriveFlag(audit)`.

**T6**
- `api/parent/auth.ts` — password compare, signed cookie, rate limit, body parsing, response helpers.
- `api/parent/login.ts` — GET form / POST check.
- `api/parent/index.ts` — the review page, `esc()`, `renderPage(data)`.

## Design decisions worth knowing

**The neon driver is imported dynamically.** `getStore()` validates `DATABASE_URL` synchronously, then imports `@neondatabase/serverless` on the first query. Unit tests import `db.ts` for `createInMemoryStore()` and never pull a driver or open a socket.

**`loadHistory` returns only `flag = 'none'` turns.** A redirected or distress turn contains exactly the text the pipeline decided the model must not see; re-feeding it as conversation history would hand it to the generation model on the next turn. Rejected drafts live in the log, never in history. `sanitizeHistory` additionally drops empty turns and never lets history start on an assistant turn.

**Flag derivation** (`deriveFlag`) follows §7.5, with two deliberate calls: `DISTRESS` outranks an error on the same turn (a distress turn must be red on the parent page even if the pipeline also threw), and `logExchange` overrides a `flag: 'none'` audit when the audit itself implies something else. Under-reporting a flagged turn to JP is worse than over-reporting one.

**Memory cap.** `mergeMemory` and both store implementations keep the newest 20 lines and drop the oldest. `updateMemoryAfterResponse` is the fire-and-forget entry point (`void updateMemoryAfterResponse(...)`); it and `extractMemory` catch everything and resolve to `[]`, so nothing in memory extraction can reject into the request path.

**Extraction is skipped** when `audit.containsPII`, when `flag !== 'none'`, when the input verdict is not `OK`, or when the output verdict is not `PASS`.

## Scrubber tradeoffs

The rule is: a false positive costs one line of "likes horses"; a false negative writes a child's street, school, or a friend's name into a database. The scrubber is therefore deliberately over-broad.

Chosen aggressive rules, and what they cost:

| Rule | False positives accepted |
|---|---|
| Any occurrence of `name/names/named` drops the line | "likes the name of that dinosaur" is lost |
| Any capitalized token after the first word that is not on a small allowlist (planets, Sun/Moon, a few subjects/languages) drops the line | "likes Magic Tree House books", "likes Roblox" are lost. This is the single biggest false-positive source and the main reason a friend's or teacher's first name can never slip through |
| Any month name, weekday, year, `d/d`-shaped date, or "N years old" | "likes stories set in December" is lost |
| Any 5-digit run (zip) or 7+ digit run, plus phone shapes | "counted to 1000000" is lost |
| `school`, `teacher`, `class`, `grade`, `bus N` | "likes school lunch" is lost |
| `town`, `city`, `state`, `country`, `neighborhood`, `street` | "wants a story about a city" is lost |
| Any family or friend word (`brother`, `grandma`, `babysitter`, …), any parent-whereabouts shape | "likes playing with her brother" is lost |
| Health words, schedule words, URLs, emails, handles | mostly things that should not be memory anyway |

Known deliberate gap: a lowercase, unremarkable-looking name in an unusual construction (e.g. a line consisting only of "plays tag with sam") is not caught by the capitalization rule. It *is* caught by the `friend`/family and `name` rules in every phrasing tested, and the extraction prompt forbids names outright, so it takes two independent failures to store one. Rules are cheap to add in `RULES` in `src/memory/scrub.ts` if JP ever sees one in the log.

`containsPII` classifies each `policy.piiPatterns` entry as a regex when it contains a regex metacharacter (`\ [ ] { } ( ) * + ? | ^ $`) and as a literal otherwise; an uncompilable pattern falls back to literal matching, and the function never throws.

## Parent page notes

- Every database value goes through `esc()` (`& < > " ' \``), including session ids in links (`esc(encodeURIComponent(id))`). Tests assert a `<script>` payload in an utterance, in a memory line and in a rejected draft all come out inert.
- No JavaScript, no external fonts, no third-party requests; the response also carries `Content-Security-Policy: default-src 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-store` and `Referrer-Policy: no-referrer`.
- Cookie: `parent_session=<expiryMs>.<hmac-sha256>`, `HttpOnly; Secure; SameSite=Strict; Path=/`, 12-hour TTL. Signed with `SESSION_SECRET` if set, otherwise `PARENT_PASSWORD` — changing the password therefore invalidates every existing session.
- Password compare hashes both sides to 32 bytes and uses `timingSafeEqual`, so neither content nor length leaks through timing.
- Rate limit: 5 attempts per IP per 15 minutes, in-process `Map` keyed on `x-forwarded-for`. It is per serverless instance, not global — good enough for a single-parent page, and it should be understood as a speed bump, not a lockout.
- With `PARENT_PASSWORD` unset, the module authenticates nothing at all (it compares against a random per-process value) rather than falling open.

## Interfaces other tasks will use

```ts
import { getStore, createInMemoryStore } from '../memory/db.ts';
import { logExchange } from '../log/exchange.ts';
import { ensureSession, loadRecentTurns, capState } from '../memory/session.ts';
import { updateMemoryAfterResponse } from '../memory/longTerm.ts';
import { containsPII } from '../memory/scrub.ts';

// after the response has been sent:
void updateMemoryAfterResponse(store, exchangeRow, callFastModel);
```

`updateMemoryAfterResponse` takes `callModel: (args: { system: string; user: string }) => Promise<string>` — the pipeline supplies the adapter for whichever Anthropic client it builds.

## Environment / dependencies

No new package.json dependencies are needed. Env vars used by these files:
`DATABASE_URL`, `PARENT_PASSWORD`, and the optional `SESSION_SECRET` (defaults to `PARENT_PASSWORD`). `SESSION_SECRET` should be added to the T7 env-var list in `docs/SETUP-JP.md` as optional.

## Tests

`tests/unit/scrub.test.ts` (97), `tests/unit/store.test.ts` (46), `tests/unit/parent-auth.test.ts` (41) — 184 assertions total, no network, in-memory store and stubbed model calls only.
