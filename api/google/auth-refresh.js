// api/google/auth-refresh.js — refreshes a Google OAuth access token using a
// refresh token. The refresh_token is held in browser localStorage; we proxy
// the call so client_secret stays server-side.

import { refreshToken, json, readJsonBody } from '../google.js';

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
  if (!payload || !payload.refresh_token) {
    return json({ error: 'refresh_token is required' }, { status: 400 });
  }
  try {
    const tokens = await refreshToken({ refresh_token: payload.refresh_token });
    return json({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      scope: tokens.scope,
    });
  } catch (e) {
    const code = e.code === 'NO_GOOGLE_ENV' ? 500 : (e.status || 500);
    return json({ error: e.message }, { status: code });
  }
}
