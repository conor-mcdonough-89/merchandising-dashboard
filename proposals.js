// proposals.js — client-side orchestrator for the LLM endpoints.
// Calls /api/propose/* with the right payloads, batches large slices,
// and filters out previously-rejected source ids.

(function (global) {

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `POST ${url} ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error) msg = data.error;
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    return res.json();
  }

  // Run an async fn over `items` with at most `limit` in flight. Results are
  // returned in order with { ok, value } | { ok: false, error }. Used to
  // dispatch per-batch LLM calls in parallel without overwhelming Anthropic's
  // rate limit. The first batch primes Anthropic's prompt cache; subsequent
  // batches hit it -- parallelism + caching compound rather than fight.
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        try { results[i] = { ok: true, value: await fn(items[i], i) }; }
        catch (e) { results[i] = { ok: false, error: e }; }
      }
    });
    await Promise.all(workers);
    return results;
  }

  function buildSlice(models, { brandName = null, categoryId = null } = {}) {
    return models.filter((m) => {
      if (brandName != null && m.brand_name !== brandName) return false;
      if (categoryId != null && m.category_id !== categoryId) return false;
      return true;
    });
  }

  // Group a model list by <brand_name, category_full_name>.
  function groupByBrandCategory(models) {
    const map = new Map();
    for (const m of models) {
      const key = `${m.brand_name}|||${m.category_full_name || m.category_id}`;
      if (!map.has(key)) {
        map.set(key, {
          brandName: m.brand_name,
          brandId: m.brand_id,
          categoryId: m.category_id,
          categoryFullName: m.category_full_name || m.category_name,
          models: [],
        });
      }
      map.get(key).models.push(m);
    }
    return Array.from(map.values());
  }

  // Propose merges across a slice. The slice should already be scoped to
  // a single category (and ideally a single brand for tighter clusters).
  async function proposeMerges({ brandName, categoryFullName, models, onProgress }) {
    const rejected = await Storage.getRejections();
    const goldModels = Clustering.selectGoldModels(models);
    const clusters = Clustering.findMergeCandidates(models, { excludeIds: rejected });
    if (!clusters.length) return { proposals: [], rejections: [], batches: 0 };

    const batches = Clustering.packClusterBatches(clusters, 10);
    const allProposals = [];
    const allRejections = [];
    const failedBatches = [];
    let done = 0;
    if (onProgress) onProgress({ done: 0, total: batches.length });
    const settled = await mapLimit(batches, 4, async (batch, i) => {
      const data = await postJson('/api/propose/merges', {
        brand_name: brandName,
        category_full_name: categoryFullName,
        gold_models: goldModels,
        candidate_clusters: batch,
      });
      done++;
      if (onProgress) onProgress({ done, total: batches.length });
      return { data, i };
    });
    for (const r of settled) {
      if (r.ok) {
        const { data } = r.value;
        if (Array.isArray(data.proposals)) allProposals.push(...data.proposals);
        if (Array.isArray(data.rejections)) allRejections.push(...data.rejections);
      } else {
        failedBatches.push({ error: r.error.message });
      }
    }
    return { proposals: allProposals, rejections: allRejections, batches: batches.length, failedBatches };
  }

  async function proposeRenames({ brandName, brandId, categoryFullName, categoryId, models, convention, categoryConvention, enableWebSearch, researchDirective, onProgress }) {
    const rejected = await Storage.getRejections();
    const conv = convention || (brandId != null ? await Storage.loadConvention(brandId, categoryId) : null);
    const goldModels = Clustering.selectGoldModels(models);
    const candidates = Clustering.findRenameCandidates(models, conv, { excludeIds: rejected });
    if (!candidates.length) return { proposals: [], rejections: [], batches: 0, convention: conv };

    const batches = Clustering.packRenameBatches(candidates, 20);
    const allProposals = [];
    const allRejections = [];
    const failedBatches = [];
    let done = 0;
    if (onProgress) onProgress({ done: 0, total: batches.length });
    // Web research narrows the safe parallelism budget -- each request may
    // spawn up to ~5 web_search calls server-side, and Anthropic counts those
    // against the same per-account rate limit. Keep the cap at 2 when research
    // is on; 4 otherwise.
    const concurrency = enableWebSearch ? 2 : 4;
    const settled = await mapLimit(batches, concurrency, async (batch, i) => {
      const data = await postJson('/api/propose/renames', {
        brand_name: brandName,
        category_full_name: categoryFullName,
        convention: conv,
        category_convention: categoryConvention || null,
        gold_models: goldModels,
        candidates: batch,
        enable_web_search: !!enableWebSearch,
        research_directive: researchDirective || null,
      });
      done++;
      if (onProgress) onProgress({ done, total: batches.length });
      return { data, i };
    });
    for (const r of settled) {
      if (r.ok) {
        const { data } = r.value;
        if (Array.isArray(data.proposals)) allProposals.push(...data.proposals);
        if (Array.isArray(data.rejections)) allRejections.push(...data.rejections);
      } else {
        failedBatches.push({ error: r.error.message });
      }
    }
    return { proposals: allProposals, rejections: allRejections, batches: batches.length, convention: conv, failedBatches };
  }

  async function inferConvention({ brandName, brandId, categoryFullName, categoryId, models }) {
    const goldModels = Clustering.selectGoldModels(models, { max: 80 });
    if (!goldModels.length) {
      throw new Error('No gold-standard models (state=available, sold_count>=20) in this brand+category. Cannot infer convention.');
    }
    const data = await postJson('/api/propose/conventions', {
      brand_name: brandName,
      category_full_name: categoryFullName,
      gold_models: goldModels,
    });
    return {
      brandId,
      brandName,
      categoryId,
      categoryFullName,
      pattern: data.pattern || '',
      examples: data.examples || [],
      rules: data.rules || [],
      exceptions: data.exceptions || [],
      inferredAt: new Date().toISOString(),
    };
  }

  global.Proposals = {
    proposeMerges,
    proposeRenames,
    inferConvention,
    buildSlice,
    groupByBrandCategory,
  };
})(typeof window !== 'undefined' ? window : globalThis);
