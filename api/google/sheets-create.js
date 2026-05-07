// api/google/sheets-create.js — creates a new Google Sheet for the operator,
// writes the bulk-import header row, and returns the sheet id + url.
// The browser passes its access_token; we never store it server-side.

import { createSpreadsheet, json, readJsonBody } from '../google.js';

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
  if (!payload || !payload.access_token) {
    return json({ error: 'access_token is required' }, { status: 400 });
  }
  if (!Array.isArray(payload.headerRow) || !payload.headerRow.length) {
    return json({ error: 'headerRow is required' }, { status: 400 });
  }
  try {
    const result = await createSpreadsheet({
      access_token: payload.access_token,
      title: payload.title,
      headerRow: payload.headerRow,
    });
    return json(result);
  } catch (e) {
    return json({ error: e.message }, { status: e.status || 500 });
  }
}
