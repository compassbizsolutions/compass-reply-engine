// Thin Supabase client wrapper shared by every pipeline script.
// Env vars expected (see .env.example): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill in your Supabase project credentials.'
  );
}

// Service-role key — this runs server-side only (polling/posting scripts, n8n),
// never ship it to a browser or customer-facing surface.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function logAction(businessId, action, detail = {}) {
  const { error } = await supabase
    .from('automation_log')
    .insert({ business_id: businessId, action, detail });
  if (error) console.error(`[automation_log] failed to log "${action}":`, error.message);
}

module.exports = { supabase, logAction };
