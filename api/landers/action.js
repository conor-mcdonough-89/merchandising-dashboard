// api/landers/action.js — Edge Function. Translates a natural-language bulk
// action ("set these to removed", "make these discoverable") into a structured
// set of field changes applied to every selected lander. The LLM emits a single
// changes object — not per-lander — over a strict whitelist (state, discoverable).

import { SONNET_MODEL, callAnthropic, extractJson, json, readJsonBody } from '../anthropic.js';

export const config = { runtime: 'edge' };

const LANDER_STATES = ['available', 'redirect', 'removed', 'draft'];

const SYSTEM_PROMPT = `You translate a SidelineSwap operator's plain-English bulk instruction into a JSON object of field changes that will be applied to every lander they selected.

You may only change these two fields:
- state: one of ${LANDER_STATES.join(' | ')}.
- discoverable: a boolean (true = surfaced in nav / site search; false = hidden).

Return JSON only, this exact shape (omit fields you aren't changing):
{
  "changes": {
    "state": <"available"|"redirect"|"removed"|"draft">,   // optional
    "discoverable": <true|false>                            // optional
  },
  "explanation": "<one short sentence describing the change>",
  "refusal": <string|null>   // set only if the instruction can't be expressed in the two allowed fields; then changes must be empty
}

Vocabulary:
- "set to removed", "remove these", "delete", "take down" → state="removed".
- "set to available", "publish", "make live", "go live" → state="available".
- "set to draft", "unpublish" → state="draft".
- "set to redirect", "301 these" → state="redirect".
- "make discoverable", "surface in nav", "show in search" → discoverable=true.
- "hide", "make not discoverable", "remove from nav" → discoverable=false.

Rules:
- Only ever populate the two allowed fields. If the operator asks for anything else (rename, change slug, edit blocks, merge, etc.), set "refusal" explaining you can only change state and discoverable, and leave "changes" empty.
- An instruction may set both fields ("remove these and hide them" → state="removed", discoverable=false).
- Never invent SQL. Never return any other JSON shape.`;

function sanitize(parsed) {
  const c = (parsed && parsed.changes) || {};
  const changes = {};
  if (LANDER_STATES.includes(c.state)) changes.state = c.state;
  if (c.discoverable === true || c.discoverable === false) changes.discoverable = c.discoverable;
  const refusal = typeof (parsed && parsed.refusal) === 'string' && parsed.refusal.trim()
    ? parsed.refusal.trim().slice(0, 400)
    : null;
  return {
    changes: refusal ? {} : changes,
    explanation: typeof (parsed && parsed.explanation) === 'string' ? parsed.explanation.slice(0, 400) : '',
    refusal: refusal || (Object.keys(changes).length ? null : 'Could not map that instruction to a state or discoverable change.'),
  };
}

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
  const instruction = payload && typeof payload.instruction === 'string' ? payload.instruction.trim() : '';
  if (!instruction) return json({ error: 'instruction is required' }, { status: 400 });

  try {
    const { text } = await callAnthropic({
      model: SONNET_MODEL,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      user: `Operator instruction: ${instruction}`,
      max_tokens: 512,
      temperature: 0.0,
    });
    const parsed = extractJson(text);
    return json(sanitize(parsed));
  } catch (e) {
    const code = e.code === 'NO_API_KEY' ? 500 : (e.status || 500);
    return json({ error: e.message }, { status: code });
  }
}
