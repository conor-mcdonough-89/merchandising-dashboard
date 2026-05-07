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
    for (let i = 0; i < batches.length; i++) {
      if (onProgress) onProgress({ done: i, total: batches.length });
      try {
        const data = await postJson('/api/propose/merges', {
          brand_name: brandName,
          category_full_name: categoryFullName,
          gold_models: goldModels,
          candidate_clusters: batches[i],
        });
        if (Array.isArray(data.proposals)) allProposals.push(...data.proposals);
        if (Array.isArray(data.rejections)) allRejections.push(...data.rejections);
      } catch (e) {
        failedBatches.push({ index: i, error: e.message });
      }
    }
    if (onProgress) onProgress({ done: batches.length, total: batches.length });
    return { proposals: allProposals, rejections: allRejections, batches: batches.length, failedBatches };
  }

  async function proposeRenames({ brandName, brandId, categoryFullName, categoryId, models, convention, categoryConvention, onProgress }) {
    const rejected = await Storage.getRejections();
    const conv = convention || (brandId != null ? await Storage.loadConvention(brandId, categoryId) : null);
    const goldModels = Clustering.selectGoldModels(models);
    const candidates = Clustering.findRenameCandidates(models, conv, { excludeIds: rejected });
    if (!candidates.length) return { proposals: [], rejections: [], batches: 0, convention: conv };

    const batches = Clustering.packRenameBatches(candidates, 20);
    const allProposals = [];
    const allRejections = [];
    const failedBatches = [];
    for (let i = 0; i < batches.length; i++) {
      if (onProgress) onProgress({ done: i, total: batches.length });
      try {
        const data = await postJson('/api/propose/renames', {
          brand_name: brandName,
          category_full_name: categoryFullName,
          convention: conv,
          category_convention: categoryConvention || null,
          gold_models: goldModels,
          candidates: batches[i],
        });
        if (Array.isArray(data.proposals)) allProposals.push(...data.proposals);
        if (Array.isArray(data.rejections)) allRejections.push(...data.rejections);
      } catch (e) {
        failedBatches.push({ index: i, error: e.message });
      }
    }
    if (onProgress) onProgress({ done: batches.length, total: batches.length });
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
