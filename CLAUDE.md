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
| `index.html` | Single-page shell. Password gate, sync overlay, proposal-review modal, convention modal, settings modal (Google Sheets), confirm dialog, sheet side-panel, toasts. Loads scripts in order: `storage.js`, `metabase.js`, `sheets.js`, `clustering.js`, `proposals.js`, `dashboard.js`. |
| `dashboard.js` | All UI rendering. `Dashboard.init()` is the entry point. Owns the sport-filter pill row, the relatable-category grid, the category panel (filter toolbar + mode toolbar + sortable model table), Browse / Merge Mode / Rename Mode flows, LLM skill flows, proposal review modal, sheet builder, CSV export, Google Sheets settings. Holds the shared `BULK_IMPORT_HEADERS` constant and row-builder used by both CSV export and Sheets append. |
| `metabase.js` | Metabase client. BigQuery SQL templates (sports + relatable categories + models-for-category), session-token auth with API-key fallback, `/api/dataset/json` streaming for full result sets. All HTTP through `/api/metabase/*`. |
| `sheets.js` | Google Sheets client (browser-side). PKCE OAuth popup flow, token storage in localStorage, `Sheets.startAuth`, `Sheets.disconnect`, `Sheets.isConnected`, `Sheets.loadBinding`, `Sheets.createSheet`, `Sheets.appendRows`. All HTTP through `/api/google/*`. |
| `clustering.js` | Pure compute. `Clustering.findMergeCandidates(models)`, `Clustering.findRenameCandidates(models, convention)`, `Clustering.jaroWinkler(a, b)`, `Clustering.tokenSetOverlap(a, b)`, `Clustering.selectGoldModels(models)`, `Clustering.packClusterBatches(...)`. |
| `proposals.js` | Client-side LLM orchestrator. `Proposals.proposeMerges`, `Proposals.proposeRenames`, `Proposals.inferConvention`. Batches large slices and filters previously-rejected source ids. |
| `storage.js` | IndexedDB schema (v2). Object stores: `categories`, `conventions`, `decisions`, `sheet`. Public API: `openDB`, `saveCategory`, `loadCategory`, `listCategories`, `deleteCategory`, `saveConvention`, `loadConvention`, `recordDecision`, `getRejections`, `clearExpiredDecisions`, `addSheetEntry`, `removeSheetEntry`, `listSheetEntries`, `clearSheet`. |
| `style.css` | Hand-written dark theme. Variables in `:root`. No frameworks. |
| `api/metabase-proxy.js` | Vercel Edge Function. Streams `/api/metabase/*` to `${METABASE_URL}/*`. Pass-through for body and headers. |
| `api/anthropic.js` | Shared Anthropic API helper. Holds the model-id constants `SONNET_MODEL` and `OPUS_MODEL` so swaps happen in one place. Validates `ANTHROPIC_API_KEY`. |
| `api/google.js` | Shared Google OAuth + Sheets helper. PKCE token exchange, refresh, `spreadsheets.create`, `values.append`. Validates `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI`. |
| `api/propose/merges.js` | Edge Function. POST → calls Anthropic (Sonnet) with the merge system prompt → returns JSON. |
| `api/propose/renames.js` | Edge Function. POST → calls Anthropic (Sonnet) with the rename system prompt → returns JSON. |
| `api/propose/conventions.js` | Edge Function. POST → calls Anthropic (Opus) with the convention system prompt → returns JSON. |
| `api/google/config.js` | Edge Function. GET → returns public OAuth config (`clientId`, `redirectUri`, `scopes`) so the browser can build the auth URL. |
| `api/google/auth-exchange.js` | Edge Function. POST `{ code, code_verifier }` → exchanges with Google's token endpoint, returns access + refresh tokens. |
| `api/google/auth-refresh.js` | Edge Function. POST `{ refresh_token }` → returns a refreshed access token. |
| `api/google/auth-callback.js` | Edge Function. HTML response that `postMessage`s the auth code back to the opener and closes itself. |
| `api/google/sheets-create.js` | Edge Function. POST `{ access_token, title, headerRow }` → creates a new spreadsheet, writes the bulk-import header row, returns `{ sheetId, url }`. |
| `api/google/sheets-append.js` | Edge Function. POST `{ access_token, sheetId, rows }` → appends rows. |
| `server.js` | Zero-dep Node fallback for self-hosting. Serves the static SPA and mirrors the Edge Functions. Node ≥18. |
| `vercel.json` | Rewrites: `/api/metabase/:path*` → `/api/metabase-proxy?p=:path*`, plus the three propose endpoints and the six Google endpoints. |
| `package.json` | No deps. `"type": "module"`. `npm start` runs `server.js`. |
| `test.html` | Smoke tests for `clustering.js`. Open in a browser; passes/fails render inline. |

---

## Data model

A **model** belongs to a **brand** and lives in a **category**. Categories form a tree
rooted at sports (Baseball, Hockey, Lacrosse, etc.). Any node with `sport=1` is a
sport-level root. The category tree's `path` column stores ancestors as `/`-separated
IDs — Baseball → Bats has `path = '4000/37'`. **Boolean columns are stored as `INT64`**;
write `WHERE sport = 1` not `WHERE sport = TRUE`.

A **relatable category** is a leaf category that actually carries models —
`has_models = 1` in `rails.categories`. Sports themselves do **not** carry models:
"Baseball" has no models attached, "Baseball > Bats" does. The dashboard's primary
unit of work is the relatable category; sport is just a filter applied on top of
the relatable-category list. Sync, conventions, merges, and renames all operate on
one relatable category at a time.

Models are in one of two states this tool cares about:

- `available` — visible to customers. Highest priority for cleanup.
- `pending` — user-generated, hidden until promoted. Larger backlog, lower stakes.

A **gold-standard model** is `state='available' AND sold_count >= 20`. Below that, the
LLM weights the signal lower. Gold models in a `<brand, category>` slice are the
ground truth for what naming conventions look like.

### IndexedDB stores (`merch-dashboard`, schema v2)

**`categories`** — keyed by category id (string). One record per synced
relatable category. `sportId` is indexed so the sport filter can scope the list.

```js
{
  id: "37",
  name: "Bats",
  fullName: "Baseball > Bats",
  path: "4000/37",
  sportId: "4000", sportName: "Baseball",
  models: [/* full model rows from the sync query */],
  syncedAt: "2026-05-07T..."
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
  sportId: "4000", sportName: "Baseball",
  categoryId: "37", categoryFullName: "Baseball > Bats",
  brandName: "Marucci",
  mergeTargetId: 26611, mergeTargetName: "CATX2 Alloy",
  newName: null,                  // for renames
  reasoning: "...",
  addedAt: "2026-05-07T..."
}
```

`localStorage` holds: `merch-sport-filter` (active sport-filter pill, or absent
for "All sports"), `merch-active-category` (id of the open category, if any),
`merch-sports-meta` (cached id→name list of sports for filter labels),
`merch-metabase-config`, `merch-metabase-session`. `sessionStorage` holds
`merch-auth='1'` once the password gate is unlocked.

---

## Data source (BigQuery via Metabase)

- Database: **`BigQuery-POC`** (Metabase database id `7`)
- Schema: **`rails`** (Metabase virtual schema → warehouse `rails.*` tables)
- Dialect: **BigQuery Standard SQL**

Three queries live in `metabase.js`:

- `SPORTS_SQL` — sport-level roots (`sport = 1`) that have at least one descendant
  category carrying models. Used to label / filter the relatable-category list.
- `CATEGORIES_SQL` — every relatable category (`has_models = 1`) with `sport_id`
  derived from the path's first segment.
- `MODELS_SQL_TEMPLATE` — models for one relatable category. The category id is
  interpolated server-side (`__CATEGORY_ID__` placeholder) before sending. We do
  **not** use Metabase template tags / `@param` syntax for BigQuery here — the
  driver's parameter binding has surfaced "Query parameter not found" errors,
  and inlining a server-controlled integer sidesteps the issue without injection
  risk.

---

## Key flows

### 1. Sync a relatable category

`Header → Sync` opens the sync overlay. The overlay collects (or reuses) Metabase
credentials, fetches the **sports** list and the **relatable-categories** list
from BigQuery, and lets the operator pick a category to sync (with an optional
sport filter inside the overlay). The sync runs `MODELS_SQL_TEMPLATE` against
`/api/metabase/dataset/json`, stores the returned rows in the `categories`
IndexedDB store keyed by category id, and refreshes the sport-filter strip.

CSV upload is supported as a fallback when the Metabase proxy is unavailable. The
CSV must have the same column names as the `MODELS_SQL_TEMPLATE` projection;
rows are grouped by `category_id` and saved as one synced category per group.

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

### 5. The category panel (model table + modes)

The category panel shows every model attached to that relatable category in a
sortable, filterable table. Toolbars stack above:

- **Filter toolbar.** Brand `<select>` (populated from the synced models), state
  pill group (All / Available / Pending), search input (substring match on
  `m.name`). Filters apply to both the table and the LLM proposal flows.
- **Mode toolbar.** Three modes:
  - **Browse** (default). Rows are passive.
  - **Merge Mode.** First row click marks the model as the merge **source**
    (green left-border). Second click marks it as the **target** (blue
    left-border). A sticky confirm bar at the bottom shows
    `Merge X → Y` and Approve / Reset. Approving writes a sheet entry +
    decision and live-appends to the bound Google Sheet (if connected).
    Selection clears, mode stays on for the next pair.
  - **Rename Mode.** Click any model name to swap the cell to an inline input.
    Enter saves, Esc cancels. Saving writes a sheet entry + decision and
    live-appends to Sheets.
- **LLM action buttons.** *Find Merges*, *Find Renames*, and *Naming
  Conventions* are still here — but they now operate on the **filtered** model
  set, not the entire category. So with a brand filter active, "Find Merges"
  proposes only within that brand.

Default sort is `sold_count DESC` so high-priority models float up.

### 6. Sheet → CSV / live Sheets sync

Each approved proposal — manual (Merge Mode / Rename Mode) or LLM-driven —
becomes a row in the `sheet` IndexedDB store. The header button **Sheet** opens
a side panel grouped by category. Two output paths:

- **Download CSV** writes a file in the bulk-import format below. Always
  available.
- **Google Sheets.** If you've connected Google in **Settings** and clicked
  **Create Sheet**, every approval also appends a row to the bound spreadsheet
  in real time. Append is best-effort: on failure the toast surfaces the error
  and the entry is still in IndexedDB, so CSV export still picks it up.

The CSV header order and per-row build logic are shared between both paths
via the `BULK_IMPORT_HEADERS` constant and `buildCsvRowFromEntry` /
`buildCsvValuesFromEntry` helpers in `dashboard.js`.

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

## Google Sheets connector

OAuth 2.0 authorization-code flow with PKCE, run from the browser through
`sheets.js` and the `api/google/*` Edge Functions. `client_secret` stays
server-side; tokens live in browser localStorage.

### Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `GET /api/google/config` | GET | Returns `{ clientId, redirectUri, scopes }` so the browser can build the auth URL. |
| `POST /api/google/auth-exchange` | POST | `{ code, code_verifier }` → returns access + refresh tokens. |
| `POST /api/google/auth-refresh` | POST | `{ refresh_token }` → returns refreshed access token. |
| `GET  /api/google/auth-callback` | GET | Tiny HTML page; reads `code`+`state` from the OAuth redirect, posts back to `window.opener`, closes itself. |
| `POST /api/google/sheets-create` | POST | `{ access_token, title, headerRow }` → creates a new spreadsheet, writes the header row, returns `{ sheetId, url }`. |
| `POST /api/google/sheets-append` | POST | `{ access_token, sheetId, rows }` → appends rows. |

### Required env vars

- `GOOGLE_OAUTH_CLIENT_ID` — public; exposed via `/api/google/config` so the
  browser can construct the authorize URL.
- `GOOGLE_OAUTH_CLIENT_SECRET` — server-only; never returned to the browser.
- `GOOGLE_OAUTH_REDIRECT_URI` — must match the value registered for the OAuth
  client in the Google Cloud Console. e.g. for Vercel:
  `https://merch.example.com/api/google/auth-callback`. For local self-host:
  `http://localhost:8080/api/google/auth-callback`.

Scopes: `https://www.googleapis.com/auth/spreadsheets` only. We don't touch
Drive metadata.

### Browser-side state

- `localStorage['merch-google-tokens']` = `{ access_token, refresh_token, expires_at }`.
  `expires_at` is `Date.now() + (expires_in - 60s)` so we refresh proactively.
- `localStorage['merch-sheets-binding']` = `{ sheetId, url, title, createdAt }`.
- `sessionStorage['merch-google-oauth-state']` and
  `sessionStorage['merch-google-pkce-verifier']` — held only during the popup
  round-trip; cleared on success.

`Sheets.appendRows` auto-refreshes the access token when expired; if the
refresh fails or the user disconnects, append errors propagate to a toast and
the entry stays in IndexedDB for CSV export.

---

## Deployment

### Vercel

1. Push the deployment branch to GitHub.
2. Vercel project → Settings → Environment Variables:
   - `METABASE_URL` (e.g., `https://metabase.example.com`)
   - `ANTHROPIC_API_KEY` (from console.anthropic.com)
   - `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` (from console.cloud.google.com)
3. Apply to Production and Preview, then redeploy.
4. The Edge Functions handle `/api/metabase/*` and `/api/propose/*` per `vercel.json`.

### Self-host

```bash
METABASE_URL=https://metabase.example.com \
ANTHROPIC_API_KEY=sk-ant-... \
GOOGLE_OAUTH_CLIENT_ID=... \
GOOGLE_OAUTH_CLIENT_SECRET=... \
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8080/api/google/auth-callback \
PORT=8080 npm start
```

Google OAuth env vars are optional — without them the Sheets connector returns
500s but the rest of the app works.

`server.js` serves the static SPA from the project root and mounts the same routes
the Edge Functions cover. Requires Node ≥18.

---

## Common tasks

- **Sync Baseball Bats.** Click the **Sync** header button → set the in-overlay
  sport filter to **Baseball** → click **Baseball > Bats** → **Sync Now**. The
  category appears as a tile in the main grid; click it to start cleanup.
- **Filter to a sport.** Click a pill in the sport-filter strip below the header.
  The category grid scopes to that sport. The filter persists as
  `localStorage['merch-sport-filter']`.
- **Re-sync a category.** Click the **↻** icon in the top-right of a category tile.
- **Re-run conventions for a brand+category.** In the category panel, click
  **Naming Conventions** → click **Infer / Refresh** on the brand. Overwrites
  the saved convention.
- **Manually merge two models.** Open the category panel → switch to **Merge
  Mode** → click the duplicate (source) → click the canonical model (target) →
  **Approve**. Selection clears and Merge Mode stays on for the next pair.
- **Manually rename a model.** Switch to **Rename Mode** → click the model name
  → type the new name → press Enter.
- **Connect Google Sheets.** Header → **⚙ Settings** → **Connect Google** →
  authorize in the popup. Enter a sheet title (optional) and click **Create
  Sheet**. Approvals after that point append rows live.
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
  `shippinglogisticsguy`. The gate is a deterrent, not a security boundary — the source is visible
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

- **BigQuery dialect.** `INT64` booleans (`= 1` not `= TRUE`). Backticked refs
  `` `rails.models` `` are fine.
- **No Metabase template tags for BigQuery params.** Metabase's BigQuery driver
  has surfaced "Query parameter not found" errors when binding native template
  tags (`@sport_id`, `{{sport_id}}`, etc.). For the `MODELS_SQL_TEMPLATE` query
  we interpolate the integer category id server-side via a `__CATEGORY_ID__`
  placeholder. The id is server-controlled (originates from `CATEGORIES_SQL`)
  and validated as an integer in `fetchModelsForCategory`, so injection is not
  a concern.
- **Dashboard password is hardcoded** in `index.html` (`DASHBOARD_PASSWORD` constant).
  Default `shippinglogisticsguy`.
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
  the rename is dropped from the row and a toast is shown. Same rule applies in
  the Sheets append path (`buildCsvRowFromEntry` is shared).
- **Sheets append is best-effort and append-only.** A failed append leaves the
  entry in IndexedDB so CSV export still works. Removing an entry from the
  in-app sheet panel does **not** delete the row in Google Sheets — clean it
  up manually if needed.
- **Google client_secret is server-only.** The browser only ever sees
  `client_id`. PKCE is used so the auth code is bound to the originating
  session.

---

## Testing

Open `test.html` in a browser. It runs `clustering.js` smoke tests inline:
`jaroWinkler`, `tokenSetOverlap`, `normalize`, `tokenize`, `findMergeCandidates`,
`selectGoldModels`, `packClusterBatches`, and `findRenameCandidates`. Pass/fail
renders inline. There is no test framework — the file is intentionally low-ceremony.
