# T2 — Endpoint, verification and handlers: implementation notes

Scope: `api/alexa.ts`, `src/alexa/{verify,ssml,progressive,handlers}.ts`,
`vercel.json`, `tests/unit/{ssml,verify,handlers}.test.ts`.

## Status

| Item | Result |
|---|---|
| Unit tests | 99 passing (ssml 26, verify 34, handlers 39) |
| Typecheck | No errors in any T2 file |
| Network in tests | None. The cert fetcher is stubbed; the progressive sender is injected. |

## Dependency decision — hand-rolled verification

`ask-sdk-express-adapter` is **not installed** (not in `package.json`, not in
`node_modules`), so `SkillRequestSignatureVerifier` / `TimestampVerifier` were
not available. Per the task instructions the package was **not** added to
`package.json`; `src/alexa/verify.ts` implements Amazon's documented algorithm
directly on `node:crypto`:

- cert chain URL must be `https`, host `s3.amazonaws.com`, port 443 or absent,
  and a **path-normalised** pathname starting with `/echo.api/` (so
  `/attacker/../echo.api/../evil/` is rejected, not accepted);
- PEM chain fetched once per URL and cached in a module-level `Map`;
- leaf certificate must be inside its validity window and must carry
  `echo-api.amazon.com` in its SAN (`X509Certificate.checkHost`);
- each certificate must be issued and signed by the next one in the chain;
- signature verified with `RSA-SHA256` for `signature-256`, `RSA-SHA1` for the
  deprecated `signature` header, over `Buffer.from(rawBody, 'utf8')`;
- timestamp tolerance 150 s in both directions;
- `session.application.applicationId` (falling back to
  `context.System.application.applicationId`) is compared to
  `ALEXA_SKILL_ID` with `crypto.timingSafeEqual` when that env var is set.

Everything fails closed: any throw anywhere returns `{ ok: false }`.

**Recommendation for whoever owns `package.json`:** adding
`ask-sdk-express-adapter` (and its transitive `ask-sdk-core` peer, already
present) would let `verify.ts` delegate to Amazon's own verifiers. It is a
nice-to-have, not a blocker — the hand-rolled path is tested and complete. No
other dependency is needed for T2.

### Deliberate deviation
The spec (§4.2) suggests `node:https` for fetching the cert chain. This uses
global `fetch` (Node 20+, `redirect: 'error'`) instead — same behaviour, and it
keeps the module free of stream plumbing. The fetcher is swappable via
`__setCertFetcher()`, which is what the tests use instead of hitting S3.

### Raw body
`api/alexa.ts` sets `export const config = { api: { bodyParser: false } }` and
reads the request stream itself (256 KB ceiling). The signature is verified
against those exact bytes, before `JSON.parse`. Verification failure returns
**HTTP 400 with an empty body** — the reason goes to `console.warn` only, so
the endpoint is not an oracle for someone probing it.

## Assumptions made about other agents' contracts

**A1 — `runPipeline(input, { policy })`.** Called exactly as specified.
`PipelineDeps.policy` turned out to be optional in `src/pipeline/index.ts`;
handlers always pass it explicitly.

**A2 — `PipelineResult.speech` is already gate-approved and already trimmed.**
Handlers re-apply `trimToSentence(speech, policy.maxSpeechChars)` defensively —
if the pipeline already trimmed, this is a no-op. A result whose `speech` is
missing or blank is treated as a broken result and fails closed to canned
`TIMEOUT`.

**A3 — progressive response hook (needs T3 action).** The Progressive Response
filler may only play *after* the input gate returns OK (§4.1), but the input
gate lives inside `runPipeline`, so a handler cannot know when that happens.
`handlers.ts` therefore passes an **optional extra dep**,
`onInputGateOk?: () => void`, alongside `policy`:

```ts
runPipeline(input, { policy, onInputGateOk })
```

A pipeline that ignores it stays fully compatible — the filler simply never
plays, which is safe but means a 4 s generation is silent. **For the filler to
work, `src/pipeline/index.ts` should call `deps.onInputGateOk?.()` at the moment
the input gate returns `OK`.** `sendProgressive` is exported from
`src/alexa/progressive.ts` and is fire-and-forget (1.2 s abort, all errors
swallowed).

**A4 — the continuation offer is a fixed literal.** When an approved answer is
longer than `maxSpeechChars`, handlers append the hardcoded constant
`CONTINUE_OFFER = "Want me to keep going?"` (in `ssml.ts`) and store the
remainder as the continuation context. This is a fixed English literal in the
same spirit as §8 canned lines, never model output, but it does not live in
`canned.ts` (that file's `CannedId` union is owned by `types.ts` and was not
mine to extend). If the canned-invariant lint in T3 greps the response path,
it should treat `CONTINUE_OFFER` and `PROGRESSIVE_FILLER` (in `handlers.ts`) as
approved fixed literals, or they should be migrated into `canned.ts` with two
new ids.

**A5 — `Store` methods may throw.** Every store call in handlers is wrapped:
a database outage degrades logging and session bookkeeping but never costs the
child her answer, and never turns into speech.

**A6 — history source of truth.** `store.loadHistory(sessionId, historyTurns)`
is preferred; the session-attribute copy is the fallback when the store returns
nothing or throws. Both hold approved text only.

**A7 — session clock.** The session cap is measured from the `LaunchRequest`
timestamp recorded in session attributes (`startedAt`), per §6, not from the
`sessions` row. A session that somehow reaches a ChatIntent without a
LaunchRequest starts its clock at that first turn.

## Safety invariants implemented here

1. **Session attributes hold approved text only.** `rememberApproved()` is the
   single writer of speech into session state, and it is only ever handed a
   canned line or `PipelineResult.speech`. `audit.generationText` (the rejected
   draft) goes to `store.logExchange` and nowhere else. Two unit tests assert a
   rejected draft never appears in the serialised attributes and that
   `RepeatIntent` never replays it.
2. **`RepeatIntent` replays `lastApprovedSpeech` or nothing.** With no approved
   speech it falls back to canned `DIDNT_CATCH`.
3. **The ErrorHandler never leaks.** It ignores the error object entirely and
   speaks canned `TIMEOUT`, mic open. Tested with an error message containing a
   fake API key and a fake `DATABASE_URL`.
4. **Every non-final response** sets `shouldEndSession: false` and carries a
   canned `REPROMPT`. Tested across Launch, Chat, Continue, Fallback, Help and
   Repeat.
5. **Final responses** (Stop/Cancel/NavigateHome, WRAP_UP, SessionEnded) set
   `shouldEndSession: true` and carry no reprompt.
6. **`FallbackIntent` never touches the pipeline** and does not increment the
   turn counter.
7. **`SessionEndedRequest` speaks nothing at all** — no `outputSpeech` key.

## Session cap behaviour (§6)

Checked at the top of every ChatIntent/ContinueIntent turn:
`now - startedAt > sessionCapMinutes * 60_000` **or**
`turns >= turnCap`. On a hit: canned `WRAP_UP`, `shouldEndSession: true`,
`store.endSession(sessionId, true)`, and an exchange row with
`cannedId: 'WRAP_UP'`. The pipeline is never called.

## SSML notes

- `escapeSsml` escapes `&` first, then `< > " '`. A test asserts `&amp;lt;`
  never appears, which is the failure mode of getting the order wrong.
- `sanitizeForSpeech` strips code fences, markdown link syntax (keeping the
  link text), bare `http(s)`/`www` URLs, emoji (including flags, keycaps,
  variation selectors and ZWJ), the markdown characters `* _ # \` ~ |`, square
  brackets and list leaders, then collapses whitespace. Apostrophes and hyphens
  are explicitly preserved — `"Don't"` and `"well-known"` survive intact.
- Angle brackets are deliberately **not** stripped by the sanitizer; they are
  escaped to `&lt;`/`&gt;` so `"2 < 3"` is spoken rather than silently
  swallowed.
- `trimToSentence` prefers the last `.`/`!`/`?` followed by whitespace or
  end-of-string whose inclusive slice fits the cap; falls back to the last word
  boundary; and, for a single word longer than the cap, speaks the whole word
  rather than splitting it (documented edge case — never split mid-word).
  A decimal point (`3.14`) is not treated as a boundary because it is not
  followed by whitespace.

## vercel.json

Minimal: `functions["api/alexa.ts"].maxDuration = 10` (matching
`export const maxDuration = 10`), `directoryListing: false`, and three static
hardening headers. No rewrites, no public directory.
