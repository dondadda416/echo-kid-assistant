# T3 — Safety pipeline: implementation notes

Everything here is a judgment call made while implementing spec §7. Where I
deviated from or tightened the spec, it is called out explicitly. Nothing was
loosened.

## Files delivered

| File | Purpose |
|---|---|
| `src/prompts/inputGate.md` | §7.2 classifier prompt |
| `src/prompts/persona.md` | §7.3 generation system prompt |
| `src/prompts/outputGate.md` | §7.4 rubric prompt |
| `src/pipeline/anthropic.ts` | injectable model transport |
| `src/pipeline/policy.ts` | policy load/validate/compile + normalisation |
| `src/pipeline/inputGate.ts` | §7.1 stage A + §7.2 stage B |
| `src/pipeline/generate.ts` | §7.3 generation |
| `src/pipeline/outputGate.ts` | §7.4 output gate |
| `src/pipeline/index.ts` | orchestration, deadline, §7.5 decision table |
| `tests/unit/inputGate.test.ts` | 49 tests |
| `tests/unit/pipeline.test.ts` | 31 tests |
| `tests/unit/canned-invariant.check.ts` | `npm run lint:canned` safety lint |

## Model IDs — READ BEFORE DEPLOY

`src/pipeline/anthropic.ts` reads `MODEL_GATE` and `MODEL_GEN` from the
environment and falls back to:

- `MODEL_GATE` → `claude-haiku-4-5`
- `MODEL_GEN`  → `claude-sonnet-4-5`

**These defaults were written from knowledge that may be stale. Spec §4.2 says
the implementing agent must check the current model list and pick the newest
Haiku-class and Sonnet-class model.** Before the first deploy, verify both IDs
against the live model list and set the env vars explicitly in Vercel so the
defaults are never load-bearing in production. An unknown model ID makes every
call throw, which fails closed to `TIMEOUT` — safe, but the assistant is then
useless, and the red-team suite (T5) will catch it as a wall of `TIMEOUT`s.

## Judgment calls

### Normalisation (`policy.ts`)

- Matching text is produced by: lowercase → leet substitution → replace every
  non `[a-z0-9]` character with a space → collapse whitespace → **join runs of
  two or more single letters into one word**. That last step is what makes
  `s.e.x`, `s e x` and `s-e-x` all normalise to `sex` while `i am hurt` keeps
  its three tokens. Blocklist matching then uses `\b…\b`, so `essex` and
  `weeds` do not hit `sex` / `weed`.
- `1` is ambiguous (`i` or `l`), so normalisation returns **two** readings and
  a hit on either counts. This catches both `k1ll` and `ki11`.
- Leet mapping mangles genuine numbers (`3` → `e`). That is harmless: no
  blocklist, distress or injection term contains a digit, and the mangled text
  is used only for matching, never for generation. The PII scan deliberately
  uses a *different*, lighter normalisation (lowercase + whitespace collapse
  only) so phone-number and street-address shapes survive.

### Ordering and the PII flag (**tightened**)

Spec §7.1 lists the PII scan after the injection check. Blocking order is
implemented exactly as specified (too-short → distress → blocklist → injection
→ classifier), but `containsPII` is computed **up front and always reported**,
including on early stage-A returns. If the child says "my name is Ellie and
I'm bleeding", the parent log now shows both the distress flag and the PII
flag; with the literal reading, the PII flag would have been lost. The PII scan
still never blocks anything.

### `InputReason.clean` is unused

Every classifier-decided verdict (including `OK`) reports reason `classifier`,
which is more informative for the log than `clean`. `clean` remains in the type
for other consumers; nothing in the pipeline emits it.

### Noise detection

Stage A returns `NOISE`/`too_short` when the trimmed utterance is under 2
characters, or when every normalised token is a single letter or a known filler
(`um`, `uh`, `hmm`, `er`, `mm`, `huh`, `oh`, …). The noise check runs on the
**letter-run-collapsed** form, so `s e x` is judged as the single token `sex`
and correctly falls through to the blocklist rather than being dismissed as
noise. Getting that order wrong would have been a real evasion.

### Classifier parsing (the core fail-closed rule)

Only an exact, case-sensitive `OK` / `SENSITIVE` / `DISTRESS` / `NOISE` after
`trim()` is accepted. `ok`, `Ok`, `OK.`, `"OK"`, `Okay`, `{"verdict":"OK"}`,
`""`, `SENSITIVE OK`, `verdict: OK`, a non-string return, a thrown error and an
aborted signal all resolve to `SENSITIVE` with reason `classifier_error`.
Leading/trailing whitespace is tolerated because it carries no meaning.
`inputGate()` and `outputGate()` are both written so they **cannot throw** — an
exception escaping a gate would otherwise become a `TIMEOUT` rather than a
redirect, and a redirect is the more accurate parent-log signal.

### Message-role placement (**tightened relative to the drafts**)

- Input gate: the classifier prompt is the **system** message and the child's
  utterance is the **user** message. Child words never enter a system string.
- Generation: `persona.md` is the system prompt; history and then the
  utterance are messages. The utterance is never interpolated into the system
  string — asserted by `tests/unit/pipeline.test.ts`.
- Output gate: the rendered rubric (with the reply between the `<<<REPLY …
  REPLY>>>` markers, per the spec draft) is the system message and the user
  message is the literal `PASS or FAIL`. The output gate sees only the reply,
  never the history or the utterance — asserted by a test.

### Continuation context

`PipelineInput.continuation` is previously-**approved** model text (the tail of
a reply that was truncated), so it is safe to place in the system prompt. It is
appended after the persona template under a short `Continue this:` label, and
it switches the token budget to `generation.storyMaxTokens`. It is never mixed
with the child's utterance. The "want me to keep going?" wording is *not*
emitted here — `PipelineResult.continuation` is returned and the Alexa/SSML
layer (T2) owns the prompt to the child.

### Truncation

Approved speech is cut at the last `.`/`!`/`?` inside `policy.maxSpeechChars`.
If the only boundary found sits before 40 % of the cap (which would leave the
child hearing almost nothing), it falls back to the last word boundary
instead. The remainder becomes `continuation`. Truncation applies **only** to
output-gate-approved text; canned lines are spoken whole and are all well
under the cap.

### `keepListening` is always `true`

The pipeline never ends a session, including on `DISTRESS`. Session end is
owned by the handler layer (`GOODBYE`, `WRAP_UP`, cap logic in T2/T4). Ending
the session after a distress line would close the mic on a child who may want
to say more.

### Deadline

`policy.deadlineMs` (7000 ms) is enforced two ways at once: an `AbortController`
passed into every model call *and* a `Promise.race` against a rejecting timer.
The race is the guarantee — it fires even against a transport that ignores the
abort signal. Losing branches get a no-op `.catch()` so an aborted in-flight
call cannot surface as an unhandled rejection. Any escaping exception, from any
stage, returns the `TIMEOUT` canned line with flag `error`.

### `loadPolicy()` default argument

The task described `loadPolicy(path)` for tests plus a singleton. `api/alexa.ts`
(T2) calls `loadPolicy()` with no arguments, so the parameter defaults to
`config/policy.yaml`. Same for `loadCompiledPolicy()`. A malformed or empty
policy file throws at cold start rather than silently running with no
blocklist.

## The canned-line invariant lint

`npm run lint:canned` runs `tests/unit/canned-invariant.check.ts`, which
tokenises the pipeline sources (correctly skipping comments, regex literals and
template holes) and enforces two rules:

1. In `src/pipeline/index.ts`, every `speech:` value must be either
   `canned(...)` or the single variable `approvedSpeech`, which exists only on
   the branch where the output gate returned an exact `PASS`. It also checks
   that `index.ts` imports from `./canned.ts`.
2. No string literal longer than 25 characters anywhere in `src/pipeline/`
   except `canned.ts`. Long literals are how speakable text sneaks into the
   response path. A genuinely non-speech long literal can be exempted with a
   `not-speech` marker on the same line — **there are currently zero
   exemptions**, and adding one should be treated as a review event.

Rule 2 is why the truncation helper returns `{ head, rest }` rather than
`{ speech, rest }`: reserving the identifier `speech` for the response path
keeps rule 1 unambiguous.

## Test results

- `npx vitest run tests/unit/inputGate.test.ts tests/unit/pipeline.test.ts`
  → **80 passed, 0 failed** (49 + 31).
- `npx tsc --noEmit` → clean.
- `npm run lint:canned` → OK.

No test in this task makes a network call. `ANTHROPIC_API_KEY` is not read
until the first real call, and the SDK is imported dynamically, so the pipeline
imports cleanly in an environment with no key.

## Follow-ups for other tasks

- **T5 (red team):** the classifier prompt's examples are a first draft. Tune
  them from `--dry` verdict distributions, not by weakening tests.
- **T5:** add output-gate-only cases for the subtle failures listed in §9.12.
- **T2:** `PipelineResult.continuation` must be stored in session attributes and
  the "want me to keep going?" offer appended from a canned line.
- **Ops:** the blocklist is intentionally over-broad and will produce false
  redirects (e.g. any sentence containing "beer" or "drunk"). That is the
  correct trade for v1; JP tunes `config/policy.yaml`.
