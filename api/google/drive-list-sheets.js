// api/google/drive-list-sheets.js — list the operator's Google Sheets via
// the Drive API. Used by the "browse existing sheets" picker in Settings
// so the operator can pick a previously-created bulk-import sheet to bind.
// Requires the drive.metadata.readonly scope (see api/google.js GOOGLE_SCOPES).

import { listDriveSheets, json, readJsonBody } from '../google.js';

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
  try {
    const files = await listDriveSheets({
      access_token: payload.access_token,
      pageSize: payload.pageSize,
    });
    return json({ files });
  } catch (e) {
    return json({ error: e.message }, { status: e.status || 500 });
  }
}
