// api/google/config.js — returns the public OAuth config the browser needs
// to start the authorization flow (client id + redirect uri). client_secret
// stays server-side and is never returned here.

import { getEnv, json } from '../google.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }
  const env = getEnv();
  if (!env.clientId || !env.redirectUri) {
    return json({ error: 'Google OAuth env not set' }, { status: 500 });
  }
  return json({
    clientId: env.clientId,
    redirectUri: env.redirectUri,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}
