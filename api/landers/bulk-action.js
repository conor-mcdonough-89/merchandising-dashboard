// api/landers/bulk-action.js — Edge Function. Translates a natural-language
// bulk-edit instruction ("Set all of these to removed") into a structured
// overrides spec the client applies to every selected lander before writing
// them into the bulk-import sheet.
//
// The LLM does NOT see SQL. It returns one set of overrides that applies to
// EVERY selected lander -- per-lander targeting belongs to the operator
// (they picked the rows). v1 allow-list of editable fields, per the user's
// scope:
//   - state                  ('available' | 'draft' | 'redirect' | 'removed')
//   - discoverable           (true | false)
//   - redirect_target_id     (integer or null to clear)
//   - title_tag              (string -- the SEO <title>)
//   - name                   (string -- the internal name; what "title" maps
//                             to when the operator uses that word casually)
//   - show_categories        (true | false)
//
// Anything outside the allow-list returns an empty overrides + a short
// explanation telling the operator what's editable.

import { SONNET_MODEL, callAnthropic, extractJson, json, readJsonBody } from '../anthropic.js';

export const config = { runtime: 'edge' };

const LANDER_STATES = ['available', 'draft', 'redirect', 'removed'];

const SYSTEM_PROMPT = `You are a bulk-edit translator for SidelineSwap's landing-page tool. An operator has selected a list of landers and described, in plain English, what they want changed about all of them. Translate that into a single JSON "overrides" object that the client will apply to every selected lander before writing them to a Google Sheet for engineering's bulk importer.

Allow-list of editable fields (v1). Refuse anything outside this set:
- state: one of "available", "draft", "redirect", "removed".
- discoverable: true or false.
- redirect_target_id: integer (lander id to redirect to). Pass null to clear.
- title_tag: string. The SEO <title> shown in browser tabs / search results.
- name: string. The internal name. When the operator says "title" without "tag", interpret it as name unless the context is clearly about SEO.
- show_categories: true or false.

Return JSON only in this exact shape (omit keys you're not setting, or set them to null):
{
  "overrides": {
    "state": "available"|"draft"|"redirect"|"removed"|null,
    "discoverable": true|false|null,
    "redirect_target_id": <integer>|null,
    "title_tag": <string>|null,
    "name": <string>|null,
    "show_categories": true|false|null
  },
  "explanation": "<one short sentence describing what will be applied>"
}

Rules:
- Apply the SAME overrides to every selected lander. If the operator's request implies per-lander logic ("rename these uniquely"), refuse with an empty overrides and explain that bulk v1 applies one value to all selected rows.
- Refuse out-of-scope requests with { "overrides": {}, "explanation": "X is not editable in bulk v1. Editable: state, discoverable, redirect_target_id, title_tag, name, show_categories." }.
- "remove" / "take down" / "delete" → state = "removed". "publish" / "go live" → "available". "unpublish" / "draft" → "draft". "redirect this somewhere" without a target → refuse and ask for a target.
- For redirect_target_id, prefer a numeric id. If the operator gives a slug, look it up in the candidates' selected-lander list when possible; otherwise refuse.
- Never invent SQL. Never return any other JSON shape.`;

function clamp(value, allowed) {
  return allowed.includes(value) ? value : null;
}

function sanitize(parsed) {
  const o = (parsed && parsed.overrides) || {};
  const overrides = {};
  const state = clamp(o.state, LANDER_STATES);
  if (state) overrides.state = state;
  if (o.discoverable === true || o.discoverable === false) overrides.discoverable = o.discoverable;
  if (o.redirect_target_id != null) {
    const n = Number(o.redirect_target_id);
    if (Number.isFinite(n) && n >= 0) overrides.redirect_target_id = Math.trunc(n);
  }
  if (typeof o.title_tag === 'string' && o.title_tag) overrides.title_tag = o.title_tag.slice(0, 500);
  if (typeof o.name === 'string' && o.name) overrides.name = o.name.slice(0, 500);
  if (o.show_categories === true || o.show_categories === false) overrides.show_categories = o.show_categories;
  return {
    overrides,
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation.slice(0, 400) : '',
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
  const message = payload && typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!message) return json({ error: 'message is required' }, { status: 400 });

  // The selected landers' current editable-field values. Lets the LLM
  // resolve slug-based redirect targets and double-check the request makes
  // sense for the actual rows in scope. We cap the count + per-row size to
  // keep the prompt bounded.
  const landers = Array.isArray(payload.landers) ? payload.landers.slice(0, 200) : [];
  const summaries = landers.map((l) => ({
    id: Number(l.id),
    slug: String(l.slug || '').slice(0, 200),
    name: String(l.name || '').slice(0, 200),
    state: String(l.state || '').slice(0, 32),
    discoverable: l.discoverable === 1 || l.discoverable === true,
    type: String(l.type || '').slice(0, 32),
    redirect_target_id: l.redirect_target_id == null ? null : Number(l.redirect_target_id),
  })).filter((s) => Number.isFinite(s.id));

  const userText = [
    `Operator request: ${message}`,
    `Selected landers (${summaries.length} total, showing up to 200):`,
    JSON.stringify(summaries),
  ].join('\n');

  try {
    const { text } = await callAnthropic({
      model: SONNET_MODEL,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      user: userText,
      max_tokens: 1024,
      temperature: 0.0,
    });
    const parsed = extractJson(text);
    return json(sanitize(parsed));
  } catch (e) {
    const code = e.code === 'NO_API_KEY' ? 500 : (e.status || 500);
    return json({ error: e.message }, { status: code });
  }
}
