# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A research visual-analytics dashboard for HPC node telemetry: a Flask backend
(`server/`) running a two-step DR + clustering pipeline and mrDMD-based anomaly
z-scores, and a Create React App frontend (`ui/`) rendering coordinated D3 views.
It implements the paper cited in `README.md` (Austin et al., ISC 2026).

## Commands

Backend:

```bash
cd server
source .venv/bin/activate        # required in every new shell
pip install -r requirements.txt
python server.py                 # http://localhost:5010
```

`ccpca` is deliberately not in `requirements.txt` — it needs a local build
(`pip install ccpca`, or clone https://github.com/takanori-fujiwara/ccpca).
`pipeline.py` imports both `ccpca` and `fc_view` from it. Python 3.13, driven by
`server/.python-version` under pyenv.

Frontend (Node 24+):

```bash
cd ui
npm install
cp .env.example .env.development   # sets REACT_APP_API_BASE
npm start                          # http://localhost:3000
npm run build
CI=true npm run build              # warnings-as-errors, as a deploy pipeline runs it

npm test -- --watchAll=false                                     # unit
NCV_TEST_API=http://127.0.0.1:5010 npm test -- --watchAll=false  # + live-API check
npm test -- --watchAll=false -t "renders the dashboard title"    # single test
```

There is no lint script; ESLint runs as part of the build. Keep `CI=true npm run
build` clean — it is the gate that catches unused vars and stale hook deps.

`src/App.integration.test.js` mounts the whole dashboard against a real backend
and is skipped unless `NCV_TEST_API` is set. Jest needs the
`transformIgnorePatterns` entry in `package.json` because d3 v7 is ESM-only, and
`setupTests.js` stubs `matchMedia`/`ResizeObserver` because antd calls both and
jsdom implements neither.

## Configuration

Nothing is hardcoded; `server/config.py` reads everything from the environment
and anchors relative paths to the file's own directory (not the process CWD), so
the server can start from anywhere.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NCV_HOST` / `NCV_PORT` | `127.0.0.1` / `5010` | Bind address |
| `NCV_DATA_DIR` | `server/data` | Where datasets are discovered |
| `NCV_DEFAULT_DATASET` | sample, else smallest file | Dataset loaded at startup |
| `NCV_BATCH_DIR` | `server/data/batch` | Streaming batch files |
| `NCV_CACHE_DIR` | `server/scripts/cache` | Parquet cache |
| `NCV_ALLOWED_REMOTE_HOSTS` | `*` | Allowlist for URL ingestion |
| `NCV_MAX_REMOTE_BYTES` | 512 MB | Cap on fetched files |
| `NCV_CORS_ORIGINS` | `*` | Allowed browser origins |
| `NCV_SERIES_MAX_POINTS` | `1500` | Samples per node sent to the browser |

Startup deliberately prefers the bundled sample, then the *smallest* file —
picking the alphabetically first one stalls startup for minutes when the data
directory holds a multi-gigabyte export.

Frontend: `REACT_APP_API_BASE` in `ui/.env.development`. Empty means "use the
page's own origin", which is what a same-host reverse-proxy deployment wants.
CRA reads `.env*` only at startup, so restart the dev server after changing it.

## Data contract

Any CSV or Parquet table with a node column, a timestamp column, and at least one
numeric metric column loads. `datasource.normalize()` is the single enforcement
point:

- Renames aliases onto the canonical schema (`time_secs`/`cname_processed` →
  `timestamp`/`nodeId`); alias lists are configurable.
- Coerces metrics numeric and drops columns that are empty or non-numeric.
- Drops `cname_id` (identifier) and `downtime` (always derived server-side, so a
  file that ships one can't disagree with what we compute).
- De-duplicates `(nodeId, timestamp)` — both the DR pivots and mrDMD require a
  unique index and raise otherwise.
- Raises `DataSourceError` with a 422 and a specific message when the schema
  doesn't conform.

A `<dataset>.headers.json` sidecar next to the data file supplies per-metric
titles/units/descriptions and overlays the shared `data/headers/` directory.

`scripts/anonymize.py` builds a shareable extract: salted-hash node labels,
timestamps rebased to a neutral epoch, values jittered but clamped to each
metric's original range. It emits the sidecar too. `server/data/sample_metrics.csv`
(30 nodes, 8 metrics, ~5k rows) is the committed output and is the only thing in
`server/data/` that git tracks.

## API

Query parameters, not path segments — metric names contain spaces and slashes,
and path segments forced a `%`-for-space hack that broke on other characters.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness plus whether a dataset is loaded |
| `GET /api/datasets` | Available datasets, active one, its derived defaults |
| `POST /api/datasets/load` | Ingest `{"source": filename \| path \| http(s) URL}` |
| `GET /api/metadata` | Per-metric title/units/description |
| `GET /api/series` | Downsampled per-node series (`metrics`, `nodes`, `maxPoints`) |
| `GET /api/cluster-averages` | Per-cluster metric means over time |
| `GET /api/dr` | Embedding, cluster labels, ccPCA contributions |
| `GET /api/clusters` | Re-label a cached embedding for a new k |
| `GET /api/mrdmd` | Per-node deviation from a metric baseline |
| `POST /api/stream/next` | Append the next batch and recompute |
| `GET /api/stream/status` | Batch progress |

## Backend architecture

`server.py` is a thin HTTP layer. Dataset state lives in `state.py` behind a lock
(previously module-level globals every request mutated), so an ingest can swap the
dataset without another in-flight request seeing a half-updated frame.

**`scripts/pipeline.py`** — `get_dr_time()`:
1. **DR1** per metric, thread-pooled: pivot to nodes × timestamps, demean,
   standardize, PCA to 1 component.
2. **DR2**: pivot to nodes × metrics, UMAP to 2D → `E1`/`E2`. `n_neighbors` is
   clamped below the node count, which small datasets otherwise trip.
3. **KMeans** on `E1`/`E2` → `Cluster`; k clamped to the node count.
4. **ccPCA** one-vs-rest per cluster (fits run concurrently), then `OptSignFlip`
   + `MatReorder` + aggregation.

`get_feat_contributions()` returns `features` and `clusters` alongside the matrix.
This matters: matrix rows are in the DR2 pivot's column order, and the client
previously indexed them by its own metric list, so bars were attached to the wrong
metrics. Always resolve a row via `features.indexOf(metric)`, and read column
`order_col[i]` as cluster `clusters[order_col[i]]`.

Caches are parquet files keyed by dataset content hash *and* parameters
(`dr1_<key>`, `dr2_<key>_<n_neighbors>_<min_dist>`). Changing k alone reuses both
stages and re-runs only k-means — 4.5 s cold vs ~0.05 s. `pipeline.clear_cache()`
runs on startup and on every dataset swap or streamed batch.

**`mrdmd.py`** wraps `scripts/src/mrdmd_zscore.py`. Per metric: IQR value range →
longest contiguous in-range window as the baseline → mrDMD over the node × time
matrix → baseline z-score, then per-node deviation. Baselines cache per
(dataset, metric) and are extended one metric at a time as selections change.

**Cluster label stability** (`state.align_clusters`): k-means numbers clusters
arbitrarily, so colors reshuffled on every recompute. Hungarian matching on node
overlap maps new labels onto the previous assignment, then labels are compacted to
`0..k-1` so cycling k doesn't leave gaps or push past the palette. Verified:
repeated calls at the same k, k round-trips, and full DR recomputes all leave
every label unchanged.

## Frontend architecture

`App.js` is the single stateful container; components below it are presentational
D3-in-`useEffect`. All network access goes through `src/api.js` — no component
should mention a host, port, or dataset name.

Shared state: `nodeClusterMap` (nodeId → cluster, the color key), `selectedPoints`,
`selectedDims`, `zScores`/`baselines`, `FCs`, `seriesRows`.

Views: `DRPlot` (UMAP scatter, lasso select, UMAP/k controls) → `MetricView`/
`LineChart` (series with draggable baseline rectangles) → `HeatmapView` (node ×
metric z-scores) → `TimelineView` (cluster downtime) → `MetricSelect` +
`FeatureContributionBarGraph` (metrics ranked by ccPCA contribution).

Cross-view highlighting builds CSS selectors from node ids. Always go through
`utils/nodes.js` (`nodeClass`/`lineClass`/`pointId`) — raw ids with dots, colons,
or leading digits produce invalid selectors.

`utils/colors.js` owns the cluster palette (Dark2 + Set2, wrapping, so any k up to
20 stays distinguishable) and the shared z-score diverging scale used by both the
heatmap and its legend.

Per-dataset defaults (nodes, metrics, baseline window, UMAP params) come from
`/api/datasets` → `active.defaults`, derived server-side from metric variance.
`ui/src/config.js` holds only UI behaviour with no server equivalent.

## Things that were fixed — don't reintroduce

- `/drTimeData` forced a full DR recompute on every call; caches are now keyed and
  reused.
- `recompute_clusters` double-prefixed `CACHE_DIR`, so the non-forced path always
  raised `FileNotFoundError` before its own existence check.
- The browser loaded whole CSVs from `ui/public/data/` directly, bypassing the
  server; it now fetches only the requested columns, downsampled.
- `getClusterSegments` read a `downtime` field the browser-loaded CSV never had,
  so the timeline was always empty.
- `MemoMetricSelect` was exported as a named export but imported as default, so
  the memo never applied.
- Cluster colors: 4-entry map returned grey for k ≥ 5.
- DRPlot hover restored `r=5` against a resting `r=4`, so points grew permanently;
  its data join was update-only, leaving stale marks when the node set changed.
- LineChart's y-domain started at 0, flattening metrics that go negative; its axes
  were drawn once and never re-called.
- `MetricView.registerChart` appended on every redraw without bound.
- The streaming toggle was UI-only state that called nothing.
