// Phase 1 pipeline, step 3: post an approved (safety-check-passed, not held) reply back to
// whichever platform the review came from, and log the result. Also exposes
// postManuallyApproved() for the dashboard's "approve this held reply" button — same posting
// logic, different entry trigger.
//
// Both functions return { success, reason } so callers (the dashboard especially) can show
// the person WHY a post attempt did nothing, instead of it looking like the button is broken.
//
// Only ever called for platforms where PLATFORMS[platform].canAutoPost is true (google,
// trustpilot) — draftReply.js already forces facebook/yelp reviews to hold instead of reaching
// this path. postApprovedReply still guards against it directly below, in case something calls
// in from elsewhere later.

const { supabase, logAction } = require('../src/db');
const { PLATFORMS } = require('../src/platforms');

async function postApprovedReply(review, reply, businessId) {
  const platform = PLATFORMS[review.platform];

  if (!platform || !platform.canAutoPost) {
    const reason = `${review.platform} has no reply-posting API — copy the draft over manually instead.`;
    console.error(`[postReply] ${reason} (business ${businessId})`);
    await logAction(businessId, 'reply_post_failed', { review_id: review.id, reason });
    return { success: false, reason };
  }

  const { data: connection, error } = await supabase
    .from('platform_connections')
    .select('*')
    .eq('business_id', businessId)
    .eq('platform', review.platform)
    .single();

  if (error || !connection) {
    const reason = `No active ${review.platform} connection for this business yet — connect it before replies can post.`;
    console.error(`[postReply] ${reason} (business ${businessId})`);
    await logAction(businessId, 'reply_post_failed', { review_id: review.id, reason });
    return { success: false, reason };
  }

  try {
    const accessToken = await platform.getValidAccessToken(connection, supabase);
    await platform.postReply(connection, accessToken, review.external_review_id, reply.draft_text);
  } catch (err) {
    console.error(`[postReply] failed to post reply ${reply.id}:`, err.message);
    await logAction(businessId, 'reply_post_failed', { review_id: review.id, reason: err.message });
    return { success: false, reason: err.message };
  }

  const now = new Date().toISOString();

  await supabase
    .from('replies')
    .update({ posted: true, posted_at: now })
    .eq('id', reply.id);

  await supabase
    .from('reviews')
    .update({ status: 'replied' })
    .eq('id', review.id);

  await logAction(businessId, 'reply_posted', { review_id: review.id, reply_id: reply.id });
  return { success: true };
}

// Called from the dashboard when an owner manually approves a held reply
// (a flagged low-star review, or one that failed the automated safety check).
// Same posting path — the only difference is who signed off on it.
async function postManuallyApproved(replyId) {
  const { data: reply, error: replyErr } = await supabase
    .from('replies')
    .select('*, reviews!inner(*)')
    .eq('id', replyId)
    .single();

  if (replyErr || !reply) {
    return { success: false, reason: (replyErr && replyErr.message) || 'reply not found' };
  }

  const review = reply.reviews;
  return postApprovedReply(review, reply, review.business_id);
}

// Called from the dashboard's "Copy Reply" flow for platforms with no posting API at all
// (Facebook, Yelp). No API call happens — this just records that the owner has taken the
// draft and handled it themselves outside the system, so it stops showing up in the queue.
async function markManuallySent(replyId) {
  const { data: reply, error: replyErr } = await supabase
    .from('replies')
    .select('*, reviews!inner(*)')
    .eq('id', replyId)
    .single();

  if (replyErr || !reply) {
    return { success: false, reason: (replyErr && replyErr.message) || 'reply not found' };
  }

  const review = reply.reviews;
  const now = new Date().toISOString();

  await supabase.from('replies').update({ posted: true, posted_at: now }).eq('id', reply.id);
  await supabase.from('reviews').update({ status: 'replied' }).eq('id', review.id);
  await logAction(review.business_id, 'reply_marked_sent_manually', {
    review_id: review.id,
    reply_id: reply.id,
    platform: review.platform
  });

  return { success: true };
}

module.exports = { postApprovedReply, postManuallyApproved, markManuallySent };
