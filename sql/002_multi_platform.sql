-- Reply Engine — Phase 1.5: multi-platform support (Facebook fetch-only, Yelp manual entry,
-- Trustpilot fetch+reply). Run once, after 001_init_schema.sql.
--
-- No new platform enum/constraint existed on `platform_connections.platform` or `reviews.platform`
-- (both were always free text), so facebook/yelp/trustpilot values already work with the existing
-- schema. The only real addition is tracking how a review entered the system, since Yelp reviews
-- come in by hand rather than through a poll.

alter table reviews
  add column if not exists entry_method text not null default 'api'; -- api | manual

comment on column reviews.entry_method is
  'api = pulled by pollReviews.js from a connected platform. manual = typed in via the dashboard (Yelp, until Yelp grants API access).';
