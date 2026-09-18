-- Reply Engine — Phase 1 schema (Supabase / Postgres)
-- Covers: businesses, tone profiles, OAuth tokens, reviews, replies.
-- Run this once against a fresh Supabase project (SQL editor or `supabase db push`).

create extension if not exists "pgcrypto";

-- One row per connected business location (a customer may eventually have >1 location).
create table if not exists businesses (
  id                uuid primary key default gen_random_uuid(),
  owner_email       text not null,
  name              text not null,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text not null default 'trialing', -- trialing | active | past_due | canceled
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Tone profile captured during the 5-question onboarding quiz.
create table if not exists tone_profiles (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade,
  tone              text not null default 'friendly',       -- friendly | professional | warm
  negative_review_policy text not null default 'apologize_and_offer_fix',
    -- apologize_and_offer_fix | defer_to_contact_us | custom
  custom_instruction text,
  signoff_style     text,                                    -- e.g. "- The [Business] Team"
  avoid_phrases     text[] default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique(business_id)
);

-- OAuth tokens per connected review platform.
create table if not exists platform_connections (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade,
  platform          text not null,             -- google | yelp | facebook
  external_account_id text not null,           -- Google location id, Yelp business id, etc.
  access_token      text not null,             -- store encrypted at rest in production (pgsodium / KMS)
  refresh_token     text,
  token_expires_at  timestamptz,
  status            text not null default 'active', -- active | reauth_required | disabled
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique(business_id, platform)
);

-- Every review pulled from a connected platform.
create table if not exists reviews (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade,
  platform          text not null,
  external_review_id text not null,
  reviewer_name     text,
  rating            int not null check (rating between 1 and 5),
  review_text       text,
  review_created_at timestamptz not null,
  fetched_at        timestamptz not null default now(),
  status            text not null default 'pending', -- pending | replied | flagged | skipped
  unique(platform, external_review_id)
);

-- Every AI-drafted reply, whether auto-posted or held for owner review.
create table if not exists replies (
  id                uuid primary key default gen_random_uuid(),
  review_id         uuid not null references reviews(id) on delete cascade,
  draft_text        text not null,
  safety_check_passed boolean not null,
  safety_check_notes text,
  posted            boolean not null default false,
  posted_at         timestamptz,
  held_for_review   boolean not null default false,
  created_at        timestamptz not null default now()
);

-- Lightweight audit log — every automated action, for the monthly human spot-check (spec §10).
create table if not exists automation_log (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid references businesses(id) on delete set null,
  action            text not null,   -- poll_run | reply_drafted | reply_posted | reply_flagged | request_sent | report_sent
  detail            jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists idx_reviews_business_status on reviews(business_id, status);
create index if not exists idx_platform_connections_business on platform_connections(business_id);
create index if not exists idx_automation_log_business on automation_log(business_id, created_at desc);
