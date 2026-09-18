// LLM calls for reply drafting and the safety-check pass (spec §6).
// Uses the Anthropic API. Swap MODEL / SDK if you'd rather run this on OpenAI —
// the two-pass structure (draft, then an independent check) is the part that matters.

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DRAFT_MODEL = 'claude-haiku-4-5-20251001'; // cheap, fast — fine for short review replies
const SAFETY_MODEL = 'claude-haiku-4-5-20251001'; // deliberately a SEPARATE call, not self-graded

function toneInstructions(profile) {
  const policyText = {
    apologize_and_offer_fix: 'Always apologize sincerely and offer to make it right.',
    defer_to_contact_us: 'Keep it brief and ask them to contact the business directly to resolve it — do not attempt to resolve the issue in the public reply.',
    custom: profile.custom_instruction || 'Use good judgment.'
  }[profile.negative_review_policy];

  return `
Tone: ${profile.tone}.
Sign-off style: ${profile.signoff_style || 'a brief, warm closing line'}.
Handling negative reviews: ${policyText}
Never use these words/phrases: ${(profile.avoid_phrases || []).join(', ') || '(none specified)'}.
`.trim();
}

// Step 1: draft a reply in the business's configured voice.
async function draftReply({ businessName, review, toneProfile }) {
  const system = `You write short, genuine-sounding owner replies to customer reviews for a local business called "${businessName}".
Rules:
- 1–3 sentences. No corporate boilerplate, no over-apologizing for a 5-star review.
- Reference something specific from the review when there is something to reference.
- Never invent facts about the business, an employee's name, or what happened — if the review doesn't say, don't guess.
- Never offer a specific dollar refund, discount amount, or free item — invite them to reach out instead.
${toneInstructions(toneProfile)}`;

  const userMsg = `Review (${review.rating} stars) from ${review.reviewer_name || 'a customer'}:\n"${review.review_text || '(no written comment, star rating only)'}"\n\nWrite the reply.`;

  const res = await anthropic.messages.create({
    model: DRAFT_MODEL,
    max_tokens: 200,
    system,
    messages: [{ role: 'user', content: userMsg }]
  });

  return res.content[0].text.trim();
}

// Runs BEFORE drafting, independent of star rating. A 3+ star review can still be written
// in scathing/furious language (or describe something serious — a health/safety complaint,
// a threat to leave a bad review elsewhere, legal language) that the business owner should
// see and respond to personally, not have an AI reply to automatically. Returns
// { scathing, reason }.
async function assessSeverity({ review }) {
  if (!review.review_text || !review.review_text.trim()) {
    return { scathing: false, reason: 'no written text to assess' };
  }

  const system = `You triage customer reviews for a local business to decide if the OWNER should personally handle the response, rather than an automated reply going out.
Mark a review as SCATHING if it is written in an angry, furious, or contemptuous tone; alleges something serious (health/safety, discrimination, a threat, potential legal action); or is the kind of review where a generic AI-sounding reply would make things worse, regardless of its star rating.
Do not mark a review SCATHING just because it is negative or mildly critical — normal complaints (slow service, an order mistake, a bit pricey) are NOT scathing.
Respond with exactly one line: SCATHING: <one-sentence reason> or NOT_SCATHING: <one-sentence reason>`;

  const userMsg = `Review (${review.rating} stars): "${review.review_text}"`;

  const res = await anthropic.messages.create({
    model: SAFETY_MODEL,
    max_tokens: 60,
    system,
    messages: [{ role: 'user', content: userMsg }]
  });

  const verdict = res.content[0].text.trim();
  const scathing = verdict.toUpperCase().startsWith('SCATHING');
  return { scathing, reason: verdict };
}

// Step 2: an INDEPENDENT pass that checks the draft before it's allowed to auto-post.
// This is the guardrail from spec §6 — a second, cheap model call, not the same call
// grading its own work. Returns { passed, notes }.
async function safetyCheck({ review, draftText, businessName }) {
  const system = `You are a strict pre-publication reviewer for AI-drafted replies to customer reviews.
A reply FAILS the check if it is: defensive or sarcastic in tone, factually presumptuous (claims to know what happened when the review didn't say), promises a specific refund/discount amount, contains any personal or made-up employee name, or is generically off-topic for the review it's replying to.
Respond with exactly one line in this format: PASS or FAIL: <one-sentence reason>`;

  const userMsg = `Business: ${businessName}
Original review (${review.rating} stars): "${review.review_text || '(no written comment)'}"
Drafted reply: "${draftText}"`;

  const res = await anthropic.messages.create({
    model: SAFETY_MODEL,
    max_tokens: 60,
    system,
    messages: [{ role: 'user', content: userMsg }]
  });

  const verdict = res.content[0].text.trim();
  const passed = verdict.toUpperCase().startsWith('PASS');
  return { passed, notes: verdict };
}

module.exports = { draftReply, safetyCheck, assessSeverity };
