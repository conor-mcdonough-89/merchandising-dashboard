// api/propose/renames.js — Edge Function. Proposes canonical names for
// models whose current names violate the brand/category convention.

import { SONNET_MODEL, callAnthropic, extractJson, json, readJsonBody } from '../anthropic.js';

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are a catalog naming assistant for SidelineSwap. Your job is to propose canonical names for models whose current names don't match the established naming convention for their brand and category.

You will receive:
- A brand and category
- The naming convention for this brand+category (pattern, examples, rules, exceptions)
- A list of candidate models with non-conforming names

For each candidate, propose either a canonical name that follows the convention, or refuse with a reason.

Be conservative. Only rename when the canonical form is unambiguous. If the model could legitimately be one of several canonical names, refuse and explain.

Preserve information. If the original name encodes something useful (e.g., a generation number, a material), preserve it in the canonical form. Don't drop signal in the name of conformity.

Special editions and collabs that don't fit the convention are usually intentional. Refuse to rename them and note the exception unless the rename is purely typographic (e.g., "hype Ice Arctic Flame 'limited'" → "Hype Fire Arctic Flame Limited Edition").

Return JSON only matching this exact shape:
{
  "proposals": [
    {
      "source_id": <number>,
      "source_name": "<string>",
      "new_name": "<string>",
      "confidence": <number 0..1>,
      "reasoning": "<string>"
    }
  ],
  "rejections": [
    { "source_id": <number>, "source_name": "<string>", "reasoning": "<string>" }
  ]
}

Every candidate in the input MUST appear in either proposals or rejections. Do not invent ids.`;

function buildUserMessage({ brand_name, category_full_name, convention, candidates, gold_models }) {
  return [
    `Brand: ${brand_name}`,
    `Category: ${category_full_name}`,
    '',
    `Naming convention for this brand+category:`,
    JSON.stringify(convention || { note: 'No convention provided — infer from gold models below.' }, null, 2),
    '',
    `Gold-standard models (reference for canonical naming, ${(gold_models || []).length}):`,
    JSON.stringify(gold_models || [], null, 2),
    '',
    `Candidates to evaluate (${(candidates || []).length}):`,
    JSON.stringify(candidates || [], null, 2),
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
  if (!Array.isArray(payload.candidates) || !payload.candidates.length) {
    return json({ proposals: [], rejections: [] });
  }

  try {
    const { text } = await callAnthropic({
      model: SONNET_MODEL,
      system: SYSTEM_PROMPT,
      user: buildUserMessage(payload),
      max_tokens: 4096,
      temperature: 0.1,
    });
    const parsed = extractJson(text);
    return json({
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      rejections: Array.isArray(parsed.rejections) ? parsed.rejections : [],
    });
  } catch (e) {
    const code = e.code === 'NO_API_KEY' ? 500 : (e.status || 500);
    return json({ error: e.message }, { status: code });
  }
}
