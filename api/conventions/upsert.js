// api/conventions/upsert.js — Edge Function. POST a convention record.
// Builds the primary key from scope + ids, sets edited_at = now(), upserts
// via PostgREST `Prefer: resolution=merge-duplicates`. Returns the row that
// was written.
//
// Payload shape:
//   {
//     scope:              'category' | 'brand',
//     brandId?:           number,            // required when scope='brand'
//     brandName?:         string,
//     categoryId:         number,
//     categoryFullName:   string,
//     pattern?:           string,
//     examples?:          string[],
//     rules?:             string[],
//     exceptions?:        string[],
//     inferredAt?:        ISO timestamp     // set only when origin is the LLM
//   }

import { supabaseFetch, json, readJsonBody } from '../supabase.js';

export const config = { runtime: 'edge' };

function buildKey(scope, brandId, categoryId) {
  if (scope === 'category') return `category::${categoryId}`;
  return `${brandId}::${categoryId}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (_) {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { scope, brandId, brandName, categoryId, categoryFullName } = payload || {};
  if (scope !== 'category' && scope !== 'brand') {
    return json({ error: "scope must be 'category' or 'brand'" }, { status: 400 });
  }
  if (categoryId == null || categoryFullName == null) {
    return json({ error: 'categoryId and categoryFullName are required' }, { status: 400 });
  }
  if (scope === 'brand' && (brandId == null || brandName == null)) {
    return json({ error: "brandId and brandName are required when scope='brand'" }, { status: 400 });
  }

  const row = {
    key: buildKey(scope, brandId, categoryId),
    scope,
    brand_id: scope === 'brand' ? Number(brandId) : null,
    brand_name: scope === 'brand' ? brandName : null,
    category_id: Number(categoryId),
    category_full_name: categoryFullName,
    pattern: payload.pattern || '',
    examples: Array.isArray(payload.examples) ? payload.examples : [],
    rules: Array.isArray(payload.rules) ? payload.rules : [],
    exceptions: Array.isArray(payload.exceptions) ? payload.exceptions : [],
    inferred_at: payload.inferredAt || null,
    edited_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  try {
    const result = await supabaseFetch('/rest/v1/conventions', {
      method: 'POST',
      body: JSON.stringify(row),
      prefer: 'resolution=merge-duplicates,return=representation',
    });
    const written = Array.isArray(result) ? result[0] : result;
    return json({ row: written || row });
  } catch (e) {
    const code = e.code === 'NO_SUPABASE_ENV' ? 500 : (e.status || 500);
    return json({ error: e.message }, { status: code });
  }
}
