// api/google/sheets-meta.js — fetch the worksheet gid for the bound sheet.
// Used to recover gid for older bindings (created before we captured it on
// createSheet) so cell-formatting requests don't 400 with "No grid with id: 0".

import { getSpreadsheetMeta, json, readJsonBody } from '../google.js';

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
  try {
    const meta = await getSpreadsheetMeta({
      access_token: payload.access_token,
      sheetId: payload.sheetId,
    });
    return json(meta);
  } catch (e) {
    return json({ error: e.message }, { status: e.status || 500 });
  }
}
