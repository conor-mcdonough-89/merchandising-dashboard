// api/propose/merges.js — Edge Function. Proposes which candidate models
// should fold into which existing model.

import { SONNET_MODEL, callAnthropic, extractJson, json, readJsonBody } from '../anthropic.js';

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are a catalog operations assistant for SidelineSwap, a sporting goods marketplace. Your job is to identify when one model name is a duplicate of another model that already exists in the catalog.

You will receive:
- A brand name and a category (e.g., "Marucci, Baseball > Bats")
- A list of "gold standard" models — these are canonical, correctly-named, well-merchandised models with proven sales history. Trust their naming.
- Candidate clusters: each cluster has one "anchor" (a model that may be a duplicate) and 1-5 "neighbors" (existing models that string-distance suggests it might fold into).

For each anchor, decide:
1. Is this clearly a duplicate of one specific neighbor? If so, propose a merge with confidence 0.85+.
2. Is it likely a duplicate but ambiguous (e.g., could be Alloy or Composite version)? Propose with confidence 0.5-0.8 and explain the ambiguity.
3. Is it not a duplicate, or too ambiguous to merge confidently? Reject with a reason.

Bias toward rejecting when uncertain. False merges destroy sales history; missed merges can be caught next run.

When the anchor name has typos, abbreviations, or extra noise (sizes, model numbers, "limited edition"), look past those — match the underlying model. "Marucci catx", "CATX MSBLX8USA", and "Cat x" all likely fold into "CATX Alloy" or "CATX Composite". Use the gold models to disambiguate which.

Special editions ("Arctic Flame", "Pool Party", "Pencil") fold into their parent model in v1. Don't propose creating new parent models for special editions.

Return JSON only matching this exact shape:
{
  "proposals": [
    {
      "source_id": <number>,
      "source_name": "<string>",
      "target_id": <number>,
      "target_name": "<string>",
      "confidence": <number 0..1>,
      "reasoning": "<string>"
    }
  ],
  "rejections": [
    { "source_id": <number>, "source_name": "<string>", "reasoning": "<string>" }
  ]
}

Every anchor in the input MUST appear in either proposals or rejections. Do not invent ids — use ids from the input.`;

// Split into static prefix + variable suffix so the prefix can be marked
// with cache_control: ephemeral. Anthropic prompt caching keys on content
// hash, so as long as the brand / category / gold models are identical
// across batches in a single run, every batch after the first reads the
// cached prefix and only the candidate clusters get re-tokenized.
function buildStaticPrefix({ brand_name, category_full_name, gold_models }) {
  return [
    `Brand: ${brand_name}`,
    `Category: ${category_full_name}`,
    '',
    `Gold-standard models (${(gold_models || []).length}):`,
    JSON.stringify(gold_models || [], null, 2),
  ].join('\n');
}

function buildVariableSuffix({ candidate_clusters }) {
  return [
    '',
    `Candidate clusters (${(candidate_clusters || []).length}):`,
    JSON.stringify(candidate_clusters || [], null, 2),
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
  if (!Array.isArray(payload.candidate_clusters) || !payload.candidate_clusters.length) {
    return json({ proposals: [], rejections: [] });
  }

  try {
    const { text } = await callAnthropic({
      model: SONNET_MODEL,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      user: [
        { type: 'text', text: buildStaticPrefix(payload), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: buildVariableSuffix(payload) },
      ],
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
