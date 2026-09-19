// Facebook Graph API helper — fetching Page ratings & recommendations.
//
// Docs: https://developers.facebook.com/docs/graph-api/reference/page/ratings/
//
// IMPORTANT: this is fetch-only. Meta's Graph API does not expose a create/reply endpoint for
// Page ratings & recommendations at all (confirmed at build time) — there is no way to post a
// business reply back to Facebook through the API, regardless of permissions granted. Every
// review pulled in here is therefore always held for the owner to copy the AI-drafted reply
// over manually (see PLATFORMS.facebook.canAutoPost in src/platforms.js).
//
// connection.external_account_id = the Facebook Page ID.
// connection.access_token = a long-lived Page access token (pages_read_engagement scope).
// Page tokens don't expire on the same short cycle as Google's — no refresh flow implemented
// yet; if a token is revoked/expired, fetchReviews will throw a REAUTH_REQUIRED error below.

const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0'; // verify current version before launch

// No refresh cycle for now — Page tokens are long-lived. Kept as a function (rather than reading
// connection.access_token directly everywhere) so a real refresh flow can slot in later without
// touching callers.
async function getValidAccessToken(connection) {
  return connection.access_token;
}

// Fetches ratings/recommendations for one connected Page, newest first.
async function fetchReviews(connection, accessToken) {
  const url = `${GRAPH_API_BASE}/${connection.external_account_id}/ratings?fields=reviewer,rating,review_text,created_time,open_graph_story&access_token=${accessToken}`;
  const res = await fetch(url);

  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('Facebook auth rejected — token may need re-consent'), {
      code: 'REAUTH_REQUIRED'
    });
  }
  if (!res.ok) {
    throw new Error(`Facebook fetchReviews failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return (data.data || [])
    // Facebook recommendations don't always carry a star rating (it's a thumbs up/down
    // "recommends" model in most locales) — skip anything without one since our pipeline
    // is built around a 1-5 scale.
    .filter((r) => typeof r.rating === 'number')
    .map((r) => ({
      external_review_id: r.open_graph_story?.id || `${connection.external_account_id}-${r.created_time}`,
      reviewer_name: r.reviewer?.name || 'Anonymous',
      rating: r.rating,
      review_text: r.review_text || '',
      review_created_at: r.created_time
    }));
}

module.exports = { getValidAccessToken, fetchReviews };
