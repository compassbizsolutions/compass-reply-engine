#!/usr/bin/env node
// A small local review-queue dashboard — NOT the customer-facing product (that's Phase 2's
// self-serve signup/dashboard). This is just for you: a page listing every reply the
// pipeline held for review, with the original review beside it and one-click Approve
// (posts it, using the same postApprovedReply path the automated pipeline uses) or
// Dismiss (marks the review as skipped so it stops showing here).
//
// Run with: npm run dashboard, then open http://localhost:3001

require('dotenv').config();
const express = require('express');
const { supabase } = require('../src/db');
const { postManuallyApproved } = require('./postReply');

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

app.get('/', async (req, res) => {
  const banner = req.query.error
    ? `<div class="banner banner-error">Couldn't post that reply: ${escapeHtml(req.query.error)}</div>`
    : req.query.posted
      ? `<div class="banner banner-success">Reply posted.</div>`
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
      return `
      <div class="card">
        <div class="card-header">
          <span class="business">${escapeHtml(business.name)}</span>
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
        <form class="actions" method="POST" action="/approve/${reply.id}">
          <button type="submit" class="btn btn-approve">Approve & Post</button>
        </form>
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
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f8; margin: 0; padding: 2rem; color: #1a1a1a; }
    h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
    .subtitle { color: #666; margin-top: 0; margin-bottom: 1.5rem; font-size: 0.9rem; }
    .empty { background: white; border-radius: 8px; padding: 2rem; text-align: center; color: #666; }
    .card { background: white; border-radius: 8px; padding: 1.25rem 1.5rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); max-width: 680px; }
    .card-header { display: flex; gap: 0.75rem; align-items: baseline; margin-bottom: 0.5rem; flex-wrap: wrap; }
    .business { font-weight: 600; }
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
    .notes-text { color: #888; }
    .actions { display: inline-block; margin-right: 0.5rem; margin-top: 0.5rem; }
    .btn { border: none; border-radius: 6px; padding: 0.5rem 1rem; font-size: 0.9rem; cursor: pointer; font-weight: 600; }
    .btn-approve { background: #2b8a3e; color: white; }
    .btn-approve:hover { background: #237032; }
    .btn-dismiss { background: #e9ecef; color: #495057; }
    .btn-dismiss:hover { background: #dee2e6; }
    .banner { max-width: 680px; padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.9rem; }
    .banner-error { background: #fff3bf; color: #7d5a00; border: 1px solid #ffe066; }
    .banner-success { background: #d3f9d8; color: #2b8a3e; border: 1px solid #b2f2bb; }
  </style>
</head>
<body>
  <h1>Review Queue</h1>
  <p class="subtitle">${(replies || []).length} item(s) waiting for your decision</p>
  ${banner}
  ${rows || '<div class="empty">Nothing waiting right now — the queue is clear.</div>'}
</body>
</html>`);
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

app.post('/dismiss/:reviewId', async (req, res) => {
  await supabase.from('reviews').update({ status: 'skipped' }).eq('id', req.params.reviewId);
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`[dashboard] running at http://localhost:${PORT}`);
});
