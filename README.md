# echo-kid-assistant

A Claude-powered voice assistant for one 7-year-old, running on a stock Amazon
Echo Dot as a private custom Alexa skill. The Dot is unmodified; everything that
makes it different lives in a Vercel serverless function that answers Alexa's
webhook.

The design goal is unusual for a chatbot: it is **not** to be helpful as often
as possible. It is to make sure that nothing inappropriate is ever spoken aloud
to a child, and to accept a duller assistant as the price. Every ambiguity
resolves toward silence-and-redirect.

Full build spec: [`docs/SPEC.md`](docs/SPEC.md).

---

## The safety invariant

> **Nothing is spoken to the child unless it has passed an independent output
> check, or is one of the hardcoded canned lines in `src/pipeline/canned.ts`.
> There are no exceptions, including error paths.**

Two consequences that everything else in this repo follows from:

1. **Fail closed, always.** Any error, timeout, malformed model output, or
   ambiguous verdict — anywhere, at any stage — produces a canned line, never
   unchecked model text. A classifier that returns `ok` instead of `OK` is
   treated as `SENSITIVE`. An exception in the gate is treated as `SENSITIVE`.
   A blank pipeline result is treated as `TIMEOUT`.
2. **The child's words are never instructions.** Her utterance is always a user
   message, never spliced into a system prompt. Nothing she can say changes the
   persona, the rules, or the safety behaviour.

---

## Architecture

```
Echo Dot ──► Alexa Voice Service ──► POST https://<vercel-app>/api/alexa
                                            │
                                   [0] verify Alexa signature + timestamp
                                            │
                                   [1] load session + user memory (Neon Postgres)
                                            │
                                   [2] INPUT GATE
                                       a. deterministic blocklist / PII regex
                                       b. fast-model classifier → OK | SENSITIVE | DISTRESS | NOISE
                                            │  (SENSITIVE/DISTRESS/NOISE → canned line, skip to [5])
                                   [3] GENERATION (main model, persona system prompt)
                                            │
                                   [4] OUTPUT GATE
                                       fast-model rubric check → PASS | FAIL
                                       anything but a literal PASS → canned line
                                            │
                                   [5] log exchange (verdicts, timings, text) → Postgres
                                            │
                                   [6] respond to Alexa (SSML, shouldEndSession=false, reprompt)
```

Two independent model calls bracket the generation. The gates run a fast,
cheap model (`MODEL_GATE`); generation runs a stronger one (`MODEL_GEN`). The
output gate sees **only** the reply — not the conversation, not the child's
question — so it cannot be argued into leniency by context.

The whole pipeline runs under a 7000 ms deadline (Alexa hard-fails at 8 s),
enforced both by an `AbortController` and by a `Promise.race` against a timer,
because a transport that ignores an abort signal is a real failure mode.

### Decision table

| Input gate | Generation | Output gate | Spoken | Log flag |
|---|---|---|---|---|
| `NOISE` | skipped | skipped | `DIDNT_CATCH` | none |
| `SENSITIVE` | skipped | skipped | `REDIRECT` | redirected |
| `DISTRESS` | skipped | skipped | `DISTRESS` | **distress** |
| `OK` | error/timeout | skipped | `TIMEOUT` | error |
| `OK` | text | `PASS` | the text, escaped and trimmed | none |
| `OK` | text | anything else | `REDIRECT` | gate_fail |
| any | — | — | any exception anywhere | `TIMEOUT` | error |

---

## Repo layout

```
/
├── api/
│   ├── alexa.ts              # webhook: raw body → verify → skill → respond
│   └── parent/
│       ├── index.ts          # parent review page (server-rendered, no JS)
│       ├── login.ts          # GET form / POST check
│       └── auth.ts           # constant-time compare, signed cookie, rate limit
├── src/
│   ├── alexa/                # verify, handlers, progressive response, SSML
│   ├── pipeline/
│   │   ├── index.ts          # orchestration, deadline, decision table
│   │   ├── inputGate.ts      # stage A (deterministic) + stage B (classifier)
│   │   ├── generate.ts
│   │   ├── outputGate.ts
│   │   ├── policy.ts         # loads/validates/normalises config/policy.yaml
│   │   ├── anthropic.ts      # injectable model transport
│   │   └── canned.ts         # ← THE ONLY UNCHECKED STRINGS
│   ├── prompts/              # persona.md, inputGate.md, outputGate.md
│   ├── memory/               # Neon store, schema, migrations, PII scrubber
│   ├── log/exchange.ts       # one row per turn, including error turns
│   └── types.ts              # shared contracts; read this first
├── config/policy.yaml        # blocklist, caps, persona name — edit + redeploy
├── skill-package/            # Alexa skill manifest + en-US interaction model
├── tests/
│   ├── unit/                 # 363 assertions, no network
│   └── redteam/              # cases.yaml + run.ts (see status note below)
└── docs/
    ├── SPEC.md               # the build spec
    ├── SETUP-JP.md           # first-time setup, written for a parent
    ├── ACCEPTANCE-SCRIPT.md  # the spoken sign-off test
    ├── OPERATIONS.md         # change policy, read logs, purge, rotate, incidents
    ├── ENV.md                # every environment variable
    └── T*-NOTES.md           # the build agents' implementation notes
```

---

## Running it

Node 20+.

```bash
npm install
cp .env.example .env.local     # then fill in — see docs/ENV.md
npm run migrate                # applies src/memory/schema.sql (idempotent)
```

### Tests

```bash
npm test            # unit suite — no network, no database, no API key needed
npm run typecheck   # tsc --noEmit
npm run lint:canned # the canned-line invariant lint (see below)
```

`npm run lint:canned` is not a style check. It parses `src/pipeline/` and
enforces that (a) every `speech:` value in `index.ts` is either `canned(...)` or
the single variable `approvedSpeech`, which exists only on the output-gate-PASS
branch, and (b) no string literal over 25 characters appears anywhere in
`src/pipeline/` except `canned.ts`. Long literals are how speakable text sneaks
into the response path. There are currently **zero** exemptions; adding one is a
review event, not a convenience.

### Red-team suite

```bash
npm run redteam       # runs the real pipeline against tests/redteam/cases.yaml
npm run redteam:dry   # verdict distribution only, no assertions — for tuning
```

This makes **real model calls** and needs `ANTHROPIC_API_KEY`, `MODEL_GATE`,
`MODEL_GEN` and a test `DATABASE_URL` (use a separate Neon branch, never
production). It is the deploy gate: ≥250 cases covering sensitive topics,
innocent phrasings, kid-science boundaries, fiction limits, persona attacks,
obfuscation, PII fishing, homework fishing, distress, noise, multi-turn
escalation, and hand-written bad replies fed straight to the output gate.

> **Status note:** `tests/redteam/` is delivered by task T5 and is not present in
> this working tree at the time this README was written; `npm run redteam` will
> fail with a missing-file error until it lands. Do not deploy to the Dot until
> it exists and passes.

---

## Before you change anything

> ### 1. The canned-lines rule
> `src/pipeline/canned.ts` holds the only strings in the system that can be
> spoken without passing the output gate. Do not add an entry, widen an entry,
> or build one by concatenation with model text, user text, or database
> content. Changing a canned line changes speech that nothing else checks, so a
> human — JP — reads and approves it before the device is used.
>
> ### 2. The fail-closed rule
> Every ambiguity resolves to a redirect. If you find yourself adding a
> `catch` that returns model text, a "just this once" default, a looser parse
> of a classifier verdict, or a retry that speaks on the second attempt without
> re-checking — stop. The correct behaviour on every unknown is a canned line.
> `tests/unit/pipeline.test.ts` asserts this for `ok`, `OK.`, `"OK"`, `Okay`,
> JSON-wrapped verdicts, empty strings, non-strings, throws and aborts. Those
> tests are the specification, not a suggestion.
>
> ### 3. The red-team suite must pass 100% before any deploy
> Not "mostly". Every case. A failing case is a build-blocking bug, and the fix
> goes in the prompt, the blocklist, or the code — **never in the test**. This
> applies with special force to any edit to `src/prompts/*.md`: a prompt change
> is a safety change, and the suite must be re-run and green before it ships.

Beyond those three: `config/policy.yaml` and `src/prompts/*.md` are safety
surfaces even though they contain no code. `docs/OPERATIONS.md` describes how to
change each one and what to re-run afterwards.

---

## Known limitations, stated plainly

- No classifier is perfect. This design makes a failure require two independent
  checks to miss the same sentence, fails closed on every error path, and leaves
  a complete log. It is not a mathematical guarantee.
- Alexa outside this skill is only as safe as Amazon's parental controls on a
  regular adult profile, and **a child can enable other skills by voice.** There
  is no toggle that prevents it. The mitigation is the periodic review prompt on
  the parent page.
- Alexa mis-hears children more than adults; expect some `DIDNT_CATCH`. The 412
  `FREE_TEXT` samples in the interaction model are the main lever.
- The 8-second Alexa window means answers are short by design. Long answers are
  truncated at a sentence boundary and continue on "keep going".
- The blocklist is deliberately over-broad and will produce false redirects
  (any sentence containing "beer" or "drunk", for example). That is the correct
  trade for v1; tune it in `config/policy.yaml`.
