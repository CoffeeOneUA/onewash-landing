// Minimal Supabase REST helper — no SDK dependency, just fetch against PostgREST.
// Uses the service_role key so it bypasses RLS (server-side only, never exposed to the client).

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://elrmeekxaxcyxdyzqtzg.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertConfigured() {
  if (!SERVICE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set in environment variables');
  }
}

async function sb(path, { method = 'GET', body, headers = {}, query } = {}) {
  assertConfigured();
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += (path.includes('?') ? '&' : '?') + qs;
  }
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: headers.Prefer || 'return=representation',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const err = new Error(`Supabase ${method} ${path} failed: ${res.status} ${text}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const sbSelect = (table, query) => sb(table, { method: 'GET', query });
const sbInsert = (table, row) => sb(table, { method: 'POST', body: row }).then((r) => (Array.isArray(r) ? r[0] : r));
const sbUpdate = (table, query, patch) => sb(table, { method: 'PATCH', query, body: patch });

module.exports = { sb, sbSelect, sbInsert, sbUpdate, SUPABASE_URL };
