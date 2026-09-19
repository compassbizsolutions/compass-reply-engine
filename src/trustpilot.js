// Trustpilot Service Reviews API helpers — fetching new reviews and posting replies.
//
// Docs: https://developers.trustpilot.com/service-reviews-api (confirm current endpoint paths
// at build time — Trustpilot has versioned this API before).
//
// Unlike Google, Trustpilot splits auth in two:
//   - Reading reviews uses a plain API key (TRUSTPILOT_API_KEY env var) — no per-business OAuth.
//   - Posting a reply requires a Business User OAuth token, scoped to the business that connected
//     their account (stored per-connection in platform_connections, refreshed below like Google's).
//
// connection.external_account_id = the Trustpilot Business Unit ID for this business.
// connection.access_token / refresh_token = the Business User OAuth token used only for replying.

const TRUSTPILOT_API_BASE = 'https://api.trustpilot.com/v1';

async function refreshTrustpilotToken(connection) {
  const res = await fetch(`${TRUSTPILOT_API_BASE}/oauth/oauth-business-users-for-applications/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(
        `${process.env.TRUSTPILOT_CLIENT_ID}:${process.env.TRUSTPILOT_CLIENT_SECRET}`
      ).toString('base64')}`
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: connection.refresh_token
    })
  });

  if (!res.ok) {
    throw new Error(`Trustpilot token refresh failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || connection.refresh_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString()
  };
}

// Returns a valid Business User OAuth token, refreshing first if it's expired or close to it.
// Only needed for postReply — fetchReviews uses the flat API key instead.
async function getValidAccessToken(connection, supabase) {
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at) : null;
  const needsRefresh = !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

  if (!needsRefresh) return connection.access_token;

  const refreshed = await refreshTrustpilotToken(connection);

  await supabase
    .from('platform_connections')
    .update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      token_expires_at: refreshed.expires_at,
      updated_at: new Date().toISOString()
    })
    .eq('id', connection.id);

  return refreshed.access_token;
}

// Fetches reviews for one connected business unit, newest first.
async function fetchReviews(connection) {
  const url = `${TRUSTPILOT_API_BASE}/business-units/${connection.external_account_id}/reviews`;
  const res = await fetch(url, {
    headers: { apikey: process.env.TRUSTPILOT_API_KEY }
  });

  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('Trustpilot API key rejected'), { code: 'REAUTH_REQUIRED' });
  }
  if (!res.ok) {
    throw new Error(`Trustpilot fetchReviews failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return (data.reviews || []).map((r) => ({
    external_review_id: r.id,
    reviewer_name: r.consumer?.displayName || 'Anonymous',
    rating: r.stars,
    review_text: r.text || '',
    review_created_at: r.createdAt
  }));
}

// Posts a business reply to a specific review.
async function postReply(connection, accessToken, externalReviewId, replyText) {
  const url = `${TRUSTPILOT_API_BASE}/private/reviews/${externalReviewId}/reply`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: replyText })
  });

  if (!res.ok) {
    throw new Error(`Trustpilot postReply failed (${res.status}): ${await res.text()}`);
  }

  return res.json();
}

module.exports = { getValidAccessToken, fetchReviews, postReply };
