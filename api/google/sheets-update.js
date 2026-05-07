// api/google/sheets-update.js — overwrites a row in a previously-bound
// Google Sheet. Used when the operator stacks actions on the same model
// (e.g. state change then rename) so the Sheet stays in sync with the
// dedup'd CSV instead of accumulating duplicate rows.

import { updateValues, json, readJsonBody } from '../google.js';

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
  if (!payload.range || !Array.isArray(payload.row)) {
    return json({ error: 'range and row are required' }, { status: 400 });
  }
  try {
    const result = await updateValues({
      access_token: payload.access_token,
      sheetId: payload.sheetId,
      range: payload.range,
      row: payload.row,
    });
    return json({ updated: 1, raw: result });
  } catch (e) {
    return json({ error: e.message }, { status: e.status || 500 });
  }
}
