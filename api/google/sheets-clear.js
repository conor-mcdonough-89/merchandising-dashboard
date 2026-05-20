// api/google/sheets-clear.js — wipe data rows on one or more ranges of a
// bound spreadsheet. Used by Settings → "Clear sheet contents" so the
// operator can reset the bulk-import sheet without disconnecting it or
// re-creating its four tabs. Callers pass header-skipping A1 ranges, e.g.
//   ['Landers!A2:Z','Blocks!A2:Z','Page View Block Relations!A2:Z',
//    'Block Tile Relations!A2:Z']

import { batchClearValues, json, readJsonBody } from '../google.js';

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
  if (!Array.isArray(payload.ranges) || !payload.ranges.length) {
    return json({ error: 'ranges is required' }, { status: 400 });
  }
  try {
    const result = await batchClearValues({
      access_token: payload.access_token,
      sheetId: payload.sheetId,
      ranges: payload.ranges,
    });
    return json(result);
  } catch (e) {
    return json({ error: e.message }, { status: e.status || 500 });
  }
}
