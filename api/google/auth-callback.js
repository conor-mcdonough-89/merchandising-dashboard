// api/google/auth-callback.js — handles the redirect_uri leg of the OAuth
// popup flow. Reads `code` + `state` from the query string, posts them back
// to the opener via window.opener.postMessage, then closes itself. The
// parent window then calls /api/google/auth-exchange with code + verifier.
//
// This page is intentionally tiny -- the actual code/verifier exchange
// happens in the parent so the verifier never leaves the browser session
// that started the flow.

import { html } from '../google.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error') || '';

  // Escape for embedding in a JS string literal. Google's codes are URL-safe
  // base64 so this is belt-and-braces, but better safe than RXSS.
  const safe = (s) => String(s).replace(/[\\'"<>]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>Connecting Google Sheets…</title>
<style>body{font-family:sans-serif;background:#0d0f14;color:#e8eaf0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:14px}</style>
</head><body>
<div>Finishing Google sign-in… you can close this window.</div>
<script>
(function(){
  var msg = { type: 'merch-google-oauth', code: '${safe(code)}', state: '${safe(state)}', error: '${safe(error)}' };
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(msg, window.location.origin);
    }
  } catch (e) {}
  setTimeout(function(){ window.close(); }, 200);
})();
</script>
</body></html>`;

  return html(body);
}
