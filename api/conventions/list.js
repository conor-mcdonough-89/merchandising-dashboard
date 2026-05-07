// api/conventions/list.js — Edge Function. GET ?categoryId=37 returns the
// category convention (if any) and every brand convention for that category
// from Supabase. Browser uses this on convention-modal open and at the start
// of Find Renames to prefetch the conventions a run will need.

import { supabaseFetch, json } from '../supabase.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }
  const url = new URL(req.url);
  const categoryId = url.searchParams.get('categoryId');
  if (!categoryId || !/^\d+$/.test(categoryId)) {
    return json({ error: 'categoryId (integer) is required' }, { status: 400 });
  }
  try {
    const rows = await supabaseFetch(
      `/rest/v1/conventions?category_id=eq.${categoryId}&select=*`,
    );
    const list = Array.isArray(rows) ? rows : [];
    const category = list.find((r) => r.scope === 'category') || null;
    const brands = list.filter((r) => r.scope === 'brand');
    return json({ category, brands });
  } catch (e) {
    const code = e.code === 'NO_SUPABASE_ENV' ? 500 : (e.status || 500);
    return json({ error: e.message }, { status: code });
  }
}
