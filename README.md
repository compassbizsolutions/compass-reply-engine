# Reply Engine — Phase 1 MVP

The review-monitoring + AI auto-reply pipeline from the Compass "AI-Run Local Reputation
Engine" spec (Section 8, Phase 1). Connect Google Business Profile and/or Trustpilot,
detect new reviews, draft a reply in the business's tone, run an independent safety check,
and either auto-post it or hold it for the owner — no manual work once it's running.
Facebook reviews are fetched automatically too but always held for manual copy-paste
(Meta's API has no reply-posting endpoint at all), and Yelp reviews are entered by hand
through the dashboard (Yelp has no public API access for reviews, period) — both still go
through the same AI-drafting and safety-check pipeline as everything else.

Not in this slice (see spec Sections 3–4, 8 for what comes next): the customer-facing
signup/dashboard app, Stripe checkout, the onboarding tone-quiz UI, POS-triggered review
requests, and the weekly summary email. This folder is the engine those pieces will sit on
top of.

## Platform support at a glance

See `src/platforms.js` for the single source of truth on this — draftReply.js,
pollReviews.js, and dashboard.js all read capabilities from there rather than hardcoding
platform names.

| Platform   | Fetch reviews via API | Auto-post replies | Notes |
|------------|:---:|:---:|---|
| Google     | ✅ | ✅ | Full automation. |
| Trustpilot | ✅ | ✅ | Full automation, but requires the business to have their own Trustpilot Business account for the reply OAuth token. |
| Facebook   | ✅ | ❌ | Graph API has no reply endpoint for ratings/recommendations — never will, not a permissions issue. Held for manual copy every time. |
| Yelp       | ❌ | ❌ | No public API access at all (Partner API is invite-only, aimed at large reputation platforms). Entered manually via `/add-review` in the dashboard. |

## How it fits together

```
pollReviews.js  (scheduled, e.g. hourly)
  → src/platforms.js: fetch new reviews for every active business, per connected platform
    (google, trustpilot, facebook — everything with canFetch: true)
  → reviews table: upsert (idempotent — safe to re-run)
  Yelp reviews instead come in via dashboard.js's "Add a Yelp review manually" form,
  which calls draftAndHandleReply() directly — same pipeline, different entry point.
  → for each new review → draftReply.js
      → llm.js assessSeverity(): checked BEFORE drafting, independent of star rating —
        catches a furious/scathing 3+ star review that shouldn't get an automated reply
      → llm.js draftReply(): draft a reply in the business's tone
      → llm.js safetyCheck(): a SEPARATE model call grades the draft
      → 1–2 stars, OR scathing text, OR safety check fails, OR the platform has no posting
        API at all (Facebook/Yelp) → hold for owner (status = 'flagged')
      → otherwise → postReply.js → src/platforms.js: post to Google/Trustpilot, log it
```

Every step writes to `automation_log` — that table is what the monthly human spot-check
(spec Section 10) reviews, and what a future admin dashboard would show live.

## Setup

1. **Supabase project** — create one, then run `sql/001_init_schema.sql` followed by
   `sql/002_multi_platform.sql` in the SQL editor.
2. **Google Cloud project** — enable the Business Profile API, create OAuth credentials.
   (Confirm current API name/endpoints at build time — Google has restructured this API
   before; `src/googleBusinessProfile.js` has a note on this.)
3. **Trustpilot** (optional, only if a pilot business uses it) — register at
   business.trustpilot.com for API access, get an API key plus an OAuth client id/secret.
4. **Facebook** (optional) — create a Meta developer app, get a long-lived Page access
   token per business (`pages_read_engagement` scope is enough — fetch-only).
5. **Anthropic API key** — console.anthropic.com.
6. `cp .env.example .env` and fill in whichever values apply to the platforms you're using.
7. `npm install`
8. For each business you're piloting (manually, for now — see spec Section 8 Phase 2):
   - Insert a row into `businesses`
   - Insert a row into `tone_profiles` for it (tone, negative-review policy, sign-off, etc.)
   - For Google/Trustpilot/Facebook: complete the OAuth flow (or grab a Page token) once,
     manually, and insert the resulting tokens into `platform_connections`
   - For Yelp: nothing to connect — reviews get added via the dashboard's
     "Add a Yelp review manually" link as they come in
9. `npm run poll` to run one polling cycle manually and confirm it works end to end.
10. Once confirmed, schedule it — see `workflows/README.md` for the cron/n8n setup.

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
