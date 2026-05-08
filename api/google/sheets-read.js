// api/google/sheets-read.js — reads a range of cell values from the bound
// Google Sheet via spreadsheets.values.get. Used to pull the model_id column
// (Sheet1!A2:A) so the dashboard can flag models another operator has queued.

import { readValues, json, readJsonBody } from '../google.js';

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
  if (!payload || !payload.access_token || !payload.sheetId || !payload.range) {
    return json({ error: 'access_token, sheetId, and range are required' }, { status: 400 });
  }
  try {
    const result = await readValues({
      access_token: payload.access_token,
      sheetId: payload.sheetId,
      range: payload.range,
    });
    return json({ values: result.values || [] });
  } catch (e) {
    return json({ error: e.message }, { status: e.status || 500 });
  }
}
