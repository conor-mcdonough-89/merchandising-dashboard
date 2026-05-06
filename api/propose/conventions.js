// api/propose/conventions.js — Edge Function. Infers the naming convention
// from gold-standard models for one <brand, category> pair. Uses Opus.

import { OPUS_MODEL, callAnthropic, extractJson, json, readJsonBody } from '../anthropic.js';

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are a catalog naming analyst for SidelineSwap. Your job is to look at a brand's well-merchandised models in a category and codify the naming convention they collectively follow.

You will receive a list of gold-standard models for one <brand, category> pair, with their names, sold_counts, and other metadata.

Identify:
1. The high-level pattern (e.g., "<Series><Generation> <Material>")
2. 5-8 representative examples drawn from the gold models
3. 3-7 specific rules (capitalization, spacing, allowed values for each token, ordering)
4. Notable exceptions (collabs, legacy names, special editions that don't fit the pattern but are valid)

Be specific. "Material is one of: Alloy, Composite, Hybrid" is useful. "Material varies" is not.

Look for tension. If 80% of models follow Pattern A and 20% follow Pattern B, both might be valid sub-conventions (e.g., "older models drop the material suffix"). Document the split rather than forcing one pattern.

Return JSON only matching this exact shape:
{
  "brand": "<string>",
  "category": "<string>",
  "pattern": "<string>",
  "examples": ["<string>", ...],
  "rules": ["<string>", ...],
  "exceptions": ["<string>", ...]
}`;

function buildUserMessage({ brand_name, category_full_name, gold_models }) {
  return [
    `Brand: ${brand_name}`,
    `Category: ${category_full_name}`,
    '',
    `Gold-standard models (${(gold_models || []).length}):`,
    JSON.stringify(gold_models || [], null, 2),
  ].join('\n');
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!payload || !payload.brand_name || !payload.category_full_name) {
    return json({ error: 'brand_name and category_full_name are required' }, { status: 400 });
  }
  if (!Array.isArray(payload.gold_models) || !payload.gold_models.length) {
    return json({ error: 'gold_models is required and must be non-empty' }, { status: 400 });
  }

  try {
    const { text } = await callAnthropic({
      model: OPUS_MODEL,
      system: SYSTEM_PROMPT,
      user: buildUserMessage(payload),
      max_tokens: 2048,
      temperature: 0.2,
    });
    const parsed = extractJson(text);
    return json({
      brand: parsed.brand || payload.brand_name,
      category: parsed.category || payload.category_full_name,
      pattern: parsed.pattern || '',
      examples: Array.isArray(parsed.examples) ? parsed.examples : [],
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      exceptions: Array.isArray(parsed.exceptions) ? parsed.exceptions : [],
    });
  } catch (e) {
    const code = e.code === 'NO_API_KEY' ? 500 : (e.status || 500);
    return json({ error: e.message }, { status: code });
  }
}
