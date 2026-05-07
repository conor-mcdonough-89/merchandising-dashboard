// api/google/auth-exchange.js — exchanges a Google OAuth authorization code
// for access + refresh tokens. Browser sends `{ code, code_verifier }` after
// the OAuth popup redirects to `/api/google/auth-callback`, which posts the
// code back to the opener.

import { exchangeCode, json, readJsonBody } from '../google.js';

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
  if (!payload || !payload.code || !payload.code_verifier) {
    return json({ error: 'code and code_verifier are required' }, { status: 400 });
  }
  try {
    const tokens = await exchangeCode({
      code: payload.code,
      code_verifier: payload.code_verifier,
    });
    return json({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      scope: tokens.scope,
    });
  } catch (e) {
    const code = e.code === 'NO_GOOGLE_ENV' ? 500 : (e.status || 500);
    return json({ error: e.message }, { status: code });
  }
}
