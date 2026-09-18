// Phase 1 pipeline, step 2: draft a reply for a pending review, run the safety check,
// and either auto-post it (step 3, postReply.js) or hold it for the owner.
// Called directly by pollReviews.js for each new review — not meant to be run standalone,
// though `node scripts/draftReply.js <review_id>` works for manual testing.

// Loaded here (not just in the manual-test block below) because db.js reads env vars the
// moment it's required, and require() calls run before any code below them — so .env must
// be loaded before the require('../src/db') line, not after it.
require('dotenv').config();

const { supabase, logAction } = require('../src/db');
const { draftReply, safetyCheck, assessSeverity } = require('../src/llm');
const { postApprovedReply } = require('./postReply');

async function draftAndHandleReply(review, businessId) {
  const { data: business, error: bizErr } = await supabase
    .from('businesses')
    .select('name')
    .eq('id', businessId)
    .single();

  const { data: toneProfile, error: toneErr } = await supabase
    .from('tone_profiles')
    .select('*')
    .eq('business_id', businessId)
    .single();

  if (bizErr || toneErr || !toneProfile) {
    console.error(`[draftReply] missing business/tone profile for ${businessId}`, bizErr, toneErr);
    return;
  }

  // Checked BEFORE drafting, independent of star rating — a scathing review (angry tone,
  // a serious allegation, threat of legal action, etc.) goes to the owner even at 3+ stars.
  // Reputational risk here is judged too high for an automated reply, whatever the draft
  // quality would have been.
  let severity;
  try {
    severity = await assessSeverity({ review });
  } catch (err) {
    console.error(`[draftReply] severity check failed for review ${review.id}:`, err.message);
    // Fail closed: if the check itself errors, treat it as scathing rather than guess.
    severity = { scathing: true, reason: 'SCATHING: severity check call errored, holding for manual review' };
  }

  let draftText;
  try {
    draftText = await draftReply({ businessName: business.name, review, toneProfile });
  } catch (err) {
    console.error(`[draftReply] LLM draft failed for review ${review.id}:`, err.message);
    return;
  }

  let check;
  try {
    check = await safetyCheck({ review, draftText, businessName: business.name });
  } catch (err) {
    console.error(`[draftReply] safety check failed for review ${review.id}:`, err.message);
    // Fail closed: if the safety check itself errors, hold for review rather than guess.
    check = { passed: false, notes: 'FAIL: safety check call errored, holding for manual review' };
  }

  // Held for the owner, regardless of how clean the draft is, when either is true:
  // (a) low star rating (spec §5 "negative-review flag"), or (b) the text itself reads as
  // scathing/serious even at 3+ stars (assessed above, before drafting). The owner decides
  // whether and how to respond personally in both cases.
  const forceHold = review.rating <= 2 || severity.scathing;
  const holdForReview = forceHold || !check.passed;

  const { data: reply, error: replyErr } = await supabase
    .from('replies')
    .insert({
      review_id: review.id,
      draft_text: draftText,
      safety_check_passed: check.passed,
      safety_check_notes: check.notes,
      held_for_review: holdForReview
    })
    .select()
    .single();

  if (replyErr) {
    console.error(`[draftReply] failed to save reply for review ${review.id}:`, replyErr.message);
    return;
  }

  await logAction(businessId, 'reply_drafted', {
    review_id: review.id,
    rating: review.rating,
    held_for_review: holdForReview,
    safety_check_passed: check.passed,
    scathing: severity.scathing
  });

  if (holdForReview) {
    await supabase.from('reviews').update({ status: 'flagged' }).eq('id', review.id);
    const reason = review.rating <= 2
      ? 'low_star_rating'
      : severity.scathing
        ? 'scathing_review_text'
        : 'failed_safety_check';
    await logAction(businessId, 'reply_flagged', {
      review_id: review.id,
      reason,
      severity_notes: severity.reason
    });
    // TODO (spec §5/§6): include this in the owner's daily digest email.
    return;
  }

  await postApprovedReply(review, reply, businessId);
}

// Manual-test entrypoint: node scripts/draftReply.js <review_id>
if (require.main === module) {
  const reviewId = process.argv[2];
  if (!reviewId) {
    console.error('Usage: node scripts/draftReply.js <review_id>');
    process.exit(1);
  }
  supabase
    .from('reviews')
    .select('*')
    .eq('id', reviewId)
    .single()
    .then(({ data, error }) => {
      if (error || !data) throw error || new Error('review not found');
      return draftAndHandleReply(data, data.business_id);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { draftAndHandleReply };
