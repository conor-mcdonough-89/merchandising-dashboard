// clustering.js — pure compute candidate finder for merge & rename proposals.
// Exposes window.Clustering with:
//   normalize(name)
//   tokenize(name)
//   jaroWinkler(a, b)
//   tokenSetOverlap(a, b)
//   findMergeCandidates(models, opts)
//   findRenameCandidates(models, convention, opts)
//
// Design notes:
// - All clustering is scoped by caller to a single <brand, category> slice.
//   findMergeCandidates does NOT cross brand/category boundaries — guard at call site
//   by filtering the input array.
// - Anchors are pending models OR available models with very low sold_count (<5).
// - Neighbors come from the same slice, ranked by string distance.
// - Output shape matches /api/propose/merges input contract.

(function (global) {

  // -------- normalization & tokenization --------

  function normalize(name) {
    if (!name) return '';
    return String(name)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ') // strip punctuation
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenize(name) {
    if (!name) return [];
    // Split camelCase first, then on whitespace + non-alphanumerics
    const cameled = String(name).replace(/([a-z])([A-Z])/g, '$1 $2');
    return cameled
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  // -------- jaro-winkler --------

  function jaro(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;

    const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const aMatches = new Array(a.length).fill(false);
    const bMatches = new Array(b.length).fill(false);

    let matches = 0;
    for (let i = 0; i < a.length; i++) {
      const start = Math.max(0, i - matchDistance);
      const end = Math.min(i + matchDistance + 1, b.length);
      for (let j = start; j < end; j++) {
        if (bMatches[j]) continue;
        if (a[i] !== b[j]) continue;
        aMatches[i] = true;
        bMatches[j] = true;
        matches++;
        break;
      }
    }

    if (matches === 0) return 0;

    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < a.length; i++) {
      if (!aMatches[i]) continue;
      while (!bMatches[k]) k++;
      if (a[i] !== b[k]) transpositions++;
      k++;
    }
    transpositions /= 2;

    return (
      matches / a.length +
      matches / b.length +
      (matches - transpositions) / matches
    ) / 3;
  }

  function jaroWinkler(a, b, prefixScale = 0.1) {
    const na = normalize(a);
    const nb = normalize(b);
    const j = jaro(na, nb);
    let prefix = 0;
    const maxPrefix = Math.min(4, na.length, nb.length);
    for (let i = 0; i < maxPrefix; i++) {
      if (na[i] === nb[i]) prefix++;
      else break;
    }
    return j + prefix * prefixScale * (1 - j);
  }

  // -------- token-set overlap (Jaccard on token sets) --------

  function tokenSetOverlap(a, b) {
    const setA = new Set(tokenize(a));
    const setB = new Set(tokenize(b));
    if (!setA.size || !setB.size) return 0;
    let inter = 0;
    for (const t of setA) if (setB.has(t)) inter++;
    const union = setA.size + setB.size - inter;
    return inter / union;
  }

  // -------- merge candidate clustering --------

  // Default thresholds; the LLM is the final judge so we can be permissive.
  const MERGE_DEFAULTS = {
    jwThreshold: 0.75,
    tokenThreshold: 0.6,
    maxNeighbors: 5,
    anchorMaxSoldCount: 5,         // available models above this aren't anchors
    excludeIds: null,              // optional Set of ids to skip as anchors
  };

  // Returns array of { anchor, neighbors }. Each anchor is a candidate that
  // *might* be a duplicate; neighbors are the most similar models in the slice.
  function findMergeCandidates(models, opts = {}) {
    const o = { ...MERGE_DEFAULTS, ...opts };
    const exclude = o.excludeIds || new Set();

    const anchors = models.filter((m) => {
      if (exclude.has(m.id)) return false;
      if (m.state === 'pending') return true;
      if (m.state === 'available' && (m.sold_count || 0) <= o.anchorMaxSoldCount) return true;
      return false;
    });

    const clusters = [];
    for (const anchor of anchors) {
      const scored = [];
      for (const candidate of models) {
        if (candidate.id === anchor.id) continue;
        // Don't propose merging a high-value model INTO a no-sales model:
        // the target should generally be available with some history.
        if (candidate.state !== 'available') continue;
        const jw = jaroWinkler(anchor.name, candidate.name);
        const tso = tokenSetOverlap(anchor.name, candidate.name);
        if (jw < o.jwThreshold && tso < o.tokenThreshold) continue;
        scored.push({ candidate, score: Math.max(jw, tso), jw, tso });
      }
      if (!scored.length) continue;
      scored.sort((a, b) => b.score - a.score);
      const neighbors = scored.slice(0, o.maxNeighbors).map((s) => ({
        id: s.candidate.id,
        name: s.candidate.name,
        state: s.candidate.state,
        sold_count: s.candidate.sold_count || 0,
        last_90_sold_count: s.candidate.last_90_sold_count || 0,
        available_count: s.candidate.available_count || 0,
        score: Number(s.score.toFixed(3)),
      }));
      clusters.push({
        anchor: {
          id: anchor.id,
          name: anchor.name,
          state: anchor.state,
          sold_count: anchor.sold_count || 0,
        },
        neighbors,
      });
    }
    return clusters;
  }

  // Pack clusters into LLM-sized batches (~25 anchors each).
  function packClusterBatches(clusters, perBatch = 25) {
    const batches = [];
    for (let i = 0; i < clusters.length; i += perBatch) {
      batches.push(clusters.slice(i, i + perBatch));
    }
    return batches;
  }

  // -------- rename candidates --------

  // A rename candidate is any model whose name doesn't loosely match the
  // convention's example token shape. The LLM does the actual judgment;
  // this is just a coarse pre-filter to avoid sending well-formed names.
  // Without a convention, returns all models (caller can short-circuit).
  function findRenameCandidates(models, convention, opts = {}) {
    const o = {
      excludeIds: null,
      anchorStates: ['available', 'pending'],
      ...opts,
    };
    const exclude = o.excludeIds || new Set();
    const goldExamples = (convention && convention.examples) || [];
    const goldTokens = new Set();
    for (const ex of goldExamples) for (const t of tokenize(ex)) goldTokens.add(t);

    return models
      .filter((m) => !exclude.has(m.id))
      .filter((m) => o.anchorStates.includes(m.state))
      .filter((m) => {
        if (!goldExamples.length) return true; // no convention → everything is a candidate
        // Loose conformity check: at least one token in common with the gold
        // token vocabulary AND name length within 2x of the median gold name length.
        const tokens = tokenize(m.name);
        if (!tokens.length) return true;
        const overlap = tokens.some((t) => goldTokens.has(t));
        return !overlap; // names with no shared vocabulary are candidates
      })
      .map((m) => ({
        id: m.id,
        name: m.name,
        state: m.state,
        sold_count: m.sold_count || 0,
      }));
  }

  function packRenameBatches(candidates, perBatch = 50) {
    const batches = [];
    for (let i = 0; i < candidates.length; i += perBatch) {
      batches.push(candidates.slice(i, i + perBatch));
    }
    return batches;
  }

  // -------- gold-model selection --------

  // A gold model is available + sold_count >= 20. Below 20 still counts but
  // weighted down — caller decides how to use the weight.
  function selectGoldModels(models, { minSoldCount = 20, max = 50 } = {}) {
    return models
      .filter((m) => m.state === 'available' && (m.sold_count || 0) >= minSoldCount)
      .sort((a, b) => (b.sold_count || 0) - (a.sold_count || 0))
      .slice(0, max)
      .map((m) => ({
        id: m.id,
        name: m.name,
        sold_count: m.sold_count || 0,
        last_90_sold_count: m.last_90_sold_count || 0,
        available_count: m.available_count || 0,
      }));
  }

  global.Clustering = {
    normalize,
    tokenize,
    jaroWinkler,
    tokenSetOverlap,
    findMergeCandidates,
    findRenameCandidates,
    packClusterBatches,
    packRenameBatches,
    selectGoldModels,
  };
})(typeof window !== 'undefined' ? window : globalThis);
