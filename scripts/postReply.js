// Phase 1 pipeline, step 3: post an approved (safety-check-passed, not held) reply back to
// Google, and log the result. Also exposes postManuallyApproved() for the dashboard's
// "approve this held reply" button — same posting logic, different entry trigger.
//
// Both functions return { success, reason } so callers (the dashboard especially) can show
// the person WHY a post attempt did nothing, instead of it looking like the button is broken.

const { supabase, logAction } = require('../src/db');
const { getValidAccessToken, postReply } = require('../src/googleBusinessProfile');

async function postApprovedReply(review, reply, businessId) {
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
    const accessToken = await getValidAccessToken(connection, supabase);
    await postReply(connection, accessToken, review.external_review_id, reply.draft_text);
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

module.exports = { postApprovedReply, postManuallyApproved };
