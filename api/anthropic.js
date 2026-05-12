// api/anthropic.js — shared helper for the propose endpoints.
// Holds model-id constants so swaps happen in one place.
//
// Runs as a Vercel Edge Function (`runtime: 'edge'`) and as a regular
// Node 18+ handler under server.js. Both expose `globalThis.fetch`.

export const SONNET_MODEL = 'claude-sonnet-4-5-20250929';
export const OPUS_MODEL = 'claude-opus-4-5';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export function requireKey() {
  const key = (typeof process !== 'undefined' && process.env && process.env.ANTHROPIC_API_KEY) || null;
  if (!key) {
    const err = new Error('ANTHROPIC_API_KEY not set');
    err.code = 'NO_API_KEY';
    throw err;
  }
  return key;
}

// callAnthropic({ model, system, user, max_tokens, temperature, tools })
// `system` and `user` may each be a string OR an array of content blocks.
// Array form lets callers attach `cache_control: { type: 'ephemeral' }` to a
// block for Anthropic prompt caching. `tools` is forwarded as-is when set --
// used for the web_search_20250305 server tool on the renames endpoint.
// Returns { text, raw } where text is the concatenation of `type: 'text'`
// blocks (server-tool blocks like web_search_tool_result pass through raw).
export async function callAnthropic({
  model,
  system,
  user,
  max_tokens = 4096,
  temperature = 0.2,
  tools,
}) {
  const key = requireKey();
  const messages = [
    {
      role: 'user',
      content: typeof user === 'string' ? user : user,
    },
  ];

  const body = {
    model,
    max_tokens,
    temperature,
    system,
    messages,
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.upstream = text;
    throw err;
  }

  const data = await res.json();
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  return { text, raw: data };
}

// Parse a JSON object from the model's response. The system prompts ask for
// JSON only, but we tolerate ```json fences and prose around the object.
export function extractJson(text) {
  if (!text) throw new Error('Empty response from model');
  // Strip ```json ... ``` fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  // Find the outermost JSON object
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first < 0 || last < 0 || last < first) {
    throw new Error('No JSON object found in response');
  }
  const slice = body.slice(first, last + 1);
  return JSON.parse(slice);
}

// Standard JSON response helper for Edge handlers.
export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

export async function readJsonBody(req) {
  // Edge: req is a Request. Node fallback (server.js) wraps Node IncomingMessage
  // and sets req.json() too — see server.js.
  if (typeof req.json === 'function') return req.json();
  const text = await new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
  return JSON.parse(text || '{}');
}
