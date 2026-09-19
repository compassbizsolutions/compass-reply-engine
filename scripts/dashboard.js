#!/usr/bin/env node
// A small local review-queue dashboard — NOT the customer-facing product (that's Phase 2's
// self-serve signup/dashboard). This is just for you: a page listing every reply the
// pipeline held for review, with the original review beside it and one-click:
//   - "Approve & Post" for platforms with a real posting API (Google, Trustpilot) — this
//     actually calls out and posts the reply.
//   - "Copy Reply" for platforms with no posting API at all (Facebook, Yelp) — copies the
//     drafted text to your clipboard and marks it as handled once you confirm you sent it.
//   - "Dismiss" (marks the review as skipped so it stops showing here) on any of them.
//
// Also includes a manual-entry form (/add-review) for Yelp, since there's no API access to
// poll Yelp reviews automatically — paste one in and it goes through the same AI-drafting and
// safety-check pipeline as everything else.
//
// Run with: npm run dashboard, then open http://localhost:3001

require('dotenv').config();
const express = require('express');
const { supabase } = require('../src/db');
const { postManuallyApproved, markManuallySent } = require('./postReply');
const { draftAndHandleReply } = require('./draftReply');
const { PLATFORMS } = require('../src/platforms');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;

app.use(express.urlencoded({ extended: true }));

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function starDisplay(rating) {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

const PAGE_STYLES = `
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f8; margin: 0; padding: 2rem; color: #1a1a1a; }
    h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
    .subtitle { color: #666; margin-top: 0; margin-bottom: 1.5rem; font-size: 0.9rem; }
    .empty { background: white; border-radius: 8px; padding: 2rem; text-align: center; color: #666; }
    .card { background: white; border-radius: 8px; padding: 1.25rem 1.5rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); max-width: 680px; }
    .card-header { display: flex; gap: 0.75rem; align-items: baseline; margin-bottom: 0.5rem; flex-wrap: wrap; }
    .business { font-weight: 600; }
    .platform-tag { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; background: #edf1ff; color: #3b5bdb; padding: 0.1rem 0.45rem; border-radius: 4px; font-weight: 700; }
    .stars { color: #f5a623; letter-spacing: 1px; }
    .reviewer { color: #666; font-size: 0.9rem; }
    .review-text { font-style: italic; color: #333; border-left: 3px solid #ddd; padding-left: 0.75rem; margin: 0.75rem 0; }
    .draft-box { background: #f0f4ff; border-radius: 6px; padding: 0.75rem 1rem; margin: 0.75rem 0; }
    .draft-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #3b5bdb; font-weight: 600; margin-bottom: 0.25rem; }
    .draft-text { margin: 0; }
    .notes { font-size: 0.85rem; margin: 0.5rem 0 1rem; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 600; font-size: 0.75rem; margin-right: 0.5rem; }
    .badge-pass { background: #d3f9d8; color: #2b8a3e; }
    .badge-fail { background: #ffe3e3; color: #c92a2a; }
    .badge-manual { background: #fff3bf; color: #7d5a00; }
    .notes-text { color: #888; }
    .manual-note { font-size: 0.82rem; color: #7d5a00; background: #fff9db; border-radius: 6px; padding: 0.5rem 0.75rem; margin: 0.5rem 0; }
    .actions { display: inline-block; margin-right: 0.5rem; margin-top: 0.5rem; }
    .btn { border: none; border-radius: 6px; padding: 0.5rem 1rem; font-size: 0.9rem; cursor: pointer; font-weight: 600; }
    .btn-approve { background: #2b8a3e; color: white; }
    .btn-approve:hover { background: #237032; }
    .btn-copy { background: #3b5bdb; color: white; }
    .btn-copy:hover { background: #2f4bb3; }
    .btn-dismiss { background: #e9ecef; color: #495057; }
    .btn-dismiss:hover { background: #dee2e6; }
    .banner { max-width: 680px; padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.9rem; }
    .banner-error { background: #fff3bf; color: #7d5a00; border: 1px solid #ffe066; }
    .banner-success { background: #d3f9d8; color: #2b8a3e; border: 1px solid #b2f2bb; }
    .top-nav { max-width: 680px; margin-bottom: 1.25rem; }
    .top-nav a { color: #3b5bdb; text-decoration: none; font-size: 0.9rem; font-weight: 600; }
    .top-nav a:hover { text-decoration: underline; }
    form.add-review-form { background: white; border-radius: 8px; padding: 1.5rem; max-width: 500px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    form.add-review-form label { display: block; font-size: 0.85rem; font-weight: 600; margin: 0.85rem 0 0.3rem; }
    form.add-review-form input, form.add-review-form select, form.add-review-form textarea {
      width: 100%; box-sizing: border-box; padding: 0.5rem; border: 1px solid #dcdfe4; border-radius: 6px; font-size: 0.9rem; font-family: inherit;
    }
    form.add-review-form textarea { min-height: 90px; resize: vertical; }
    form.add-review-form button { margin-top: 1.25rem; }
`;

app.get('/', async (req, res) => {
  const banner = req.query.error
    ? `<div class="banner banner-error">Couldn't post that reply: ${escapeHtml(req.query.error)}</div>`
    : req.query.posted
      ? `<div class="banner banner-success">Reply posted.</div>`
      : req.query.sent
        ? `<div class="banner banner-success">Marked as sent.</div>`
        : req.query.added
          ? `<div class="banner banner-success">Review added — AI is drafting a reply now.</div>`
          : '';

  const { data: replies, error } = await supabase
    .from('replies')
    .select('*, reviews!inner(*, businesses!inner(name))')
    .eq('held_for_review', true)
    .eq('posted', false)
    .neq('reviews.status', 'skipped')
    .order('created_at', { ascending: false });

  if (error) {
    res.status(500).send(`<p>Failed to load queue: ${escapeHtml(error.message)}</p>`);
    return;
  }

  const rows = (replies || [])
    .map((reply) => {
      const review = reply.reviews;
      const business = review.businesses;
      const platform = PLATFORMS[review.platform];
      const platformLabel = platform ? platform.label : review.platform;

      const actionButton = platform && platform.canAutoPost
        ? `<form class="actions" method="POST" action="/approve/${reply.id}">
             <button type="submit" class="btn btn-approve">Approve & Post</button>
           </form>`
        : `<form class="actions" method="POST" action="/mark-sent/${reply.id}"
                 onsubmit="event.preventDefault(); const f = event.target; const go = () => f.submit();
                           if (navigator.clipboard) { navigator.clipboard.writeText(${JSON.stringify(reply.draft_text)}).then(go, go); } else { go(); }">
             <button type="submit" class="btn btn-copy">Copy Reply &amp; Mark Sent</button>
           </form>`;

      const manualNote = platform && !platform.canAutoPost
        ? `<div class="manual-note">${escapeHtml(platformLabel)} has no reply-posting API — this copies the draft to your clipboard. Paste it into ${escapeHtml(platformLabel)} yourself, then click to mark it handled.</div>`
        : '';

      return `
      <div class="card">
        <div class="card-header">
          <span class="business">${escapeHtml(business.name)}</span>
          <span class="platform-tag">${escapeHtml(platformLabel)}</span>
          <span class="stars">${starDisplay(review.rating)}</span>
          <span class="reviewer">${escapeHtml(review.reviewer_name || 'Anonymous')}</span>
        </div>
        <p class="review-text">"${escapeHtml(review.review_text || '(no written comment)')}"</p>
        <div class="draft-box">
          <div class="draft-label">AI-drafted reply</div>
          <p class="draft-text">${escapeHtml(reply.draft_text)}</p>
        </div>
        <div class="notes">
          <span class="badge ${reply.safety_check_passed ? 'badge-pass' : 'badge-fail'}">
            Safety check: ${reply.safety_check_passed ? 'PASS' : 'FAIL'}
          </span>
          <span class="notes-text">${escapeHtml(reply.safety_check_notes || '')}</span>
        </div>
        ${manualNote}
        ${actionButton}
        <form class="actions" method="POST" action="/dismiss/${review.id}">
          <button type="submit" class="btn btn-dismiss">Dismiss (I'll respond myself)</button>
        </form>
      </div>`;
    })
    .join('\n');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reply Engine — Review Queue</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="top-nav"><a href="/add-review">+ Add a Yelp review manually</a></div>
  <h1>Review Queue</h1>
  <p class="subtitle">${(replies || []).length} item(s) waiting for your decision</p>
  ${banner}
  ${rows || '<div class="empty">Nothing waiting right now — the queue is clear.</div>'}
</body>
</html>`);
});

app.get('/add-review', async (req, res) => {
  const { data: businesses, error } = await supabase.from('businesses').select('id, name').order('name');

  if (error) {
    res.status(500).send(`<p>Failed to load businesses: ${escapeHtml(error.message)}</p>`);
    return;
  }

  const options = (businesses || [])
    .map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`)
    .join('\n');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Add a Yelp Review — Reply Engine</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="top-nav"><a href="/">&larr; Back to queue</a></div>
  <h1>Add a Yelp review</h1>
  <p class="subtitle">Yelp doesn't give us API access to pull reviews automatically — paste one in here and it'll go through the same AI-drafting and safety-check pipeline as everything else.</p>
  <form class="add-review-form" method="POST" action="/add-review">
    <label for="business_id">Business</label>
    <select id="business_id" name="business_id" required>
      <option value="" disabled selected>Select a business</option>
      ${options}
    </select>

    <label for="reviewer_name">Reviewer name</label>
    <input id="reviewer_name" name="reviewer_name" type="text" placeholder="e.g. Sam T.">

    <label for="rating">Star rating</label>
    <select id="rating" name="rating" required>
      <option value="5">5 stars</option>
      <option value="4">4 stars</option>
      <option value="3">3 stars</option>
      <option value="2">2 stars</option>
      <option value="1">1 star</option>
    </select>

    <label for="review_text">Review text</label>
    <textarea id="review_text" name="review_text" placeholder="Paste the review text from Yelp here"></textarea>

    <button type="submit" class="btn btn-approve">Add & Draft Reply</button>
  </form>
</body>
</html>`);
});

app.post('/add-review', async (req, res) => {
  const { business_id, reviewer_name, rating, review_text } = req.body;

  if (!business_id || !rating) {
    res.redirect('/add-review');
    return;
  }

  const { data: review, error } = await supabase
    .from('reviews')
    .insert({
      business_id,
      platform: 'yelp',
      entry_method: 'manual',
      external_review_id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      reviewer_name: reviewer_name || 'Anonymous',
      rating: Number(rating),
      review_text: review_text || '',
      review_created_at: new Date().toISOString(),
      status: 'pending'
    })
    .select()
    .single();

  if (error) {
    res.status(500).send(`<p>Failed to save review: ${escapeHtml(error.message)}</p>`);
    return;
  }

  try {
    await draftAndHandleReply(review, business_id);
  } catch (err) {
    console.error('[dashboard] draft failed for manually-added review:', err.message);
  }

  res.redirect('/?added=1');
});

app.post('/approve/:replyId', async (req, res) => {
  let result;
  try {
    result = await postManuallyApproved(req.params.replyId);
  } catch (err) {
    console.error('[dashboard] approve failed:', err.message);
    result = { success: false, reason: err.message };
  }

  if (result.success) {
    res.redirect('/?posted=1');
  } else {
    res.redirect(`/?error=${encodeURIComponent(result.reason || 'unknown error')}`);
  }
});

app.post('/mark-sent/:replyId', async (req, res) => {
  let result;
  try {
    result = await markManuallySent(req.params.replyId);
  } catch (err) {
    console.error('[dashboard] mark-sent failed:', err.message);
    result = { success: false, reason: err.message };
  }

  if (result.success) {
    res.redirect('/?sent=1');
  } else {
    res.redirect(`/?error=${encodeURIComponent(result.reason || 'unknown error')}`);
  }
});

app.post('/dismiss/:reviewId', async (req, res) => {
  await supabase.from('reviews').update({ status: 'skipped' }).eq('id', req.params.reviewId);
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`[dashboard] running at http://localhost:${PORT}`);
});
