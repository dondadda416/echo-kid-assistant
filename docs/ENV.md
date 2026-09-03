# Environment variables

Every variable the system reads, where it is set, and how to get it.
`.env.example` at the repo root mirrors this file with placeholder values.

**Never commit a real value.** `.env` and `.env.local` are gitignored. In
production the authority is the Vercel project's Environment Variables screen;
there is no `.env` file on the server.

---

## Summary table

| Name | Required | Set where | Default | Used by |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | Vercel (all environments), local `.env.local`, CI secret | none — calls throw | `src/pipeline/anthropic.ts` |
| `MODEL_GATE` | **Yes in production** | Vercel, local, CI secret | `claude-haiku-4-5` (stale — see below) | both safety gates |
| `MODEL_GEN` | **Yes in production** | Vercel, local, CI secret | `claude-sonnet-4-5` (stale — see below) | generation |
| `DATABASE_URL` | **Yes** | Vercel, local, CI secret (test branch) | none — `getStore()` throws | `src/memory/db.ts`, `npm run migrate` |
| `PARENT_PASSWORD` | **Yes** | Vercel only | none — parent page authenticates nothing | `api/parent/auth.ts` |
| `SESSION_SECRET` | No (recommended) | Vercel only | falls back to `PARENT_PASSWORD` | parent cookie signing |
| `ALEXA_SKILL_ID` | No (recommended) | Vercel only | unset — skill-id check skipped | `src/alexa/verify.ts` |
| `RESEND_API_KEY` | No (recommended) | Vercel + GitHub Actions secret | unset -- alerts go to `console.error` only | `src/log/alert.ts` |
| `ALERT_EMAIL` | No (recommended) | Vercel + GitHub Actions secret | unset -- alerts go to `console.error` only | `src/log/alert.ts` |
| `ALERT_FROM` | No | Vercel + GitHub Actions secret | `onboarding@resend.dev` | `src/log/alert.ts` |

Unit tests (`npm test`) need **none** of these. They use an in-memory store and
stubbed model transports and make no network calls.

---

## `ANTHROPIC_API_KEY`

**What it does.** Authenticates every call to the Anthropic API — the input-gate
classifier, generation, the output-gate rubric, and the post-turn memory
extraction.

**How to obtain.** Claude Console (`console.anthropic.com`) → **Settings** →
**API keys** → create a key. Copy it once; it is not shown again.

**Set a spend limit at the same time.** Console → **Settings** → **Workspaces**
→ select the workspace → **Spend limits** tab → cap monthly spend and set an
alert threshold. Note that spend limits cannot be set on the *Default*
Workspace, so create a workspace for this project and issue the key inside
it.[^spend]

**Where it goes.** Vercel project → Settings → Environment Variables (Production
+ Preview + Development). Locally, `.env.local`. It is never written to the
database, never logged, and never rendered on the parent page.

**Failure mode.** Missing or invalid → every model call throws → the pipeline
fails closed to the `TIMEOUT` canned line on every turn. Safe, but the assistant
says nothing useful. The red-team suite surfaces this as a wall of `TIMEOUT`s.

---

## `MODEL_GATE` and `MODEL_GEN`

**What they do.** `MODEL_GATE` is the fast, cheap model that runs *both*
independent safety checks — the input classifier (§7.2) and the output rubric
(§7.4). `MODEL_GEN` is the stronger model that writes the actual answer.
Two different models by design: the checker is not the writer.

### Model IDs — verify before every deploy

`src/pipeline/anthropic.ts` falls back to:

- `MODEL_GATE` → `claude-haiku-4-5`
- `MODEL_GEN` → `claude-sonnet-4-5`

**T3's notes state plainly that these defaults were written from possibly-stale
knowledge and must be checked against the live model list before deploy**
(`docs/T3-NOTES.md`, "Model IDs — READ BEFORE DEPLOY"). Spec §4.2 requires the
newest Haiku-class model for the gates and the newest Sonnet-class model for
generation.

At the time this doc was written the published model list gave the newest
Haiku-class ID as `claude-haiku-4-5-20251001` and the newest Sonnet-class ID as
`claude-sonnet-5` — note that **`claude-sonnet-4-5` is no longer the newest
Sonnet**, so the built-in default is already behind.[^models]

**Therefore: always set both variables explicitly in Vercel.** Never let the
defaults be load-bearing in production. Check the current list at
<https://platform.claude.com/docs/en/models/overview>, or programmatically via
the Models API (`GET /v1/models`).

**Failure mode.** An unknown model ID makes every call throw → fail closed to
`TIMEOUT`. Harmless to the child, useless to her. Upgrade procedure:
`docs/OPERATIONS.md`, "Upgrading a model ID".

---

## `DATABASE_URL`

**What it does.** Neon Postgres connection string. Backs the three tables in
`src/memory/schema.sql`: `sessions`, `exchanges` (one row per turn — the parent
log) and `user_memory` (≤20 scrubbed topic lines per user).

**How to obtain.** Neon Console → your project → **Connect** on the project
dashboard → pick branch / compute / database / role → copy the string. **Leave
"Connection pooling" enabled** — this runs on serverless functions.[^neon]
It looks like:

```
postgresql://USER:PASSWORD@HOST.neon.tech/DBNAME?sslmode=require
```

The password is in the string in plain text. Treat the whole value as a secret.

**Where it goes.** Vercel (all environments) and `.env.local` for running
`npm run migrate` from a laptop. If CI runs the red-team suite, give CI a
**separate Neon branch**, not the production database.

**Failure mode.** `getStore()` validates it synchronously and throws at cold
start — the endpoint returns an error rather than running without logging.
That is deliberate: spec §2 rule 6 requires every exchange to be logged.

---

## `PARENT_PASSWORD`

**What it does.** The single shared secret for `/api/parent`. Compared with a
constant-time hash comparison; five attempts per IP per 15 minutes.

**How to obtain.** Invent one. Long, random, stored in a password manager. It is
the only thing between the internet and a full transcript of a 7-year-old's
conversations.

**Where it goes.** Vercel only. It is never needed locally unless you are
developing the parent page.

**Failure mode.** If unset, `api/parent/auth.ts` compares against a random
per-process value: nobody can log in. It fails *closed*, not open.

---

## `SESSION_SECRET`

**What it does.** HMAC key for the parent session cookie
(`parent_session=<expiryMs>.<hmac-sha256>`, HttpOnly, Secure, SameSite=Strict,
12-hour TTL).

**Optional.** If unset it falls back to `PARENT_PASSWORD`.

**The consequence of omitting it:** the password *is* the cookie key, so
**changing the parent password invalidates every existing parent session** and
logs you out on every device. Setting a separate `SESSION_SECRET` decouples the
two, which matters because rotating the password is something you should be
willing to do casually.

**How to obtain.** `openssl rand -hex 32`, or any long random string. Different
from the password.

---

## `ALEXA_SKILL_ID`

**What it does.** When set, `src/alexa/verify.ts` compares the incoming
`applicationId` against it with a constant-time compare and rejects anything
else with HTTP 400. This is the check that stops someone else's skill (or a
replayed envelope from a different skill) reaching your pipeline. Signature and
timestamp verification run regardless.

**How to obtain.** Alexa developer console → your skill → the id shown as
`amzn1.ask.skill.xxxxxxxx-xxxx-...`. If you deployed with the ASK CLI, it is
also written into `.ask/ask-states.json` by `ask deploy`.

**Where it goes.** Vercel only.

**Failure mode if unset.** Verification still requires a valid Amazon
signature, so this is defence in depth, not the front door — but set it.

---

## `RESEND_API_KEY`, `ALERT_EMAIL`, `ALERT_FROM`

**What they do.** The alert transport for the logging watchdog (task T8,
`src/log/alert.ts`). When the parent transcript stops recording, something has
to say so out of band -- the whole failure mode is that the place you would look
is the place that is broken.

- `RESEND_API_KEY` -- a Resend API key (`resend.com` -> API Keys). Free tier is
  ample; this sends a handful of emails a year.
- `ALERT_EMAIL` -- the address alerts go to. JP's.
- `ALERT_FROM` -- the From address. Optional; defaults to `onboarding@resend.dev`,
  which Resend allows without domain verification. Set it to an address on a
  verified domain if you want the mail to survive a spam filter.

**Both `RESEND_API_KEY` and `ALERT_EMAIL` must be set** for email to be
attempted. Either one missing means no email.

**Blank counts as unset**, the same rule `envOr` applies in
`src/pipeline/anthropic.ts`. A dashboard row created with an empty value does
not enable the transport.

**Where they go.** Vercel (so the in-process watchdog can alert from the request
path) *and* GitHub Actions repo secrets (so the daily
`.github/workflows/watchdog.yml` cron can alert). Both, not either.

**Failure mode if unset.** `sendAlert` writes `console.error('[ALERT]', ...)`
instead. In Vercel that is visible in the platform log; in the cron job it is
visible in the run output and the job summary -- in both cases only to someone
who goes and looks, which is exactly the thing the watchdog exists to avoid
depending on. It degrades safely, but set them.

Alerts contain session ids, counts, timestamps and error text only -- never the
child's words or the assistant's replies (SPEC section 2 rule 6). That is
enforced by a test in `tests/unit/watchdog.test.ts`.

---

## Not environment variables

Two things people look for here and will not find:

- **Persona name, invocation name, session cap, blocklist, speech length cap,
  deadline** — these live in `config/policy.yaml`, are committed to the repo and
  loaded at cold start. Changing them is an edit + redeploy, not an env change.
  See `docs/OPERATIONS.md`.
- **The canned lines** — `src/pipeline/canned.ts`. Code, deliberately, so that
  changing the only unchecked speech in the system requires a commit and a
  review.

[^spend]: Claude Platform docs, *Workspaces* — <https://platform.claude.com/docs/en/manage-claude/workspaces> (Settings → Workspaces → Spend limits; limits cannot be set on the Default Workspace).
[^models]: Claude Platform docs, *Models overview* — <https://platform.claude.com/docs/en/models/overview>. Re-check this page at deploy time; it is the whole point of this footnote.
[^neon]: Neon docs FAQ, *Where can I find my DATABASE_URL in Neon?* — <https://neon.com/faqs/find-database-url-neon>.
