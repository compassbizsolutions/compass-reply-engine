# Reply Engine — Phase 1 MVP

The review-monitoring + AI auto-reply pipeline from the Compass "AI-Run Local Reputation
Engine" spec (Section 8, Phase 1). This is the first slice: connect a Google Business
Profile, detect new reviews, draft a reply in the business's tone, run an independent
safety check, and either auto-post it or hold it for the owner — no manual work once it's
running.

Not in this slice (see spec Sections 3–4, 8 for what comes next): the customer-facing
signup/dashboard app, Stripe checkout, the onboarding tone-quiz UI, Yelp/Facebook,
POS-triggered review requests, and the weekly summary email. This folder is the engine
those pieces will sit on top of.

## How it fits together

```
pollReviews.js  (scheduled, e.g. hourly)
  → googleBusinessProfile.js: fetch new reviews for every active business
  → reviews table: upsert (idempotent — safe to re-run)
  → for each new review → draftReply.js
      → llm.js assessSeverity(): checked BEFORE drafting, independent of star rating —
        catches a furious/scathing 3+ star review that shouldn't get an automated reply
      → llm.js draftReply(): draft a reply in the business's tone
      → llm.js safetyCheck(): a SEPARATE model call grades the draft
      → 1–2 stars, OR scathing text, OR safety check fails → hold for owner (status = 'flagged')
      → otherwise → postReply.js → googleBusinessProfile.js: post to Google, log it
```

Every step writes to `automation_log` — that table is what the monthly human spot-check
(spec Section 10) reviews, and what a future admin dashboard would show live.

## Setup

1. **Supabase project** — create one, then run `sql/001_init_schema.sql` in the SQL editor.
2. **Google Cloud project** — enable the Business Profile API, create OAuth credentials.
   (Confirm current API name/endpoints at build time — Google has restructured this API
   before; `src/googleBusinessProfile.js` has a note on this.)
3. **Anthropic API key** — console.anthropic.com.
4. `cp .env.example .env` and fill in all four values.
5. `npm install`
6. For each business you're piloting (manually, for now — see spec Section 8 Phase 2):
   - Insert a row into `businesses`
   - Insert a row into `tone_profiles` for it (tone, negative-review policy, sign-off, etc.)
   - Complete the Google OAuth flow once (manual for now) and insert the resulting tokens
     into `platform_connections`
7. `npm run poll` to run one polling cycle manually and confirm it works end to end.
8. Once confirmed, schedule it — see `workflows/README.md` for the cron/n8n setup.

## What still needs a human right now

Per the spec, Phase 1–2 still has a few things that aren't automated yet — this is
expected, not a gap in the code:

- **Pilot customer onboarding** (spec §8, Phase 2) — manually setting up the `businesses` /
  `tone_profiles` / `platform_connections` rows above, until the self-serve signup flow
  exists.
- **Reviewing held/flagged replies** — there's no dashboard yet; query `replies` where
  `held_for_review = true` and use `postReply.js`'s `postManuallyApproved(replyId)` to
  approve one by hand.
- **Monthly spot-check** (spec §10) — skim `automation_log` / posted replies periodically
  for tone or accuracy drift. This is the one recurring task worth keeping even once
  everything else is unattended.

## Next after this is validated

Straight from spec Section 8: Yelp/Facebook connections, POS/booking webhook →
`sendReviewRequest.js`, `weeklySummary.js`, and only then the self-serve signup/dashboard
and Stripe billing that turn this from "a pipeline I run for pilot customers" into
"a product people sign up for themselves."
