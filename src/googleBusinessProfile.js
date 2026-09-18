// Google Business Profile API helpers — fetching new reviews and posting replies.
//
// Docs: https://developers.google.com/my-business/reference/rest (Account Management API +
// the newer Business Profile Performance/Reviews APIs — confirm current endpoint names at
// build time, Google has renamed/split these APIs before).
//
// This module assumes an already-obtained OAuth access token per business (stored in
// platform_connections, refreshed by refreshGoogleToken below when expired).

const GBP_API_BASE = 'https://mybusiness.googleapis.com/v4'; // verify current version before launch

async function refreshGoogleToken(connection) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: connection.refresh_token,
      grant_type: 'refresh_token'
    })
  });

  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString()
  };
}

// Returns an access token, refreshing first if it's expired or close to it.
async function getValidAccessToken(connection, supabase) {
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at) : null;
  const needsRefresh = !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

  if (!needsRefresh) return connection.access_token;

  const refreshed = await refreshGoogleToken(connection);

  await supabase
    .from('platform_connections')
    .update({
      access_token: refreshed.access_token,
      token_expires_at: refreshed.expires_at,
      updated_at: new Date().toISOString()
    })
    .eq('id', connection.id);

  return refreshed.access_token;
}

// Fetches reviews for one connected location, newest first.
async function fetchReviews(connection, accessToken) {
  const url = `${GBP_API_BASE}/${connection.external_account_id}/reviews`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (res.status === 401 || res.status === 403) {
    throw new Object.assign(new Error('Google auth rejected — token may need re-consent'), {
      code: 'REAUTH_REQUIRED'
    });
  }
  if (!res.ok) {
    throw new Error(`GBP fetchReviews failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return (data.reviews || []).map((r) => ({
    external_review_id: r.reviewId,
    reviewer_name: r.reviewer?.displayName || 'Anonymous',
    rating: googleStarRatingToInt(r.starRating),
    review_text: r.comment || '',
    review_created_at: r.createTime
  }));
}

function googleStarRatingToInt(starRating) {
  const map = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  return map[starRating] || 0;
}

// Posts (or updates) an owner reply to a specific review.
async function postReply(connection, accessToken, externalReviewId, replyText) {
  const url = `${GBP_API_BASE}/${connection.external_account_id}/reviews/${externalReviewId}/reply`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ comment: replyText })
  });

  if (!res.ok) {
    throw new Error(`GBP postReply failed (${res.status}): ${await res.text()}`);
  }

  return res.json();
}

module.exports = { getValidAccessToken, fetchReviews, postReply };
