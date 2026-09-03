# T1 — Skill package notes

Deliverables:

- `skill-package/skill.json`
- `skill-package/interactionModels/custom/en-US.json`

Both files are hand-authored and parse as valid JSON. The interaction model carries
**412 distinct `FREE_TEXT` sample values** (spec floor: 200; task floor: 220), zero
duplicates (case-insensitive), and zero matches against any `blocklist`,
`distressPatterns`, `injectionPatterns`, or `piiPatterns` entry in `config/policy.yaml`.
Sample length ranges from 1 word ("why") to 13 words.

---

## 1. ASK CLI — validate and deploy

Prerequisites (one-time, see also `docs/SETUP-JP.md` from T7):

```bash
npm install -g ask-cli
ask configure          # sign in with the SAME Amazon account as the Echo Dot
```

The repo root is the ASK project root; `skill-package/` is the deployable package.
A minimal `ask-resources.json` is needed at the root for `ask deploy` (T7 owns that
file — it is not part of T1):

```json
{
  "askcliResourcesVersion": "2020-03-31",
  "profiles": {
    "default": {
      "skillMetadata": { "src": "./skill-package" }
    }
  }
}
```

### First-time create (no skill id yet)

```bash
# Creates the skill from skill.json + the interaction model, then builds the model.
ask deploy --target skill-metadata --profile default
```

`ask deploy` writes the new skill id into `.ask/ask-states.json`. Copy it into the
Vercel env var `ALEXA_SKILL_ID` (§11.5 of the spec) so the endpoint can pin
`applicationId`.

### Validate the interaction model without deploying

```bash
# Static/structural validation of the model JSON:
ask smapi set-interaction-model \
  --skill-id <SKILL_ID> \
  --stage development \
  --locale en-US \
  --interaction-model file:skill-package/interactionModels/custom/en-US.json

# Model build is asynchronous — poll until status is SUCCEEDED:
ask smapi get-interaction-model-metadata \
  --skill-id <SKILL_ID> --stage development --locale en-US

# Full skill validation (runs Amazon's validators over the whole package):
ask smapi submit-skill-validation \
  --skill-id <SKILL_ID> --stage development --locales en-US
ask smapi get-skill-validations \
  --skill-id <SKILL_ID> --validation-id <VALIDATION_ID> --stage development
```

Also useful:

```bash
# Update just the manifest after editing skill.json:
ask smapi update-skill-manifest \
  --skill-id <SKILL_ID> --stage development \
  --manifest file:skill-package/skill.json

# Pull the live model back down to diff against the repo:
ask smapi get-interaction-model \
  --skill-id <SKILL_ID> --stage development --locale en-US > /tmp/live-model.json

# Enable the skill for voice testing on the Dot:
ask smapi set-skill-enablement --skill-id <SKILL_ID> --stage development

# Dialog-test an utterance without speaking to the device:
ask dialog --skill-id <SKILL_ID> --locale en-US --stage development
```

### Redeploy loop after any model edit

```bash
ask deploy --target skill-metadata --profile default
ask smapi get-interaction-model-metadata --skill-id <SKILL_ID> --stage development --locale en-US
```

Do **not** run `ask smapi submit-skill-for-certification`. Distribution is
development-only (`distributionMode: PRIVATE`, `isAvailableWorldwide: false`) per
spec §5 — this skill is never published.

---

## 2. Known risk: the bare `{utterance}` sample

`ChatIntent` currently includes the bare sample `{utterance}` — a single slot with no
carrier words. This is the thing that actually makes catch-all recognition work: without
it, anything the child says that doesn't begin with one of the carrier phrases falls to
`AMAZON.FallbackIntent` and she hears `DIDNT_CATCH` instead of an answer.

**The risk:** the Alexa developer console / SMAPI model build has historically rejected
or warned on utterance samples that consist only of a slot reference, especially when
the slot's custom type is not a phrase-type slot. Typical failure text is along the lines
of *"Sample utterance ... invalid: it must contain at least one word besides the slot"*
or a build warning about an intent that can match any input. Behavior varies by account
and has changed over time, so this must be checked empirically at deploy time.

**What to do if the build rejects it:**

1. Remove **only** the `"{utterance}"` entry from `ChatIntent.samples` in
   `skill-package/interactionModels/custom/en-US.json`. Keep all ten carrier variants:
   `tell me {utterance}`, `i want to know {utterance}`, `can you {utterance}`,
   `what is {utterance}`, `why {utterance}`, `how {utterance}`, `let's {utterance}`,
   `story about {utterance}`, `help me with {utterance}`, `i want {utterance}`.
2. Rebuild (`ask deploy --target skill-metadata`) and confirm `SUCCEEDED`.
3. Record the outcome in the table below.
4. Compensate for the lost coverage: `AMAZON.FallbackIntent` sensitivity is already
   `LOW` (see §3), so unmatched speech is more likely to land on `ChatIntent` anyway.
   If real-world mis-routing is still common, the fallback handler in T2 may be changed
   to route the raw utterance into the pipeline instead of speaking `DIDNT_CATCH` — but
   that is a T2 decision and requires the input gate to run on it exactly as it does for
   `ChatIntent`. Nothing bypasses §7.

**Also worth watching at build time:** Amazon may emit a *warning* (not an error) that
`FREE_TEXT` sample values overlap with built-in intents or with `ContinueIntent` samples.
Warnings do not block the build. If a real conflict shows up in testing — e.g. "more"
being swallowed by `ChatIntent` — the fix is to remove the colliding value from
`FREE_TEXT`, not to remove it from `ContinueIntent`.

### Build result log — fill in on first deploy

| Date | ASK CLI version | Bare `{utterance}` accepted? | Build status | Notes |
|---|---|---|---|---|
| _(pending first deploy)_ | | | | |

---

## 3. Why `fallbackIntentSensitivity.level` is `LOW`

`AMAZON.FallbackIntent` fires when Alexa's model thinks an utterance doesn't match any
intent. Sensitivity controls how eagerly it fires:

- `HIGH` — fires readily; good for narrow skills with a small, fixed set of commands,
  where catching out-of-domain speech matters more than catching every in-domain phrase.
- `LOW` — fires reluctantly; ambiguous input is more likely to be routed to a real intent.

This skill is the opposite of a narrow command skill. `ChatIntent` is deliberately a
catch-all: a 7-year-old will say almost anything, in almost any shape, and every one of
those utterances is supposed to reach the pipeline. With `HIGH` (or the default `MEDIUM`),
FallbackIntent competes with `ChatIntent` for exactly the sentences we most want to
answer — genuine questions phrased in a way the 412 seed samples don't cover — and the
child hears "I didn't quite catch that" instead of an answer. Spec §14 names Alexa's
mis-hearing of children as a known limitation and calls the `FREE_TEXT` samples the main
lever; a permissive fallback is the second lever.

Routing more input to `ChatIntent` costs nothing in safety. Everything that reaches
`ChatIntent` — including genuine noise and mis-hears — goes through the full input gate
(§7.1/§7.2), where `NOISE` produces the same `DIDNT_CATCH` line FallbackIntent would have
produced, and `SENSITIVE`/`DISTRESS` are caught deterministically before the generation
model ever sees the text. The only cost of a mis-routed noise utterance is one cheap
classifier call. The cost of a mis-routed *real question* is a worse experience for the
child, so we bias toward `ChatIntent`.

---

## 4. Open Alexa constraints — verify at deploy time

These could not be verified without a live developer account and should be confirmed by
whoever runs the first deploy:

1. **Bare `{utterance}` acceptance** — as above, the single biggest unknown.
2. **`isChildDirected: false`** in `skill.json`. The Dot runs on JP's regular adult
   Amazon profile by design (spec §3 — custom dev skills are hidden under Amazon Kids),
   so the skill is not a "child-directed" skill in Amazon's COPPA sense and marking it
   `true` would pull in child-directed policy constraints that block development-mode
   testing. This is the correct flag for the chosen architecture, but it is a judgment
   call worth JP's explicit sign-off.
3. **Icon URIs omitted.** `smallIconUri` / `largeIconUri` are required for certification
   but generally not for a development-stage skill. If `ask deploy` errors asking for
   them, T7 should add hosted icon URLs to `publishingInformation.locales.en-US`.
4. **Privacy policy / terms URLs omitted** deliberately (spec §5, development-only).
   `privacyAndCompliance.locales.en-US` is present but empty. If the manifest update is
   rejected for a missing `privacyPolicyUrl`, that is a signal the skill is being treated
   as distribution-bound — stop and re-check `distributionMode`, do not just add a URL.
5. **`FREE_TEXT` slot value count.** Alexa's per-slot-type value limits are large
   (tens of thousands), so 412 is well inside them, but the *total* model size and build
   time should be sanity-checked. The current model file is ~52 KB.
6. **`interfaces: []`** — no display, no audio player, no APL, as specified. Confirm the
   console does not silently re-add an interface when the skill is created through the
   web UI rather than the CLI.
7. **`ContinueIntent` name collision** — there is no `AMAZON.ContinueIntent` built-in in
   en-US at time of writing, so a custom `ContinueIntent` is fine. If a future locale
   update introduces one, the custom intent must be renamed rather than shadowed.
