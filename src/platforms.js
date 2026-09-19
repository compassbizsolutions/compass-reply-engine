// Central registry of which review platforms the pipeline knows about, and what each one can
// actually do. This is the single place that encodes a hard business/legal reality:
//
//   - Google Business Profile and Trustpilot both offer a real, sanctioned API for posting a
//     business reply — so those can be fully automated end to end.
//   - Facebook's Graph API can fetch Page ratings/recommendations but has no reply-posting
//     endpoint at all, for anyone, at any permission level. Not a gap we can close later without
//     Meta shipping a new API — it just doesn't exist.
//   - Yelp doesn't expose a public API for reading or replying to reviews to ordinary businesses
//     (that's gated behind an invite-only Partner API for large reputation platforms). Reviews
//     get into the pipeline by manual entry through the dashboard instead of polling.
//
// draftReply.js and pollReviews.js/dashboard.js read `canAutoPost` / `canFetch` from here rather
// than hardcoding platform names, so this file is the one place to touch if that ever changes
// (e.g. Yelp grants API access, or Meta adds a reply endpoint).

const google = require('./googleBusinessProfile');
const trustpilot = require('./trustpilot');
const facebook = require('./facebook');

const PLATFORMS = {
  google: {
    label: 'Google',
    canFetch: true,
    canAutoPost: true,
    getValidAccessToken: google.getValidAccessToken,
    fetchReviews: google.fetchReviews,
    postReply: google.postReply
  },
  trustpilot: {
    label: 'Trustpilot',
    canFetch: true,
    canAutoPost: true,
    getValidAccessToken: trustpilot.getValidAccessToken,
    fetchReviews: trustpilot.fetchReviews,
    postReply: trustpilot.postReply
  },
  facebook: {
    label: 'Facebook',
    canFetch: true,
    canAutoPost: false, // Graph API has no reply endpoint for ratings/recommendations — ever.
    getValidAccessToken: facebook.getValidAccessToken,
    fetchReviews: facebook.fetchReviews
  },
  yelp: {
    label: 'Yelp',
    canFetch: false, // no public API access for reading reviews (Partner API is invite-only).
    canAutoPost: false, // same — no public API access for posting replies either.
    entryMethod: 'manual'
  }
};

// Platforms pollReviews.js should actually poll on a schedule.
const POLLABLE_PLATFORMS = Object.keys(PLATFORMS).filter((p) => PLATFORMS[p].canFetch);

module.exports = { PLATFORMS, POLLABLE_PLATFORMS };
