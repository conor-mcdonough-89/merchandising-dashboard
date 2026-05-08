// api/google/sheets-format.js — applies cell formatting (yellow background)
// to a set of cells in the bound Google Sheet via spreadsheets.batchUpdate.
//
// The browser builds the `requests` array (an array of Sheets API repeatCell
// requests) from the row range it stashed on the IndexedDB entry plus the
// column indices that the operator's action changed. We pass them through to
// Google as-is.

import { batchUpdate, json, readJsonBody } from '../google.js';

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
  if (!Array.isArray(payload.requests) || !payload.requests.length) {
    return json({ formatted: 0 });
  }
  try {
    const result = await batchUpdate({
      access_token: payload.access_token,
      sheetId: payload.sheetId,
      requests: payload.requests,
    });
    return json({ formatted: payload.requests.length, raw: result });
  } catch (e) {
    return json({ error: e.message }, { status: e.status || 500 });
  }
}
