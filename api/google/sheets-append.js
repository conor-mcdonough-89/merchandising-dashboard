// api/google/sheets-append.js — appends rows to a previously-created Google
// Sheet. Browser sends access_token + sheetId + rows (2D array).

import { appendValues, json, readJsonBody } from '../google.js';

export const config = { runtime: 'edge' };

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
  if (!payload || !payload.access_token || !payload.sheetId) {
    return json({ error: 'access_token and sheetId are required' }, { status: 400 });
  }
  if (!Array.isArray(payload.rows) || !payload.rows.length) {
    return json({ appended: 0 });
  }
  try {
    const result = await appendValues({
      access_token: payload.access_token,
      sheetId: payload.sheetId,
      rows: payload.rows,
    });
    return json({
      appended: payload.rows.length,
      updates: result.updates || null,
    });
  } catch (e) {
    return json({ error: e.message }, { status: e.status || 500 });
  }
}
