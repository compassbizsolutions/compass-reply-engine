# Orchestration (n8n)

Phase 1 needs exactly one scheduled job: run `pollReviews.js` regularly. Everything else
(drafting, safety check, posting) happens inside that script's call chain, so there's
nothing else to schedule yet — Phase 2 adds the review-request and weekly-summary jobs
described below.

## Option A — cron (simplest, good enough for Phase 1)

No n8n needed yet. On any server/VM that stays running (a small droplet, a Render/Railway
cron job, etc.):

```
*/60 * * * * cd /path/to/reply-engine && node scripts/pollReviews.js >> logs/poll.log 2>&1
```

Runs once an hour, matching the spec's "poll every 1–2 hours" target. Cheapest possible
Phase 1 setup — no extra tool to configure or pay for.

## Option B — n8n (recommended once you add the review-request and weekly-summary jobs)

n8n gives you a visual view of failures across all three pipelines (Section 5 of the spec)
without reading logs, which matters once you have real customers depending on this running
unattended. Rough workflow shape once you're there:

1. **Review poll & reply** — Schedule Trigger (every 1 hr) → Execute Command node running
   `node scripts/pollReviews.js` → on failure, an alert (email/Slack) to you, not the customer.
2. **Review request send** (Phase 2) — Webhook node listening for the POS/booking tool's
   "completed transaction" event → Execute Command running a `sendReviewRequest.js` script
   (not yet built — next after Phase 1 is validated).
3. **Weekly summary email** (Phase 2) — Schedule Trigger (Mondays 8am) → Execute Command
   running a `weeklySummary.js` script (not yet built).

Self-host n8n (Docker, one container) rather than n8n Cloud to keep this in the same
~$5–20/mo infra cost the spec's unit economics assume.

## Failure handling

`pollReviews.js` already logs every action (`automation_log` table) and every error to
stdout/stderr. Point whichever scheduler you use (cron + a log-watching service like
healthchecks.io, or n8n's built-in error workflow) at "did this run in the last 2 hours,
did it exit non-zero" — that single check catches the large majority of things that could
go wrong unattended.
