# Operations

For whoever maintains this — including JP six months from now, who will have
forgotten all of it.

Read the "Before you change anything" box in `README.md` first. Everything
below assumes those three rules.

---

## The change-and-re-run table

Find what you're changing; do what the last column says. Nothing here is
optional, and the red-team suite is the deploy gate in every row that names it.

| You are changing | File | Redeploy? | Must re-run before deploy |
|---|---|---|---|
| Blocklist, distress/injection/PII patterns, session cap, turn cap, persona name, invocation name, speech length, deadline | `config/policy.yaml` | Yes | `npm test`, `npm run redteam` |
| Persona wording | `src/prompts/persona.md` | Yes | `npm test`, **`npm run redteam` — mandatory** |
| Input classifier prompt | `src/prompts/inputGate.md` | Yes | `npm test`, **`npm run redteam` — mandatory** |
| Output rubric prompt | `src/prompts/outputGate.md` | Yes | `npm test`, **`npm run redteam` — mandatory** |
| Canned lines | `src/pipeline/canned.ts` | Yes | `npm test`, `npm run lint:canned`, human read-through |
| Model ids | Vercel env vars | Yes (env changes need a new deployment) | `npm run redteam` against the new ids |
| Anything in `src/pipeline/` | code | Yes | `npm test`, `npm run typecheck`, `npm run lint:canned`, `npm run redteam` |
| Interaction model | `skill-package/` | Rebuild the Alexa model too | `npm test` |

**Vercel does not apply new environment variables to an existing deployment.**
After changing any env var, trigger a redeploy or the old value stays live.

---

## Changing policy

`config/policy.yaml` is loaded once at cold start by `src/pipeline/policy.ts`.
It is committed to the repo on purpose: a policy change is a reviewable diff
with a commit message, not a setting someone quietly flipped.

Edit → commit → push → Vercel redeploys. **No code change is needed** for any of
the values it holds.

A malformed or empty policy file throws at cold start rather than silently
running with no blocklist. That is intentional — if you break the YAML, the
skill stops answering instead of answering unprotected.

### Adding a blocklist term

```yaml
blocklist:
  # ... existing entries ...
  - newtermhere
```

Things to know before you add one:

- Matching runs on a **normalised** form of the utterance: lowercase → leet
  substitution (`3`→`e`, `0`→`o`, `1`→ both `i` and `l`) → all punctuation
  becomes spaces → runs of two or more single letters are joined into one word.
  That last step is what makes `s.e.x`, `s e x` and `s-e-x` all hit `sex`.
  Write your term as a normal lowercase word; the normaliser does the rest.
- Matching is **word-boundary**, so `sex` does not fire on `essex` and `weed`
  does not fire on `weeds`. Multi-word phrases (`how to kill`) are matched as
  substrings of the normalised text.
- A blocklist hit means the generation model **never sees the utterance**. It
  is the strongest tool here and it is free of model judgement, so prefer it
  for anything you are certain about.
- The list is deliberately over-broad and produces false redirects — any
  sentence containing "beer" or "drunk" is redirected today. That is the
  correct trade. If a false positive is annoying enough to fix, the fix is to
  make the term more specific, never to loosen the matcher.
- **Do not put a digit in a blocklist term.** The leet normaliser mangles
  genuine numbers, so a term containing one will not match reliably.

After editing, run `npm run redteam` — a new term can flip an existing OK case
to a redirect, and that shows up as a failing test.

### Changing persona wording

`src/prompts/persona.md`. Every rule in spec §7.3 stays; wording is yours.

**A prompt change is a safety change.** The persona prompt is one of only three
things standing between the model and the child (the other two being the input
classifier and the output rubric). Re-run the full red-team suite after **any**
edit to any of the three, however cosmetic it looks. "I only reworded a
sentence" is exactly how a rule gets lost.

Template holes available: `{{personaName}}` (from policy) and `{{memoryLines}}`
(the scrubbed long-term memory). The child's utterance is **never** interpolated
into the system prompt — it always arrives as a user message, and
`tests/unit/pipeline.test.ts` asserts this. Don't change that.

---

## Reading the parent log

The page is `https://<your-app>.vercel.app/api/parent`, password
`PARENT_PASSWORD`.

> **Known routing wrinkle:** the page's own internal links point at `/parent`,
> but on Vercel the file `api/parent/index.ts` is served at `/api/parent`. Until
> a rewrite is added to `vercel.json` mapping `/parent` → `/api/parent`, use the
> `/api/...` form and expect in-page links to 404. This is a one-line fix in
> `vercel.json` and is worth doing.

What you see:

- **Flagged strip** — the last 7 days of flagged turns, ordered `distress` (red)
  → `redirected` → `gate_fail` → `error`.
- **Sessions list** — date, duration, turn count, whether the cap was hit, flag
  counts.
- **Session detail** — the full transcript: her words, what was actually spoken,
  and a tag per turn with the verdicts and the canned line id. Rejected model
  drafts are in a collapsed "what was blocked" section.
- **Memory panel** — the current `user_memory` lines, with a delete button each.

### What the flags mean

| Flag | Meaning | Normal? |
|---|---|---|
| `none` | Model answered, output gate passed. | Yes |
| `redirected` | Input gate said SENSITIVE — blocklist, injection pattern, or the classifier. The model never saw it. | Yes, routinely |
| `distress` | Distress pattern or classifier. **Read every one of these.** | Rare — investigate each |
| `gate_fail` | The model wrote something and the output gate rejected it. The system worked. | Occasional is fine; a cluster means the persona prompt has drifted |
| `error` | Timeout or exception. She heard the `TIMEOUT` line. | A few are normal; a wall of them means the model ids are wrong or the API key is dead |

`distress` outranks `error` on the same turn by design — a distress turn shows
red even if the pipeline also threw.

### Querying directly

Sometimes SQL is faster than the page. Connect with `psql "$DATABASE_URL"`.

```sql
-- Everything flagged in the last week, newest first
SELECT created_at, flag, utterance, spoken, canned_id
FROM exchanges
WHERE flag <> 'none' AND created_at > now() - interval '7 days'
ORDER BY created_at DESC;

-- One turn in full, including the rejected draft and the raw model outputs
SELECT * FROM exchanges WHERE id = 1234;

-- How often each flag fires (are the gates too tight, or too loose?)
SELECT flag, count(*) FROM exchanges
WHERE created_at > now() - interval '30 days'
GROUP BY flag ORDER BY count DESC;

-- Slow turns — anything near the 7000 ms deadline
SELECT created_at, (timings->>'totalMs')::int AS total_ms, utterance
FROM exchanges
WHERE (timings->>'totalMs')::int > 5000
ORDER BY total_ms DESC LIMIT 50;

-- Turns where the deterministic PII scan matched
SELECT created_at, utterance FROM exchanges
WHERE contains_pii ORDER BY created_at DESC;
```

---

## Purging transcripts and memory

Retention in v1 is "keep everything". Purge deliberately, on your own schedule.

**Take a backup first if you might want it later.** Once these run, the parent
log for that period is gone.

```sql
-- 1. Delete exchanges older than 90 days
DELETE FROM exchanges WHERE created_at < now() - interval '90 days';

-- 2. Delete sessions that no longer have any exchanges
DELETE FROM sessions s
WHERE NOT EXISTS (SELECT 1 FROM exchanges e WHERE e.session_id = s.session_id);
```

Wipe everything — a full reset of the conversation history:

```sql
TRUNCATE exchanges;
TRUNCATE sessions;
```

Wipe the long-term memory (she gets a helper with no recollection of her
interests; nothing breaks):

```sql
DELETE FROM user_memory;                       -- everyone
DELETE FROM user_memory WHERE user_id = '...'; -- one Alexa user id
```

Delete one memory line (the parent page's delete button does exactly this):

```sql
DELETE FROM user_memory WHERE id = 42;
```

Purge one session's transcript, keeping the rest:

```sql
DELETE FROM exchanges WHERE session_id = 'amzn1.echo-api.session....';
DELETE FROM sessions  WHERE session_id = 'amzn1.echo-api.session....';
```

**Right-to-erasure style wipe for one user** (all three tables):

```sql
BEGIN;
DELETE FROM exchanges   WHERE user_id = 'amzn1.ask.account....';
DELETE FROM sessions    WHERE user_id = 'amzn1.ask.account....';
DELETE FROM user_memory WHERE user_id = 'amzn1.ask.account....';
COMMIT;
```

The `user_id` is Amazon's opaque account token, not a name. It is not PII on its
own, but it is the join key for everything, so treat it as identifying.

---

## Rotating secrets

### The Anthropic API key

1. Claude Console → Settings → API keys → create a **new** key in the same
   workspace (so it inherits the spend limit).
2. Vercel → Settings → Environment Variables → update `ANTHROPIC_API_KEY`.
3. **Redeploy.** Env changes do not reach a running deployment.
4. Say something to the Dot and confirm you get a real answer, not the
   "my thinking got a little tangled" timeout line.
5. Only then, revoke the old key in the console.

Do it in that order. Revoking first means every turn fails closed to `TIMEOUT` —
harmless but useless — until the redeploy lands.

### The parent password

1. Vercel → update `PARENT_PASSWORD` → redeploy.
2. Log in with the new password.

**If `SESSION_SECRET` is not set**, the password doubles as the cookie signing
key, so changing it logs you out of the parent page on every device. That is not
a bug, but it is a reason to set `SESSION_SECRET` to its own random value once
and never think about it again. See `docs/ENV.md`.

### `DATABASE_URL`

Reset the role password in the Neon console, copy the new connection string,
update Vercel, redeploy. The old string stops working immediately, so expect a
gap of a minute or two in which every turn errors (and is not logged — which is
itself the reason to do this at a quiet moment).

### The skill id

`ALEXA_SKILL_ID` only changes if the skill is recreated. If it is, update the
env var, redeploy, and re-run the acceptance script from step 8 of
`docs/SETUP-JP.md`.

---

## When the red-team suite fails

> **Fix the prompt. Never the test.**

A failing red-team case is a build-blocking bug. It means a real utterance
produced a verdict the design says it must not produce. Weakening the case, or
deleting it, converts a known hole into an unknown one.

The runner prints, for each failure: the utterance, every verdict, and the raw
model output at each stage. Work from that.

1. **Read the raw outputs.** Which stage got it wrong — did the classifier
   return `OK` on something sensitive, or did the classifier return `SENSITIVE`
   on something fine, or did generation write something the rubric should have
   caught but didn't?
2. **Reproduce it in isolation** with `npm run redteam:dry`, which reports the
   verdict distribution without asserting. Useful for seeing whether you have
   one bad case or a whole category drifting.
3. **Fix at the strongest available layer.** In order of preference:
   - a deterministic pattern in `config/policy.yaml` (blocklist, distress,
     injection) if the case is one you can state as a rule;
   - the classifier prompt (`src/prompts/inputGate.md`) if it needs judgement;
   - the persona prompt (`src/prompts/persona.md`) if the model is generating
     something it shouldn't have generated at all;
   - the output rubric (`src/prompts/outputGate.md`) if the last line of
     defence let it through. **A fix in the rubric alone is a warning sign** —
     it means something upstream is producing text that should never have
     existed.
4. **Re-run the whole suite**, not just the failing case. Tightening one thing
   loosens another surprisingly often, especially with the input classifier.
5. **Commit the fix and the reasoning together.** Six months from now the
   commit message is the only record of why a prompt says what it says.

If a case genuinely encodes the wrong expectation — the spec's call, not the
implementation's, was wrong — that is a **spec change**, discussed and written
down in `docs/SPEC.md`, not a quiet edit to `cases.yaml`.

The suite also runs nightly in CI, because the models change underneath you
even when the code doesn't. A nightly failure on unchanged code means a model
update shifted a boundary — treat it exactly like any other failure.

---

## Upgrading a model id

Models are deprecated and superseded on Anthropic's schedule, not yours. Expect
to do this a couple of times a year.

1. Check the current list at
   <https://platform.claude.com/docs/en/models/overview> (or `GET /v1/models`).
   Pick the newest **Haiku-class** for `MODEL_GATE` and the newest
   **Sonnet-class** for `MODEL_GEN`, per spec §4.2.
2. Set the new ids **locally first** in `.env.local`.
3. Run `npm run redteam` against the new ids. **This is the whole point of the
   procedure.** A new model has different boundaries: it will classify some
   utterances differently and write in a different register, and the suite is
   how you find out where.
4. If cases fail, tune the prompts against the new model (see the section
   above), not the tests.
5. Only when the suite is green: set the ids in Vercel, redeploy, and speak to
   the Dot to confirm.
6. Re-run at least rows 2–12 of `docs/ACCEPTANCE-SCRIPT.md`. A model change is
   the most likely single cause of a regression in speech quality, and the
   automated suite does not judge tone.

**Do not rely on the built-in defaults in `src/pipeline/anthropic.ts`.** They
were written from possibly-stale knowledge, and at least one of them is already
behind the current list. Always set both env vars explicitly.

An unknown model id makes every call throw, which fails closed to `TIMEOUT` —
safe, but the assistant is useless and the log fills with `error` flags.

---

## Incident runbook: "she heard something she shouldn't have"

Something got past two independent checks. Work through this in order. It should
take twenty minutes.

### 1. Contain (only if it is ongoing)

If it's a repeating problem rather than a one-off, unplug the Dot, or disable
testing in the Alexa developer console (Test tab → the stage dropdown → **Off**).
Don't debug a live device.

### 2. Pull the exact exchange row

Find it by time, or by a phrase you remember:

```sql
SELECT id, created_at, session_id, flag, canned_id,
       utterance, spoken, generation_text,
       input_verdict, input_reason, input_raw,
       output_verdict, output_raw,
       models, timings, error
FROM exchanges
WHERE created_at BETWEEN '2026-09-03 18:00Z' AND '2026-09-03 19:00Z'
ORDER BY created_at;
```

```sql
-- or by content
SELECT id, created_at, utterance, spoken FROM exchanges
WHERE spoken ILIKE '%the phrase she repeated%'
ORDER BY created_at DESC;
```

Pull the surrounding turns too — escalation across a session is a real pattern:

```sql
SELECT id, created_at, utterance, spoken, flag
FROM exchanges WHERE session_id = '<session id from above>'
ORDER BY created_at;
```

### 3. Work out which gate passed it

Read the row's verdicts. There are only a few possibilities, and each points at
a different fix:

| What the row shows | What failed | Fix goes in |
|---|---|---|
| `input_verdict = OK` on an utterance that should have been SENSITIVE | The input classifier, or a missing deterministic pattern | `config/policy.yaml` blocklist/patterns first; then `src/prompts/inputGate.md` |
| `input_verdict = OK`, `output_verdict = PASS`, and `spoken` is the problem | The output rubric let it through | `src/prompts/outputGate.md` **and** `src/prompts/persona.md` — the persona should not have written it in the first place |
| `spoken` is a canned line | A canned line itself is wrong | `src/pipeline/canned.ts` — and this one needs a human read-through of the whole file |
| `generation_text` is fine but `spoken` is mangled | The SSML/trim layer | `src/alexa/ssml.ts` |
| Nothing in the log matches what she heard | It wasn't this skill — regular Alexa, a skill she enabled by voice, or music | Check enabled skills in the Alexa app; see the honesty note in `docs/SETUP-JP.md` step 2 |

That last row matters. Before rebuilding a prompt, confirm the words actually
came from this system. Every turn is logged; if it isn't in `exchanges`, this
system did not say it.

### 4. Add the case to the suite — before fixing anything

Add the exact utterance to `tests/redteam/cases.yaml` with the verdict it should
have produced. If the failure was in the reply rather than the classification,
add the offending reply to the output-gate-only sub-suite with `expected: FAIL`.

Do this **first**, and watch it fail. A case added after the fix proves nothing;
a case that fails, then passes, proves the fix.

### 5. Fix

Follow "When the red-team suite fails" above — strongest layer first,
deterministic before model judgement.

### 6. Re-run and deploy

```bash
npm test && npm run typecheck && npm run lint:canned && npm run redteam
```

All four green, then deploy, then say the offending thing to the Dot yourself
and confirm it now redirects.

### 7. Write it down

A short note in the commit message: what she said, what she heard, which gate
passed it, what changed. Every one of these is information about where the
boundary actually sits, and it is worth more than any amount of guessing.

### 8. Consider whether the gap is structural

One escaped sentence is a tuning problem. Three from the same category is a
design problem — and the honest answer might be to add a deterministic rule
that redirects the whole category, accepting the false positives. Spec §14 is
clear that this system is not a guarantee. Widening the fail-closed net is
always an available move, and it is usually the right one.
