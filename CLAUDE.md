# SidelineSwap Merch Dashboard

Password-gated, multi-sport model-merchandising tool for SidelineSwap's catalog operators.
Vanilla HTML/CSS/JS, no build step, IndexedDB persistence, Vercel-hosted with
Edge Function proxies. Mirrors the architecture of the sibling `data-dashboard` project.

This tool helps operators clean up the catalog of "models" (product families like
*Easton Hype Fire Composite* or *Marucci CATX Composite*) by proposing **merges**
(folding duplicates into existing models) and **renames** (canonicalizing inconsistent
names against a brand+category convention). Both kinds of approval are batched into a
**bulk import CSV** — engineering imports the CSV manually; this tool does not write
to the catalog.

---

## File map

| File | Role |
| --- | --- |
| `index.html` | Single-page shell. Password gate, sync overlay, proposal-review modal, convention modal, confirm dialog, sheet side-panel, toasts. Loads scripts in order: `storage.js`, `metabase.js`, `clustering.js`, `proposals.js`, `dashboard.js`. |
| `dashboard.js` | All UI rendering. `Dashboard.init()` is the entry point. Owns sport tabs, sport overview, category panel, skill flows, proposal review modal, sheet builder, CSV export. |
| `metabase.js` | Metabase client. BigQuery SQL templates (sports + models), session-token auth with API-key fallback, `/api/dataset/json` streaming for full result sets. All HTTP through `/api/metabase/*`. |
| `clustering.js` | Pure compute. `Clustering.findMergeCandidates(models)`, `Clustering.findRenameCandidates(models, convention)`, `Clustering.jaroWinkler(a, b)`, `Clustering.tokenSetOverlap(a, b)`, `Clustering.selectGoldModels(models)`, `Clustering.packClusterBatches(...)`. |
| `proposals.js` | Client-side LLM orchestrator. `Proposals.proposeMerges`, `Proposals.proposeRenames`, `Proposals.inferConvention`. Batches large slices and filters previously-rejected source ids. |
| `storage.js` | IndexedDB schema. Object stores: `sports`, `conventions`, `decisions`, `sheet`. Public API: `openDB`, `saveSport`, `loadSport`, `listSports`, `saveConvention`, `loadConvention`, `recordDecision`, `getRejections`, `clearExpiredDecisions`, `addSheetEntry`, `removeSheetEntry`, `listSheetEntries`, `clearSheet`. |
| `style.css` | Hand-written dark theme. Variables in `:root`. No frameworks. |
| `api/metabase-proxy.js` | Vercel Edge Function. Streams `/api/metabase/*` to `${METABASE_URL}/*`. Pass-through for body and headers. |
| `api/anthropic.js` | Shared Anthropic API helper. Holds the model-id constants `SONNET_MODEL` and `OPUS_MODEL` so swaps happen in one place. Validates `ANTHROPIC_API_KEY`. |
| `api/propose/merges.js` | Edge Function. POST → calls Anthropic (Sonnet) with the merge system prompt → returns JSON. |
| `api/propose/renames.js` | Edge Function. POST → calls Anthropic (Sonnet) with the rename system prompt → returns JSON. |
| `api/propose/conventions.js` | Edge Function. POST → calls Anthropic (Opus) with the convention system prompt → returns JSON. |
| `server.js` | Zero-dep Node fallback for self-hosting. Serves the static SPA and mirrors the Edge Functions. Node ≥18. |
| `vercel.json` | Rewrites: `/api/metabase/:path*` → `/api/metabase-proxy?p=:path*`, plus the three propose endpoints. |
| `package.json` | No deps. `"type": "module"`. `npm start` runs `server.js`. |
| `test.html` | Smoke tests for `clustering.js`. Open in a browser; passes/fails render inline. |

---

## Data model

A **model** belongs to a **brand** and lives in a **category**. Categories form a tree
rooted at sports (Baseball, Hockey, Lacrosse, etc.). Any node with `sport=1` is a
sport-level root. The category tree's `path` column stores ancestors as `/`-separated
IDs — Baseball → Bats has `path = '4000/37'`. **Boolean columns are stored as `INT64`**;
write `WHERE sport = 1` not `WHERE sport = TRUE`.

Models are in one of two states this tool cares about:

- `available` — visible to customers. Highest priority for cleanup.
- `pending` — user-generated, hidden until promoted. Larger backlog, lower stakes.

A **gold-standard model** is `state='available' AND sold_count >= 20`. Below that, the
LLM weights the signal lower. Gold models in a `<brand, category>` slice are the
ground truth for what naming conventions look like.

### IndexedDB stores (`merch-dashboard`)

**`sports`** — keyed by sport id (string)

```js
{
  id: "4000",
  name: "Baseball",
  path: "4000",
  models: [/* full model rows from the sync query */],
  syncedAt: "2026-05-06T..."
}
```

**`conventions`** — keyed by `${brand_id}::${category_id}`

```js
{
  key: "290::37",
  brandId: 290, brandName: "Louisville Slugger",
  categoryId: 37, categoryFullName: "Baseball > Bats",
  pattern: "<Series><Generation> <Material>",
  examples: [...],
  rules: [...],
  exceptions: [...],
  inferredAt: "2026-05-06T..."
}
```

**`decisions`** — auto-incrementing id; index on `sourceId`

```js
{
  sourceId: 25102,
  targetId: 26611,        // null for renames
  newName: null,           // populated for renames
  decision: "approved" | "rejected",
  decidedAt: "2026-05-06T...",
  expiresAt: "2026-06-05T..."   // 30 days for rejections; null for approvals
}
```

**`sheet`** — keyed by `sourceId` — the in-progress bulk-import sheet

```js
{
  sourceId: 25102, sourceName: "CatX2",
  sportId: "4000", categoryFullName: "Baseball > Bats",
  brandName: "Marucci",
  mergeTargetId: 26611, mergeTargetName: "CATX2 Alloy",
  newName: null,                  // for renames
  reasoning: "...",
  addedAt: "2026-05-06T..."
}
```

`localStorage` holds: `merch-active-sport`, `merch-active-category`,
`merch-metabase-config`, `merch-metabase-session`. `sessionStorage` holds
`merch-auth='1'` once the password gate is unlocked.

---

## Data source (BigQuery via Metabase)

- Database: **`BigQuery-POC`** (Metabase database id `7`)
- Schema: **`rails`** (Metabase virtual schema → warehouse `rails.*` tables)
- Dialect: **BigQuery Standard SQL**

The two queries live in `metabase.js` as `SPORTS_SQL` and `MODELS_SQL`. Sport id is
passed as a `@sport_id` template tag at run time.

---

## Key flows

### 1. Sync a sport

`Header → Sync` opens the sync overlay. The overlay collects (or reuses) Metabase
credentials, fetches the sports list from BigQuery, and lets the operator pick one to
sync. The sync runs `MODELS_SQL` against `/api/metabase/dataset/json`, stores the
returned rows in the `sports` IndexedDB store, and refreshes the tab strip.

CSV upload is supported as a fallback when the Metabase proxy is unavailable. The
CSV must have the same column names as the `MODELS_SQL` projection.

### 2. Find merges

In a category panel, **Find Merges** runs per-brand (clusters are tighter when scoped
by brand). For each brand:

1. `Clustering.selectGoldModels(models)` picks `available` models with
   `sold_count >= 20`, capped at 50 by sales.
2. `Clustering.findMergeCandidates(models, { excludeIds })` walks pending and
   low-confidence-available models. For each anchor, finds neighbors with
   `jaroWinkler ≥ 0.75` OR `tokenSetOverlap ≥ 0.6`, top 5.
3. Clusters are packed into batches of 25 anchors and POSTed to `/api/propose/merges`
   along with the gold models.
4. The LLM returns `{ proposals, rejections }`. Proposals show in the review modal
   with `confidence ≥ 0.85` pre-marked Approve.

### 3. Find renames

Requires a saved naming convention for the brand+category. If missing, the brand is
listed as "skipped — run Inspect Naming Conventions first."

For each brand with a saved convention:

1. Gold models + the convention go to the LLM along with up to 50 candidate models per
   batch (filtered by token-overlap-with-gold-vocabulary as a coarse pre-filter).
2. The LLM returns proposed canonical names with reasoning, or a refusal.
3. Same review modal as merges, but the editable target is the proposed `new_name`.

### 4. Inspect Naming Conventions

`Inspect Naming Conventions` opens a per-brand list. Click **Infer / Refresh** on a
brand to call `/api/propose/conventions` (Opus) with that brand's gold models. The
returned writeup ({ pattern, examples, rules, exceptions }) is saved to IndexedDB and
re-used by Find Renames.

### 5. Sheet → CSV

Each approved proposal becomes a row in the `sheet` IndexedDB store. The header
button **Sheet** opens a side panel grouped by category. **Download CSV** writes a
file in the bulk-import format below.

---

## Bulk import CSV format

Header row, in this exact order:

```
model_id,description,position,primary_image_url,secondary_image_url,state,merge_target_id,category_id,name,brand_id,synonyms,price_retail,gtin,mpn,line,importance,expert_pick,value_guides_start_date,detail_ids
```

For v1 only these columns are populated by the dashboard:

- `model_id` — required, the source model being changed
- `merge_target_id` — set for merges; the target model the source folds into
- `name` — set for renames; the canonical name the model becomes

All other columns left blank. Blanks mean "no change" to the importer. A merge
supersedes a rename on the same row — the rename is dropped at export and a warning
toast is shown.

Filename pattern: `merch-update-<sport>-<YYYY-MM-DD>-<HHMMSS>.csv`.

---

## LLM endpoints

| Endpoint | Model | Purpose |
| --- | --- | --- |
| `POST /api/propose/merges` | `claude-sonnet-4-5-20250929` | For each anchor cluster, pick the best merge target or refuse. |
| `POST /api/propose/renames` | `claude-sonnet-4-5-20250929` | For each candidate, propose a canonical name or refuse. |
| `POST /api/propose/conventions` | `claude-opus-4-5` | Codify a brand+category naming convention from gold models. |

Each endpoint holds its own system prompt at the top of the file. The model ids are
pinned in `api/anthropic.js` as `SONNET_MODEL` / `OPUS_MODEL` so swaps happen in one
place.

The Anthropic API key is **server-side only** (`ANTHROPIC_API_KEY` env var). It is
never exposed to the browser.

---

## Deployment

### Vercel

1. Push the deployment branch to GitHub.
2. Vercel project → Settings → Environment Variables:
   - `METABASE_URL` (e.g., `https://metabase.example.com`)
   - `ANTHROPIC_API_KEY` (from console.anthropic.com)
3. Apply to Production and Preview, then redeploy.
4. The Edge Functions handle `/api/metabase/*` and `/api/propose/*` per `vercel.json`.

### Self-host

```bash
METABASE_URL=https://metabase.example.com \
ANTHROPIC_API_KEY=sk-ant-... \
PORT=8080 npm start
```

`server.js` serves the static SPA from the project root and mounts the same routes
the Edge Functions cover. Requires Node ≥18.

---

## Common tasks

- **Sync Baseball.** Click the **Sync** header button → pick **Baseball** → **Sync Now**.
  Drill into **Bats** from the sport overview to start cleanup.
- **Add a new sport tab.** Tabs auto-derive from the sports query
  (`sport=1 AND has_models=1` descendants). When a new sport appears in the warehouse,
  it shows up in the sync overlay's picker after the next overlay open.
- **Re-sync a sport.** Click the **↻** icon on its tab.
- **Re-run conventions for a brand+category.** In the category panel, click
  **Inspect Naming Conventions** → click **Infer / Refresh** on the brand. Overwrites
  the saved convention.
- **Wipe a session.** DevTools → Application → IndexedDB → `merch-dashboard` → Delete
  database. localStorage holds auth and Metabase config — wipe separately.
- **Debug a failed Anthropic call.** DevTools console:
  ```js
  fetch('/api/propose/merges', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ brand_name:'test', category_full_name:'test', gold_models:[], candidate_clusters:[] })
  }).then(r=>r.json()).then(console.log)
  ```
  A 500 with `ANTHROPIC_API_KEY not set` means the Vercel env var is missing.
- **Change LLM models.** Edit `api/anthropic.js`. `SONNET_MODEL` and `OPUS_MODEL`
  constants.
- **Change the password.** Edit `DASHBOARD_PASSWORD` in `index.html`. Default is
  `merchteam`. The gate is a deterrent, not a security boundary — the source is visible
  to anyone with the URL.

---

## Out of scope for v1

- Image sourcing / stock-photo discovery
- Long-form description generation (model-page marketing copy)
- Cross-user shared approval state — every operator works solo; the bulk-import CSV is
  the handoff artifact
- Model version extraction (parent models only — see Appendix A in the bootstrap doc)
- Any actual writes to the catalog — this tool only produces CSVs that engineering
  imports manually
- Cross-category merges — guarded against in candidate clustering (slices are scoped
  to a single category before being fed to the LLM)
- Model state changes — the bulk-import template supports `state` changes but the
  dashboard doesn't propose them. The column stays blank.

---

## Constraints / gotchas

- **BigQuery dialect.** `INT64` booleans (`= 1` not `= TRUE`). `@param` syntax for
  parameters. Backticked refs `` `rails.models` `` are fine.
- **Dashboard password is hardcoded** in `index.html` (`DASHBOARD_PASSWORD` constant).
  Default `merchteam`.
- **Metabase session and Anthropic API key are in different places.** Metabase auth
  is browser-side (`localStorage` `merch-metabase-session`). The Anthropic API key
  is server-side only — never sent to the browser.
- **CORS sidestepped by the proxies.** All Metabase calls go through
  `/api/metabase/*`; all Anthropic calls go through `/api/propose/*`.
- **Edge Function response size.** A full Baseball sync is ~5–10k models. Streaming
  via `/api/dataset/json` (no row cap), same as `data-dashboard`'s swaps query.
- **No framework dependencies.** Vanilla JS, CDN libraries only. Allowed CDN libs:
  PapaParse 5.4.1 (CSV import/export). Do **not** add React, Vue, jQuery, Tailwind,
  etc.
- **Rejected proposals expire after 30 days.** Implemented as `expiresAt` on the
  `decisions` store; cleanup runs on each `getRejections()` call.
- **Merges supersede renames.** If both are set on the same `sourceId` at export,
  the rename is dropped from the row and a toast is shown.

---

## Testing

Open `test.html` in a browser. It runs `clustering.js` smoke tests inline:
`jaroWinkler`, `tokenSetOverlap`, `normalize`, `tokenize`, `findMergeCandidates`,
`selectGoldModels`, `packClusterBatches`, and `findRenameCandidates`. Pass/fail
renders inline. There is no test framework — the file is intentionally low-ceremony.
