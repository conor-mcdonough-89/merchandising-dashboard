// api/landers/chat.js — Edge Function. Translates a natural-language
// landing-page query into a structured filter spec that the Landers tool
// applies client-side. The LLM does not emit SQL; the spec maps onto the
// existing filter primitives in landers.js.

import { SONNET_MODEL, callAnthropic, extractJson, json, readJsonBody } from '../anthropic.js';

export const config = { runtime: 'edge' };

const BLOCK_COLUMNS = ['layout', 'data_type', 'name', 'title', 'destination'];
const STRING_OPS = ['equals', 'contains'];
const NUM_OPS = ['>', '<', '>=', '<=', '=', 'between'];
const LANDER_STATES = ['available', 'redirected', 'removed', 'draft'];
const TRISTATE = ['has', 'none', 'any'];

const SYSTEM_PROMPT = `You are a query translator for SidelineSwap's landing-page (lander) tool. Operators describe what they're looking for in natural language; you translate that into a structured JSON filter spec.

The lander data model:
- Each lander has: id, slug, name, title_tag, query, type, state, discoverable (boolean), available_count (integer), page_view_id (nullable), redirect_target_id (nullable).
- states: ${LANDER_STATES.join(' | ')}.
- A lander may have an attached page_view, which holds a list of blocks (page_view_blocks). Each block has: layout, data_type, name, title, destination. A block may have attached tiles via attachable_tiles (the "tile_count" predicate counts these).

Allowed operators:
- String filters (slug, name, query, title_tag) are "contains" (case-insensitive substring).
- Block column filters use op = "equals" | "contains" over one of: ${BLOCK_COLUMNS.join(', ')}.
- Numeric op for available_count and tile_count: one of ${NUM_OPS.join(', ')}. If "between", value must be [lo, hi].
- has_page_view and has_block are tri-state: "has" | "none" | "any". "any" means no constraint.

Return JSON only matching this exact shape (use null for any unset field):
{
  "filters": {
    "slug_contains": <string|null>,
    "query_contains": <string|null>,
    "name_contains": <string|null>,
    "type": <string|null>,
    "state": <"available"|"redirected"|"removed"|"draft"|null>,
    "discoverable": <true|false|null>,
    "available_count": { "op": ">|<|>=|<=|=|between", "value": <number or [lo,hi]> } | null,
    "has_page_view": "has" | "none" | null
  },
  "block": {
    "enabled": <boolean>,
    "column": "layout|data_type|name|title|destination" | null,
    "op": "equals" | "contains" | null,
    "value": <string|null>,
    "tile_count": { "op": ">|<|>=|<=|=|between", "value": <number or [lo,hi]> } | null
  },
  "has_block": "has" | "none" | null,
  "explanation": "<one short sentence describing what filters were applied>"
}

Rules:
- Map block keywords to columns intelligently. "top-models block" → block.column="layout", block.op="equals", block.value="top_models". "buying-guide block" → block.column="data_type", block.op="contains", block.value="buying_guide". "block named X" → column="name", op="contains".
- "with more than one tile" → block.tile_count = { op: ">", value: 1 }.
- "model" in the query field means query_contains="model".
- If the request can't be expressed in this schema, return all-null filters and put a short note in explanation. Never invent SQL. Never return any other JSON shape.

Natural-language vocabulary (operators speak in shorthand — translate it):

Sport landers. "Golf landers", "baseball landers", "hockey landers" etc. are NOT a separate type — they mean landers whose slug contains the sport name. Map "<sport> landers" → slug_contains: "<sport>".

Lander archetypes (colloquial — all map to slug_contains and/or type, NOT to a dedicated archetype field):
- "parent category lander" → a sport-level slug like "hockey", "golf" (slug_contains the sport, no hyphens implied).
- "child category lander" → a sport + sub-category slug like "hockey-sticks". Use slug_contains with the relevant token.
- "relatable category lander" / "terminal category" → a leaf-category slug like "baseball-gloves".
- "category detail lander" → slug combining a category with an attribute (e.g. "flex-85-hockey-sticks", "left-handed-baseball-gloves").
- "brand category lander" / "brand detail lander" → slug combining a brand and category (e.g. "easton-baseball-bats", "bauer-hockey-sticks"). Use slug_contains with brand or "<brand>-<category>".
- "model lander" / "supermodel page" / "best of" / "top models page" → type = "model" (the schema type, distinct from a brand category lander).

Lander type mappings:
- "general lander", "standard page", "results page" → type = "general".
- "supermodel", "model page", "best of" → type = "model".
- "navigation page", "merchandised page", "no results grid" → type = "navigation".
- "category page", "category lander", "category-affiliated" → type = "category".

State mappings:
- "live", "published", "active page", "available" → state = "available".
- "draft", "unpublished", "not live" → state = "draft".
- "redirect", "301", "forwarded" → state = "redirected" (note: emit "redirected", not "redirect").
- "removed", "deleted", "taken down" → state = "removed".

Discoverability:
- "discoverable", "surfaced in nav", "in site search" → discoverable = true.
- "hidden", "not discoverable", "not in nav" → discoverable = false.

Block layout vocabulary (block.column = "layout", block.op = "equals", block.value = …):
- "top models", "popular models", "models carousel", "popular model carousel" → "top-models".
- "results", "listings grid", "search results grid" → "results".
- "FAQ", "model review", "Butter content", "CMS content", "collapsible content" → "collapsable-content-butter".
- "blog", "articles", "editorial", "blog carousel", "blog post grid" → "blog-post-grid-3".
- "trending", "horizontal scroll", "item carousel", "trending listings" → "item-grid-horizontal-scroll".
- "featured categories", "category header", "merchandised categories" → "lander-featured-categories".
- "SEO content", "content teaser", "content preview" → "content-preview".

Block name/title/destination/data_type:
- "block named X", "block called X" → block.column="name", op="contains", value="X".
- "block titled X", "section heading X" → block.column="title", op="contains".
- "block linking to X", "block destination X" → block.column="destination", op="contains".
- "buying guide block", "block of type X" → block.column="data_type", op="contains".

Tiles:
- "with N tiles", "block has N items", "more than N items in the block" → block.tile_count.
- "with at least one tile" → block.tile_count = { op: ">=", value: 1 }.

Examples:
- "Find me golf landers with popular model carousels" → filters.slug_contains="golf", block.enabled=true, block.column="layout", block.op="equals", block.value="top-models".
- "Live hockey-stick category pages with a featured-categories header" → filters.slug_contains="hockey-sticks", filters.state="available", block.column="layout", block.op="equals", block.value="lander-featured-categories".
- "Draft supermodel pages with no blocks" → filters.type="model", filters.state="draft", has_block="none".
- "Bauer hockey stick landers redirecting somewhere" → filters.slug_contains="bauer-hockey", filters.state="redirected".`;

function clamp(value, allowed) {
  return allowed.includes(value) ? value : null;
}

function sanitizeNumPred(p) {
  if (!p || typeof p !== 'object') return null;
  const op = clamp(p.op, NUM_OPS);
  if (!op) return null;
  if (op === 'between') {
    if (!Array.isArray(p.value) || p.value.length !== 2) return null;
    const lo = Number(p.value[0]); const hi = Number(p.value[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    return { op, value: [lo, hi] };
  }
  const v = Number(p.value);
  if (!Number.isFinite(v)) return null;
  return { op, value: v };
}

function sanitize(parsed) {
  const f = (parsed && parsed.filters) || {};
  const b = (parsed && parsed.block) || {};
  const filters = {
    slug_contains: typeof f.slug_contains === 'string' ? f.slug_contains.slice(0, 100) : null,
    query_contains: typeof f.query_contains === 'string' ? f.query_contains.slice(0, 100) : null,
    name_contains: typeof f.name_contains === 'string' ? f.name_contains.slice(0, 100) : null,
    type: typeof f.type === 'string' ? f.type.slice(0, 50) : null,
    state: clamp(f.state, LANDER_STATES),
    discoverable: f.discoverable === true || f.discoverable === false ? f.discoverable : null,
    available_count: sanitizeNumPred(f.available_count),
    has_page_view: clamp(f.has_page_view, ['has', 'none']),
  };
  const block = {
    enabled: !!b.enabled,
    column: clamp(b.column, BLOCK_COLUMNS),
    op: clamp(b.op, STRING_OPS),
    value: typeof b.value === 'string' ? b.value.slice(0, 100) : null,
    tile_count: sanitizeNumPred(b.tile_count),
  };
  // If block is "enabled" but missing required fields, disable it.
  if (block.enabled && (!block.column || !block.op || !block.value)) {
    block.enabled = false;
  }
  return {
    filters,
    block,
    has_block: clamp(parsed && parsed.has_block, ['has', 'none']),
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

  // Optional list of synced lander types/states so the LLM stays grounded in
  // values that actually exist in the operator's cache. Caller passes these
  // up from landers.js; we tolerate absence.
  const knownTypes = Array.isArray(payload.known_types) ? payload.known_types.slice(0, 50) : [];
  const knownStates = Array.isArray(payload.known_states) ? payload.known_states.slice(0, 10) : [];

  const userText = [
    `Operator request: ${message}`,
    knownTypes.length ? `Known lander types in the synced cache: ${knownTypes.join(', ')}` : '',
    knownStates.length ? `Lander states synced in the cache: ${knownStates.join(', ')}` : '',
  ].filter(Boolean).join('\n');

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
