#!/usr/bin/env node
// Phase 1 pipeline, step 1: poll every active business's connected Google Business Profile
// for new reviews, upsert them into the `reviews` table, and kick off reply drafting for
// anything new. Meant to be run on a schedule (n8n / cron — see workflows/README.md).
//
// Usage: node scripts/pollReviews.js

require('dotenv').config();
const { supabase, logAction } = require('../src/db');
const { getValidAccessToken, fetchReviews } = require('../src/googleBusinessProfile');
const { draftAndHandleReply } = require('./draftReply');

async function pollBusiness(connection) {
  let accessToken;
  try {
    accessToken = await getValidAccessToken(connection, supabase);
  } catch (err) {
    if (err.code === 'REAUTH_REQUIRED') {
      await supabase
        .from('platform_connections')
        .update({ status: 'reauth_required' })
        .eq('id', connection.id);
      await logAction(connection.business_id, 'reauth_required', { platform: connection.platform });
      // TODO (Section 6 of spec): trigger the automated "reconnect" email here.
    } else {
      console.error(`[pollReviews] token error for business ${connection.business_id}:`, err.message);
    }
    return;
  }

  let fetched;
  try {
    fetched = await fetchReviews(connection, accessToken);
  } catch (err) {
    console.error(`[pollReviews] fetch error for business ${connection.business_id}:`, err.message);
    return;
  }

  for (const review of fetched) {
    // Upsert — unique(platform, external_review_id) makes this idempotent across runs.
    const { data: upserted, error } = await supabase
      .from('reviews')
      .upsert(
        {
          business_id: connection.business_id,
          platform: connection.platform,
          ...review
        },
        { onConflict: 'platform,external_review_id', ignoreDuplicates: false }
      )
      .select()
      .single();

    if (error) {
      console.error(`[pollReviews] upsert failed for review ${review.external_review_id}:`, error.message);
      continue;
    }

    // Only act on reviews we haven't already drafted a reply for.
    if (upserted.status === 'pending') {
      await draftAndHandleReply(upserted, connection.business_id);
    }
  }

  await logAction(connection.business_id, 'poll_run', {
    platform: connection.platform,
    reviews_seen: fetched.length
  });
}

async function main() {
  const { data: connections, error } = await supabase
    .from('platform_connections')
    .select('*, businesses!inner(subscription_status)')
    .eq('platform', 'google')
    .eq('status', 'active')
    .eq('businesses.subscription_status', 'active');

  if (error) {
    console.error('[pollReviews] failed to load connections:', error.message);
    process.exit(1);
  }

  console.log(`[pollReviews] polling ${connections.length} connected business(es)...`);

  // Sequential on purpose for the MVP — simple, avoids Google rate limits.
  // Parallelize with a concurrency limiter (p-limit) once volume justifies it.
  for (const connection of connections) {
    await pollBusiness(connection);
  }

  console.log('[pollReviews] done.');
}

main().catch((err) => {
  console.error('[pollReviews] fatal error:', err);
  process.exit(1);
});
