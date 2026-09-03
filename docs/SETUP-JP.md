# Setting this up — JP's checklist

Hi JP. This is the whole setup, in order, start to finish. Work top to bottom
and tick the boxes. Every step ends with **How you know it worked**, so you are
never guessing whether to move on.

Set aside about two hours. Nothing here is dangerous or irreversible, and
nothing costs money except the Anthropic API usage, which you will cap in
step 5.

**A note about menu names before you start.** Amazon rearranges the Alexa app
and the developer console fairly often, and Amazon's own help pages block
automated reading, so a few of the paths below could not be verified against a
current Amazon page. Those are marked **⚠ path not verified**. If a menu name
doesn't match what you see, the setting is almost certainly still there under a
slightly different heading — look under **Settings**, use the app's search box,
and don't force a match. A wrong click path is worse than a shrug.

**Words used here**

| Word | What it means |
|---|---|
| **Skill** | An add-on for Alexa. Ours is private — only your Amazon account can use it. |
| **Endpoint** | The web address Amazon sends the child's words to. Ours lives on Vercel. |
| **Vercel** | The service that runs our code. Free tier is plenty. |
| **Neon** | The database that stores every conversation so you can read it. |
| **Environment variable** | A named secret (a password, a key) you paste into Vercel instead of into the code. |
| **Build the model** | Amazon compiling the list of things the skill can hear. Takes a minute or two. |

---

## Step 1 — Get the Dot off the kids' profile

Custom development skills are hidden under an Amazon Kids profile. The Dot has
to run on your regular adult Amazon account, with the parental controls in
step 2 doing the protecting instead. That is a deliberate trade, and step 2 is
the part that pays for it — don't skip it.

- [ ] **1.1** Open the Alexa app on your phone, signed in as **you** (the same
      Amazon account you will use for the developer console in step 3).
- [ ] **1.2** Find the Dot in the app's device list and turn **Amazon Kids** off
      for it. Amazon documents this as a per-device setting you toggle from the
      device's settings screen, and also lets you do it by voice on the device
      itself.[^kids] ⚠ **path not verified** — Amazon's help page could not be
      read automatically. Look for the Dot under the devices list, open its
      settings, and find the Amazon Kids toggle there.
- [ ] **1.3** Confirm the Dot is registered to your account, not to a child
      profile.

**How you know it worked.** Say to the Dot: *"Alexa, what time is it?"* and then
*"Alexa, open the Amazon Kids menu."* On an adult profile the second one gets a
normal "I can't do that" style answer, not a kid-voice response. More reliably:
in the app, the Dot appears under your own account's devices with no kid badge.

---

## Step 2 — Lock down everything else Alexa can do

The custom skill is the safe part. Regular Alexa is the part that needs
fencing. Do all six.

| # | Setting | Where (verify against what you actually see) | Done |
|---|---|---|---|
| 2.1 | **Explicit language filter — ON** | A widely-cited path is **Settings → Music & Podcasts → Explicit Language Filter**. Amazon also documents turning it on by voice: *"Alexa, turn on the explicit filter."*[^explicit] ⚠ path not verified | [ ] |
| 2.2 | **Voice purchasing — OFF (or set a PIN)** | Commonly documented as **Settings → Account Settings → Voice Purchasing**, where you can toggle "Purchase by voice" off or set a 4-digit code.[^purchasing] Off is better than a PIN here. ⚠ path not verified | [ ] |
| 2.3 | **Drop In — OFF for this device** | Per-device communications setting; on the app side it is reached through the device's own settings or through **Communications** settings.[^dropin] Set to **Off**, not "My Household". ⚠ path not verified | [ ] |
| 2.4 | **Calling & messaging — OFF** | In the app's **Communications** section, disable calling and messaging for this device / account. ⚠ path not verified | [ ] |
| 2.5 | **Alexa communication disabled** | Same area as 2.3/2.4 — the master switch that stops the Dot being used to reach anyone. ⚠ path not verified | [ ] |
| 2.6 | **Voice recordings** | Under **More → Settings → Alexa Privacy** you can review voice history and choose automatic deletion.[^privacy] Decide what you want: auto-delete after 3 months is a reasonable default. Note that Amazon has changed what is optional here more than once, so read the screen rather than trusting this line. ⚠ path not verified | [ ] |

### The honest gap

**There is no setting that stops a child enabling other Alexa skills by voice.**
She can say "Alexa, enable *[skill name]*" and Alexa will do it, and nothing in
our system sees that or can prevent it. This is a limitation of Alexa itself,
not of our build, and it is why the Dot is not a fire-and-forget device.

The fix is a habit, not a toggle: **every week or two, open the Alexa app and
look at your enabled skills list** (commonly **More → Skills & Games → Your
Skills**; ⚠ path not verified) and remove anything you didn't add. The parent
page carries a standing reminder box saying exactly this.

**How you know step 2 worked.** Walk the Dot through it out loud: ask it to buy
something (it should refuse or ask for a code), ask it to call someone (it
should refuse or be unable), and ask it to drop in on another device (nothing
should happen).

---

## Step 3 — Create an Amazon developer account

- [ ] **3.1** Go to <https://developer.amazon.com> and sign in **with the exact
      same Amazon login the Dot uses**. This is the single most important detail
      in the whole setup: it is what makes the private skill show up on your Dot
      automatically without ever publishing it.
- [ ] **3.2** Accept the developer agreement. It's free.
- [ ] **3.3** Open the Alexa developer console at
      <https://developer.amazon.com/alexa/console/ask>.

**How you know it worked.** The console loads and shows a **Skills** list —
empty is fine, that's the next step.

---

## Step 4 — Create the skill

You can do this in the browser or from the command line. The browser route is
described here; the command-line route is in `docs/T1-NOTES.md` §1 and is
faster if you're comfortable in a terminal.

- [ ] **4.1** In the console's **Skills** tab, click **Create Skill**.[^create]
- [ ] **4.2** On the **Name and Locale** page: name it something for your own
      eyes only (e.g. `Helper`), choose **English (US)** as the primary locale.
      Click **Next**.
- [ ] **4.3** On the **Experience, Model, Hosting** page: choose your type of
      experience, then under **Choose a model** pick **Custom**, and under
      **Hosting services** pick **Provision your own**.[^create] This is what
      tells Amazon the code lives on your Vercel account, not on Amazon's.
      Click **Next**.
- [ ] **4.4** Pick the plainest template offered (start from scratch), then
      **Create Skill**. Wait for the build-successful notice.
- [ ] **4.5** Load our interaction model. Two ways:
      - **Command line (recommended):** follow `docs/T1-NOTES.md` §1 —
        `npm install -g ask-cli`, `ask configure` (sign in with the *same*
        Amazon account), then `ask deploy --target skill-metadata`. The
        `ask-resources.json` file at the repo root is already set up to point
        at `skill-package/`.
      - **Browser:** in the skill's **Build** tab, open the JSON editor for the
        interaction model and paste the contents of
        `skill-package/interactionModels/custom/en-US.json`, then **Save Model**
        and **Build Model**.
- [ ] **4.6** Copy the skill's id (it looks like
      `amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-...`). You'll paste it into Vercel in
      step 7. If you used the command line it is also in
      `.ask/ask-states.json`.

**Heads up on one known snag.** Our model includes a sample utterance that is
just the slot on its own — the thing that lets her say *anything* and be
understood rather than hearing "I didn't quite catch that". Amazon's build has
historically sometimes rejected that. If the build fails with a message about a
sample utterance needing at least one word besides the slot, `docs/T1-NOTES.md`
§2 tells you exactly what to remove and what to keep. Record the outcome in the
table at the end of that section.

**How you know it worked.** The **Build Model** step finishes with
**Build Successful**. A failed build says so loudly and won't let you continue.

---

## Step 5 — Anthropic API key and a spending cap

- [ ] **5.1** In the Claude Console, create a **workspace** for this project
      (Settings → Workspaces). Do this before making the key — spend limits
      cannot be set on the Default Workspace.[^spend]
- [ ] **5.2** In that workspace, open the **Spend limits** tab and set a monthly
      cap you'd be comfortable seeing on a statement, plus an alert threshold
      below it.[^spend] This is the single control that turns "a child talked to
      it for six hours" from a bill into a shrug.
- [ ] **5.3** Create an API key inside that workspace (**Settings → API keys**).
      Copy it once — it is not shown again.
- [ ] **5.4** Don't paste it anywhere yet. It goes into Vercel in step 7, and
      **nowhere else** — never into a file in the repo, never into a chat, never
      into the Alexa console.

**How you know it worked.** The Spend limits tab shows your cap, and you have a
key beginning `sk-ant-` in your password manager.

---

## Step 6 — Create the database

- [ ] **6.1** At <https://console.neon.tech>, create a project. The free tier is
      more than enough.
- [ ] **6.2** On the project dashboard click **Connect**, choose the branch,
      compute, database and role, and **copy the connection string**. Leave
      **connection pooling on** — our code runs as serverless functions and
      needs the pooled string.[^neon]
- [ ] **6.3** That string contains a password in plain text. Treat it like one.
- [ ] **6.4** Create the tables. From the repo on your laptop:

      ```bash
      npm install
      cp .env.example .env.local
      # paste the connection string into DATABASE_URL in .env.local
      npm run migrate
      ```

      It is safe to run more than once — every statement is
      "create if it doesn't already exist".

**How you know it worked.** `npm run migrate` prints one line per statement and
exits without an error. In the Neon console's table browser you can see three
tables: `sessions`, `exchanges`, `user_memory`.

---

## Step 7 — Deploy to Vercel

- [ ] **7.1** At <https://vercel.com>, create a project and connect this git
      repository. Accept the detected settings; `vercel.json` in the repo
      already sets what matters (the Alexa function gets a 10-second limit,
      which it needs).
- [ ] **7.2** In the project's **Settings → Environment Variables**, add each
      variable from `docs/ENV.md`, for Production (and Preview, if you'll use
      it):

      | Variable | Value |
      |---|---|
      | `ANTHROPIC_API_KEY` | the key from step 5 |
      | `MODEL_GATE` | the newest Haiku-class model id — **check the current list first** |
      | `MODEL_GEN` | the newest Sonnet-class model id — **check the current list first** |
      | `DATABASE_URL` | the Neon string from step 6 |
      | `PARENT_PASSWORD` | a long random password you invent, for the parent page |
      | `SESSION_SECRET` | a *different* long random string (recommended) |
      | `ALEXA_SKILL_ID` | the skill id from step 4.6 |

      **On the two model ids:** the code has built-in defaults, but they were
      written from possibly-out-of-date knowledge and one of them is already
      behind. `docs/ENV.md` explains this and points at the live model list.
      Set both explicitly. If you get them wrong the assistant is harmless — it
      just says "my thinking got a little tangled" to everything.

- [ ] **7.3** Deploy. Wait for the green build.
- [ ] **7.4** Copy the deployment URL (`https://something.vercel.app`).
- [ ] **7.5** Check the parent page loads: visit
      `https://something.vercel.app/api/parent` and log in with
      `PARENT_PASSWORD`. It will be empty — no conversations yet.

**How you know it worked.** The Vercel build is green, and the parent page shows
you a login form and then an empty review page. If the login form never accepts
your password, `PARENT_PASSWORD` didn't get saved — re-add it and redeploy
(Vercel does not apply new environment variables to an existing deployment).

---

## Step 8 — Point the skill at your endpoint

- [ ] **8.1** In the Alexa developer console, open your skill and go to the
      **Endpoint** section of the **Build** tab.
- [ ] **8.2** Choose **HTTPS** (not AWS Lambda).
- [ ] **8.3** In the **Default Region** field paste your endpoint:
      `https://something.vercel.app/api/alexa` — note the `/api/alexa` on the
      end; the bare domain will not work.
- [ ] **8.4** From the certificate dropdown for that region, choose
      **"My development endpoint is a sub-domain of a domain that has a wildcard
      certificate from a certificate authority."**[^cert] Vercel's certificate
      qualifies. Do not choose the self-signed option.
- [ ] **8.5** **Save Endpoints**, then **Build Model** again.
- [ ] **8.6** Go to the **Test** tab. The dropdown at the top reads **"Test is
      disabled for this skill"** with **Off** selected — change it to
      **Development**.[^test] Only one stage can be enabled at a time; that's
      fine, Development is the one we want forever. **Never submit this skill
      for certification.**
- [ ] **8.7** Walk over to the Dot and say: **"Alexa, open my helper."**
      (If you changed `invocationName` in `config/policy.yaml`, say that
      instead.)

**How you know it worked.** The Dot answers in Alexa's voice with the greeting
line — *"Hi there! I'm Helper. Want to ask me something, hear a story, or
practice some math?"* — and the light ring stays on, waiting for you.

**If it doesn't:**

| What you hear | What it usually means |
|---|---|
| "I'm not sure how to help with that" | The skill isn't enabled for testing (8.6), or the invocation name doesn't match `config/policy.yaml`. |
| "There was a problem with the requested skill's response" | Your endpoint returned an error. Check the Vercel function logs. Most common cause: a missing or wrong `DATABASE_URL`. |
| The greeting, then silence on every question | The model ids are wrong. You'd also hear the `TIMEOUT` line — "my thinking got a little tangled" — on everything. Fix `MODEL_GATE` / `MODEL_GEN` and redeploy. |
| Nothing at all | The Dot is on a different Amazon account than the developer console. |

---

## Step 9 — Run the acceptance script

- [ ] **9.1** Before this, confirm the red-team test suite passes 100% against
      the deployed build (`npm run redteam`). That is the deploy gate, and it
      is not optional. If `tests/redteam/` isn't in the repo yet, it hasn't
      shipped — stop and wait for it.
- [ ] **9.2** Open the parent page on a laptop, stand near the Dot with your
      phone, and work through **`docs/ACCEPTANCE-SCRIPT.md`** out loud.
- [ ] **9.3** Read and approve the canned lines in `src/pipeline/canned.ts`.
      Those eleven groups of sentences are the **only** words in the system that
      no automated check ever reviews. If a single one of them isn't something
      you want said to your daughter, change it before she uses the device.
- [ ] **9.4** Sign off at the bottom of the acceptance script.

**How you know it worked.** Every row of the acceptance script is ticked, every
turn appears on the parent page, and you'd be comfortable leaving the room.

---

[^kids]: Amazon Customer Service, *Turn Amazon Kids on Alexa On or Off Using the Alexa App* — <https://www.amazon.com/gp/help/customer/display.html?nodeId=GGZG3G9JNB7XWEYX> (page found via search; Amazon blocks automated retrieval, so the exact in-app path could not be transcribed). See also *Turn Amazon Kids on Alexa On or Off Using Your Echo Device with a Screen* — <https://www.amazon.com/gp/help/customer/display.html?nodeId=GG8EUFJXUNXRF8VZ>.
[^explicit]: Amazon Customer Service, *Turn Explicit Filtering On or Off in the Alexa App* — <https://www.amazon.com/gp/help/customer/display.html?nodeId=GVPX5E42H7X2WBLE>, and *Turn Explicit Filtering On or Off with Your Voice* — <https://www.amazon.com/gp/help/customer/display.html?nodeId=G7VZZWWFGTYFSF57>. The "Settings → Music & Podcasts" path is from Protect Young Eyes, *Amazon Echo Parental Controls* — <https://www.protectyoungeyes.com/devices/amazon-echo-parental-controls> (third-party, undated).
[^purchasing]: Amazon Customer Service, *Turn Alexa Voice Purchasing On or Off* — <https://www.amazon.com/gp/help/customer/display.html?nodeId=GPUCQ6PMPMENG8FA>. The "Settings → Account Settings → Voice Purchasing" path is from Protect Young Eyes (above), third-party and undated.
[^dropin]: Protect Young Eyes, *Amazon Echo Parental Controls* — <https://www.protectyoungeyes.com/devices/amazon-echo-parental-controls>. Note that this same page gives two different app navigation patterns for different settings (a top-left hamburger menu and a bottom-right "More" tab), which is itself evidence the app has been redesigned since parts of it were written.
[^privacy]: Amazon Customer Service, *Change Your Alexa Privacy Settings* — <https://www.amazon.com/gp/help/customer/display.html?nodeId=GVSMLJAYMSUTJF2S>, and *Personalize your Alexa Privacy Settings* — <https://www.amazon.com/b?node=23608614011>. Amazon has changed the available voice-recording options more than once; read the screen.
[^create]: Alexa Skills Kit docs, *Create a skill and choose the interaction model* — <https://developer.amazon.com/en-US/docs/alexa/devconsole/create-a-skill-and-choose-the-interaction-model.html>. **Verified** — the "Name and Locale" page, the "Experience, Model, Hosting" page, "Choose a model → Custom" and "Hosting services → Provision your own" labels are quoted from this page.
[^cert]: Alexa Skills Kit docs, *Host a custom skill as a web service* — <https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html>. **Verified** — the wildcard-certificate wording is quoted from this page.
[^test]: Alexa Skills Kit docs, *Test your skill* — <https://developer.amazon.com/en-US/docs/alexa/devconsole/test-your-skill.html>. **Verified** — the "Test is disabled for this skill" dropdown and its Off / Development / Live options are quoted from this page.
[^spend]: Claude Platform docs, *Workspaces* — <https://platform.claude.com/docs/en/manage-claude/workspaces>. **Verified** — Settings → Workspaces → Spend limits, and the note that the Default Workspace cannot have limits.
[^neon]: Neon docs FAQ, *Where can I find my DATABASE_URL in Neon?* — <https://neon.com/faqs/find-database-url-neon>. **Verified** — the "Connect" button on the project dashboard and the pooled-connection guidance.
