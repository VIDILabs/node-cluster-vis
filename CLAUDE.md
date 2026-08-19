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
| `NCV_AUTO_PARAMS` | `true` | Derive UMAP params and k from the data |
| `NCV_MAX_AUTO_CLUSTERS` / `NCV_K_TOLERANCE` | `10` / `0.05` | Bounds on the k sweep |
| `NCV_MAX_METRICS` / `NCV_MAX_NODES` | `12` / `0` | Default selection caps; 0 means all |
| `NCV_MRDMD_BASELINE_COVERAGE` | `0.9` | Node share needed for a baseline timestamp |
| `NCV_COVERAGE_BINS` | `240` | Buckets in the timeline coverage summary |

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
(120 nodes, 8 metrics, 93k rows, 8.9 MB) is the committed output and is the only
thing in `server/data/` that git tracks. Nodes cover ~70% of the timestamp grid,
so the gaps the timeline visualizes are real rather than synthesized.

It is built at **one-minute resolution** — `--nodes 120 --timestamps 1200`
against a 15-second ganglia export, which strides by 4. `--timestamps` is a
*cap on the count*, and the stride is `ceil(len(stamps) / timestamps)`, so it
sets the cadence only indirectly: the previous `240` gave stride 19 and a 4m45s
spacing, which left a 30-minute window holding 7 samples — below the 8-column
floor mrDMD needs, so no hand-drawn baseline on a default-opened chart could
ever be decomposed. Ask for a cadence by working back from the source spacing,
not by picking a round number.

Metric ranking (`Dataset.rank_metrics`, mirrored in the anonymizer) scores the
*within-node* coefficient of variation weighted by how often a metric reports.
Ranking on pooled spread instead promotes metrics that are flat-zero on half the
nodes and flat-high on the rest: enormous variance, two horizontal lines.

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
| `GET /api/dr` | Embedding, cluster labels, ccPCA contributions (`start`/`end` scope it) |
| `GET /api/clusters` | Re-label a cached embedding for a new k |
| `GET /api/mrdmd` | Per-node deviation from a metric baseline (`start`/`end` scope it) |
| `GET /api/coverage` | Per-cluster baseline conformance and blank readings over time (`nodes`, `bins`, `metrics`, `baselines`) |
| `POST /api/stream/next` | Append the next batch and recompute |
| `GET /api/stream/status` | Batch progress |

Responses are **gzip/brotli compressed** (`flask_compress.Compress(app)`; off by
default in Flask). `/api/series` is long, highly repetitive JSON — the same node
ids and timestamp prefixes over and over — and compresses about 7:1, which at
the sample's one-minute cadence is 30MB down to 4.4MB on the wire. That ratio,
not the row count, is what decides whether a first load over a network is
tolerable, so check it before trading away resolution.

## Backend architecture

`server.py` is a thin HTTP layer. Dataset state lives in `state.py` behind a lock
(previously module-level globals every request mutated), so an ingest can swap the
dataset without another in-flight request seeing a half-updated frame.

**`params.py`** — the data-driven parameter choices, kept out of `pipeline.py`
so `datasource` can use them without importing `umap`/`ccpca` (the anonymizer
runs on machines without a `ccpca` build). `n_neighbors` scales as sqrt(node
count), clamped to [5, 50] and below n-1. `k` comes from a silhouette sweep on
the 2D embedding, taking the *smallest* k within `K_TOLERANCE` of the best score
rather than the arg-max — UMAP makes many tight blobs, so the curve is flat
across a wide band (on the sample every k from 4 to 9 scores within 3%, and the
raw arg-max picks 9). Callers pass `0`/`-1` to mean "choose for me"; `/api/dr`
and `/api/clusters` report what was used in a `params` block, which is how the
UI controls learn the chosen values.

**`scripts/pipeline.py`** — `get_dr_time()` returns `(frame, params)`:
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

**A hand-drawn baseline window has its own floor.** `mrdmd_zscore.mrdmd`
subsamples at `8 * max_cycles` and returns an *empty node list* below that;
`compute_zscore` then calls `min()` over it and raises, so an empty list is not
a degraded answer but a crash. Both call sites pass `max_cycles=1`, making the
hard floor 8 columns. The automatic path never reaches it — `find_time_range`
already rejects anything under `MRDMD_MIN_BASELINE_COLUMNS` (16) — but
`process_baseline`, which serves the manual path, had no check at all, so a
brush drag narrower than 8 samples came back a 500 from deep inside the
decomposition — which, on the 4m45s sample this replaced, was every drag on a
default-opened chart.
It now raises `BaselineWindowError`, a 422 naming both counts, and the client
puts the previous window back in the boxes and the rectangle rather than showing
a baseline the z-scores were never computed against.

A timestamp counts as in-range when `MRDMD_BASELINE_COVERAGE` of the nodes fall
inside the band, not all of them, and a window shorter than
`MRDMD_MIN_BASELINE_COLUMNS` is rejected for the full range. Unanimity does not
survive a realistic node count — one outlier invalidates the whole timestamp. On
the 4m45s sample this replaced, `cpu_wio`'s longest unanimous window was five
columns, too short for mrDMD to decompose: it raised, the exception was swallowed
by a thread pool whose results were never collected, and the metric simply
vanished from the heatmap. The denser sample no longer starves it outright — 22
unanimous columns, just over the 16 minimum — but the margin is the point:
against `MRDMD_BASELINE_COVERAGE` the same metric gets 178. Requiring every node
costs roughly 8x the usable baseline, so the failure is one bad export away
whatever the current numbers say.

**Time scoping** (`server._scoped_frame`). `/api/dr`, `/api/clusters`,
`/api/mrdmd` and `/api/cluster-averages` take optional `start`/`end` and narrow
the frame to that window; absent, they see the whole range, which is what every
caller got before. The window goes **into the cache key** (`<key>_w<startNs>_<endNs>`)
because every cached artifact downstream — DR1, DR2, baselines — describes the
rows it was computed from, so reusing a full-range embedding for a window would
show the wrong thing rather than fail. Keys are integer nanoseconds: stable
across processes and safe in a filename. Each distinct window costs ~15KB of
parquet, so cache growth over a session is not worth managing.

`/api/coverage` is deliberately **not** scoped: the timeline is the control
surface the window is drawn on, so shrinking it to the selection would remove
the thing being selected.

A window has two floors, checked separately because which one you hit tells you
what to do: `WINDOW_MIN_NODES` (5) and `MRDMD_MIN_BASELINE_COLUMNS` (16
timestamps, since the baseline search has to fit inside the window too). Below
either, `TimeWindowError` returns a 422 naming both counts. The two are separate
because **nodes ramp in over a run** — in the bundled sample only 7 of 120 are
reporting in the first hour, reaching all 120 by hour 11 — so an early window can
be long and still nearly empty, and "widen it" is the wrong advice there.

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
metric z-scores) → `TimelineView` (per-cluster data coverage) → `MetricSelect` +
`FeatureContributionBarGraph` (metrics ranked by ccPCA contribution).

**Selection is drawn, not filtered** (`config.js` `OPACITY`). Every view renders
the whole node set and dims what isn't selected. The one deliberate exception is
the per-cluster show/hide buttons (`ClusterToggles`): those are an explicit
request for the marks to go, so every view *filters* on them. All clusters start
on, and the hidden set resets whenever k changes — a stale one would leave nodes
invisible with no button switched off to explain it.

`ClusterToggles` is rendered in **exactly one place**: the Node Similarity
panel, under Recompute / Reset Defaults, next to the k control that decides how
many clusters there are. `hiddenClusters` lives in `App` and every view reads
it — `DRPlot` drops those points, `HeatmapView` those columns, `LineChart` those
polylines, `TimelineView` those band pairs, and `MetricSelect` the matching
contribution bars *and* sparklines (both, or the two stacks stop lining up).
`DRPlot` still builds its scales from the full embedding, so hiding a cluster
never re-fits the axes and shifts the points that remain. The buttons were
previously duplicated in the heatmap header and the metric-reading toolbar,
wired to the same state; two identical rows read as two independent filters that
happened to move together.

Filtering the *selection* meant a small lasso
emptied the heatmap and the line charts — destroying the context the selection
was meant to be read against — and forced an mrDMD recompute on every lasso.
Deviation scores are now computed once over all nodes; a selection change costs
one `/api/coverage` call (~20 ms) instead of a round trip through mrDMD.

`LineChart` uses a **linear y-scale for every metric**, by explicit request: a
per-metric scale choice makes two charts side by side incomparable. The cost is
real and worth knowing — in the bundled sample `cpu_wio`'s median is 0.2% of its
max and `Missed Buffers_P1`'s is 0.03%, so those charts read as a flat line along
the axis with one or two spikes. (An earlier revision switched such metrics to
`d3.scaleSymlog`; don't reintroduce it without asking.)

Each chart carries **faint furniture behind the data**: a light rule at every
labelled tick on both axes (`GRID_COLOR`) and a hairline frame around the plot
area (`FRAME_COLOR`), in the manner of a seaborn grid. The grids re-use the same
`.ticks()` counts as the axes, so a rule always lands on a labelled tick rather
than near one. The frame is the *only* spine — both axes' `.domain` paths are
removed — or the left and bottom edges get drawn twice at different weights.
SVG has no z-index, so the grid groups and the frame rect are appended before
anything else in the draw effect; appending them later paints them over the
polylines. `LineChart.test.js` pins that order.

Y ticks use one fixed form on every chart — mantissa to one decimal plus a bare
exponent (`formatTick`: `1.2e7`, `2.0e-1`, `0`) in a monospace face. Telemetry
mixes byte counters in the millions with utilisation fractions below one; printed
plainly those are `12000000` and `0.2`, so the magnitude has to be read by
counting zeros and each chart claims a different amount of gutter. `MARGIN.left`
has to hold the widest label the format can produce at `TICK_SIZE +
TICK_PADDING` from the axis, so changing the format or `CHART_FONT.axis` means
re-checking it. At 12px monospace a six-character label (`2.0e-1`) needs about
49px and a seven-character one (`-1.0e-2`) about 56px; `MARGIN.left` is
currently 42, so a negative exponent runs a few pixels past the left edge.

`HEIGHT`, `MARGIN`, `CELL` and `MAX_ROWS_HEIGHT` are **exported** from
`LineChart.js` / `HeatmapView.js` and imported by their tests. Restating them in
the test file meant every deliberate resize read as a test failure.

Charts are drawn **1:1 at the container's measured width** — `HEIGHT` (190) is
fixed, the viewBox width tracks `clientWidth` via a `ResizeObserver`. The previous
fixed `0 0 800 300` viewBox was letterboxed into a 190px-tall box, which both
scaled every label down by ~0.6x and left the plot floating in the middle of a
much wider panel. Anything sized from the width — the clip rect, the brush extent
— has to be re-set on every draw, not created once.

`config.js` `CHART_FONT` is the **one type scale for both chart views**: the line
charts and the heatmap sit in adjacent panels, and different axis type between
them reads as a hierarchy that isn't there. `LineChart`'s `MARGIN` and
`HeatmapView`'s `LABEL_MIN_WIDTH` are both derived from it, so changing it means
re-checking the gutters. `MetricView` re-calls the x-axis on a shared time-domain
change and imports `CHART_FONT` rather than repeating a number.

`HeatmapView`'s two axes live in one overlay SVG above the scrolling column
strip, and **document order decides which one wins the gutter**. Node labels are
rotated 65 degrees, so each label's tail reaches left of the column it belongs
to, and scrolling the columns right slides more of them into the metric-name
gutter. The x-axis is therefore appended *first* and the y-axis last: its white
ground, then the metric names, paint over those tails, so a label slides behind
the axis instead of overprinting it.

`HeatmapView` tethers its x-axis to the bottom of the last row and only scrolls
vertically once the rows outgrow `MAX_ROWS_HEIGHT`. **A cell is `CELL.width` ×
`CELL.height` (20 × 20) whatever the node count** — the rows scroll horizontally
when they don't fit, rather than the cells being squeezed. Sizing them to the
panel meant the same z-score was drawn at a different size depending on how many
clusters happened to be visible: readable with one cluster on, slivers with four.
The panel is what gives, not the encoding. (`LABEL_MIN_WIDTH`, from
`CHART_FONT.axis` and the 65° label rotation, still thins tick labels, but the
fixed width clears it so nothing is dropped in practice.) A `Segmented` control
in the card header orders columns by
name (natural sort) or by cluster — cluster order puts each k-means group in one
contiguous block, which is what makes a whole-cluster excursion legible as a band.
`HeatmapView.test.js` and `LineChart.test.js` pin this geometry by stubbing
`clientWidth`/`clientHeight`, since jsdom does no layout.

**Panel heights** (`App.css`, `.dashboard-column` / `.panel-fill`). The two
columns have to end level, and neither can do that from a content height: the
left column's charts and the right column's heatmap both grow with the metric
count. The height is set **on the column** — `calc(100vh - 96px)`, the chrome
above and below it — and one card per column carries `panel-fill` to absorb the
slack: the metric-reading card on the left, the DR card on the right.

Do not try to inherit that height down a chain of `height: 100%` from `Content`
through `Spin` and `Row`. It does not resolve — antd's spin wrapper and `Row` are
not definite-height boxes — and the columns silently fall back to content height,
which runs the charts off the bottom of the page. For the same reason `DRPlot`'s
scatter `Row` must not carry `align="top"`: that pins every column to
`flex-start` and defeats the stretch its height depends on (the parameter form
gets `alignSelf: 'flex-start'` instead). `MetricView`'s scroller and
`MetricSelect`'s list keep a `calc(100vh - …)` **max**-height as a floor under
the flex sizing, so a chain that fails scrolls rather than overflowing.

**Baseline-rectangle visibility is applied outright, never through a d3
transition** (`LineChart.applyBaselineVisibility`). `d3.brush.move` calls
`interrupt()` on its group, and `updateBox` runs `move` at the end of every
draw — so a fading toggle was cancelled mid-flight and the switch appeared to do
nothing. The same helper runs at the end of the draw effect, so a redraw cannot
bring a hidden brush back.

**A range brushed on the timeline lives in `MetricView`'s `timeDomainRef`, and
`LineChart` reads it in preference to `selectedTimeRange`.** The brush applies
its range by mutating each registered chart's `xScale` in place, so nothing but
the live d3 object knew about it — and every redraw rebuilt the scale from the
`timeRange` prop and snapped the chart back to the derived 30-minute window. The
ref is cleared when `timeRange` itself changes, so a dataset swap retires it.

**Keep props to the chart components referentially stable.** `LineChart` is
memoized and its draw effect depends on `selectedTimeRange`; built inline in
`App.js`'s JSX that was a new array on every render, so any state change
anywhere in the app redrew every chart on screen. It is a `useMemo` on
`bStart`/`bEnd` now. `handleMetricSelectChange` likewise fetches the series and
the mrDMD scores with one `Promise.all` and applies their state in a single
batch — awaiting them in turn made the charts, the heatmap and the timeline each
land on a separate render, which read as several separate reloads.

Cross-view highlighting builds CSS selectors from node ids. Always go through
`utils/nodes.js` (`nodeClass`/`lineClass`/`pointId`) — raw ids with dots, colons,
or leading digits produce invalid selectors.

`TimelineView`'s x domain runs to the **end of the last bucket**, not to the
last timestamp. Each cell covers the bucket that starts at its timestamp, so a
domain ending at the final timestamp laid that cell down entirely to the right
of the axis. Cell widths are additionally clamped to the axis end, and the brush
extent is flush with it so the last bucket can still be selected. The range is
`[MARGIN.left, width - MARGIN.right]`; it previously subtracted the left gutter
a second time and stopped 50px short of the panel.

`TimelineView` draws **two bands per cluster**, both `ROW_HEIGHT` (7px) and
sharing one `c0` label: in-baseline, then gap. They are one reading rather than
two peers, so only the group is labelled. The bands are laid out by hand rather
than with a `scaleBand`, which would rescale them with the cluster count instead
of holding a fixed pixel height. An empty bucket is left **blank** — white, not
a grey ground — which reads as "nothing here" rather than as a value.

The **in-baseline** band is how many of the cluster's nodes were behaving within
that baseline — value-wise, not time-wise. Darker is more. **A node counts only
when every real reading it produced in the bucket falls inside its metric's
baseline value band**, and **the denominator is the nodes actually reporting in
that bucket, not the cluster's full membership** — a node that is not reporting
is not misbehaving, and scoring against membership would darken every outage.
The strict all-metrics rule is affordable here, unlike the all-metrics-zero rule
it superficially resembles: measured on the sample it spans the full 0..1 range
with σ = 0.35 across (cluster, bucket) cells, so the row has real contrast. A
bucket with nothing running gets no rect at all, which is what separates "none
of the cluster was in baseline" (the lightest ink, opacity 0.15) from "none of
it was running" (no ink).

This replaced a full-height coverage band that shaded how much of the cluster
reported. Presence is still in the payload as `active` and is still what the
in-baseline row is scored against, so nothing was lost from the model — only the
row that restated it.

A third band drawing the baseline *window* along the time axis was tried and
removed. The window is per metric, and the union across a full selection covers
almost the whole range — on the bundled sample `proc_run`'s window alone runs
01:15 to 18:23 — so it drew as a flat bar edge to edge and carried no
information. Don't reintroduce it without scoping it to a single metric.

The **gap** band inverts the encoding: ink is blank readings. **Blankness is
counted per reading — one (node, metric, timestamp) cell that is null, NaN, or
exactly 0.0 — not per row.** The per-row rule this replaced required a node to be
blank across every selected metric simultaneously, which essentially never
happens: the bundled sample has no all-zero row at all, yet `mem_free`,
`bytes_out` and `proc_run` each have a timestamp where *every* node reads 0, and
`cpu_wio` has three where more than half do. Those are the drops plainly visible
in the line charts, and the row rule found none of them.

The `metrics` parameter scopes which columns are counted for both the gap and
the in-baseline rows; the UI passes whatever is currently selected, so with one
metric selected a cluster-wide collapse to zero reads as a solid gap band, and
with all eight it reads as one eighth of one. A node with no row at all is not a
gap — it is simply absent from the in-baseline denominator.

`/api/coverage` takes the baselines **from the client**, as a JSON `baselines`
query param, because the window is editable and the server's cache still holds
the automatically derived one. Only `feature`/`v_min`/`v_max` travel. Anything
not sent falls back to the cached parquet (read, never computed — the endpoint
has a ~20ms budget and cannot afford to derive a baseline inline), and a metric
with neither is left out of the test rather than treated as unbounded. A
malformed `baselines` param falls back rather than 400ing: the cached bands are
a correct, if stale, answer, and the strip stays on screen. `TimelineView` itself takes no
`baselines` prop — they reach it only through the counts the server returns.
`refreshCoverage` reads them from a **ref**, not from state — five callbacks depend on it,
and a state dependency would rebuild all of them on every drag; `updateBaseline`
passes the new array explicitly through `onBaselineChange` because `setBaselines`
has not committed at that point.

**The Time Scope switch** (beside Streaming) recomputes every stage over the
timeline's selection: the embedding, the cluster labels, the ccPCA
contributions, the mrDMD z-scores and the cluster-average sparklines. They move
together on purpose — a windowed embedding read against full-range deviations is
worse than either on its own — so `applyTimeScope` refetches all of them rather
than patching any.

The window lives in `scopeRef`, not in a prop: every fetch callback has to send
it and none of them should be rebuilt when it changes, which is what would
redraw every chart on each brush. `scopeSignature` is a *string*, because two
`Date` objects for the same instant are never `===` and the effect would
recompute on every render. The effect's first run only records the current
window, so a page load does not pay for a pass nobody asked for; after that only
a changed window recomputes. With nothing brushed yet the switch falls back to
`timeRange`, so flipping it on acts on the window already on screen instead of
silently doing nothing.

A rescope costs a cold DR pass (~6s on the sample) plus mrDMD (~1s); returning to
a window already visited is ~0.2s, since the cache key carries it. The brush
fires on `end` only, so a drag costs one pass, not one per pixel.

`utils/colors.js` owns the cluster palette (Dark2 + Set2, wrapping, so any k up to
20 stays distinguishable) and the shared z-score diverging scale used by both the
heatmap and its legend.

Per-dataset defaults (nodes, metrics, baseline window, UMAP params) come from
`/api/datasets` → `active.defaults`, derived server-side from metric variance.
`ui/src/config.js` holds only UI behaviour with no server equivalent.

**The baseline window is editable two ways.** `BaselineControls` puts four
boxes beside every chart — Min, Max, Start, End — showing the window the server
derived. Labels sit to the left in one narrow auto-sized column, and each box
carries its own width in `ch` (12 for a bound, 16 for a timestamp) rather than a
shared one — `ch` is the width of a `0`, and a timestamp's dashes, colons and
space are all narrower than that, so 19ch bought a gutter of slack. A "Baseline
Controls" heading spans both columns at the top of each group, level with the
chart title beside it, and a **"Reset Default"** button spans them at the
bottom. Reset is not a commit: it asks `/api/mrdmd` for the metric with *no*
explicit bounds, which returns the automatically derived window because
`process_baseline` never writes a manual one back to the cache. Note the reply
carries a row per *cached* metric, not per requested one, so always resolve it
with `baselines.find(b => b.feature === field)`. Both they and the brush rectangle write through `updateBaseline`, so a
drag refills the boxes and a typed value moves the rectangle, and either way the
z-scores are recomputed for that metric — which repaints the heatmap — and
`/api/coverage` is refetched, which repaints the timeline's in-baseline row.
A drag's bounds are rounded to **two decimals at the point of capture**
(`LineChart.roundBounds`), not formatted on display, so what the boxes show is
exactly what was sent; a band narrower than a hundredth keeps full precision
rather than collapsing to a zero-width window. Each commit is an
mrDMD round trip for that metric, so edits land on blur or Enter, not per
keystroke, and only when the value differs from what is in effect; a window
whose range is inverted or unparseable reverts instead of being sent. The boxes
are deliberately *not* tied to the Baseline Region switch — that hides the
rectangle so the lines can be read, and the window is still in force.

`MetricView` passes `baselines.find(...)` — the **entry**, not the array. That
is what makes the boxes follow a drag at all: `LineChart` is memoized and
`baselinesRef` is a ref, so mutating it re-renders nothing. `updateBaseline`
rebuilds only the edited metric's entry, so the other charts keep their identity
and don't redraw.

**Timestamps on the wire are naive wall clock** (`utils/time.js`,
`toNaiveISO`) — never `Date.toISOString()`. Datasets carry no zone and the
frame's index is `datetime64[ns]`, so a `Z`-suffixed string parses to a tz-aware
Timestamp that pandas will not compare against it: `TypeError: Invalid
comparison between dtype=datetime64[ns] and Timestamp`, a 500 rather than a
wrong answer. `server._naive_timestamp` strips an offset if one arrives anyway.
The boxes and `d3.timeFormat` are both local, so wall clock is the currency end
to end.

**The view window and the baseline window are different things.** `bStart`/
`bEnd` are the mrDMD baseline window and come from the server. `timeRange` — what
the charts and the timeline brush open on — is derived on the client as the last
`DEFAULT_WINDOW_MINUTES` (30) of the data, or the whole range when that is
shorter. Conflating them is how the charts once opened on the first fifth of the
range. The bundled sample runs at one-minute cadence over 18h23m, so the
default window holds 30 of its 1104 timestamps — comfortably past the 8 columns
mrDMD needs, which is what makes a brush-drawn baseline work at all.

`MetricSelect`'s search box and list share one `LIST_WIDTH` (220px) on their
common wrapper. The box previously filled the column while the list stopped at
`maxWidth: 300`, which read as two unrelated controls stacked. The column is
`span={6}` against the charts' `span={18}`; the width the charts get back pays
for the baseline boxes.

Cluster averages (the sparklines in the metric list) are fetched for **every**
metric, not the selected ones — the list is what you choose from, so a blank
sparkline on an unselected metric defeats its purpose. They only need refetching
when the clustering changes, which also keeps them off the metric-toggle path.

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
- The Baseline Region switch faded the brush group through a d3 transition that
  `d3.brush.move`'s `interrupt()` cancelled on the next draw.
- `timeRange` was rebuilt inline in the JSX, so every chart's draw effect fired
  on every render anywhere in the app.
- `TimelineView`'s brush `end` handler wrote the selection into state, and
  `drawChart` depends on that state — so the initial `brush.move` re-ran the
  draw, which moved the brush again. d3 emits `end` for programmatic moves too;
  gate on `event.sourceEvent`, which is null for those.
- The line charts' x-domain was the baseline window (the first fifth of the
  range), so four fifths of every series was off-screen.
- `LineChart` drew into a fixed `0 0 800 300` viewBox letterboxed into a 190px
  box, so it never spanned its panel and every font rendered ~40% smaller than
  its declared size.
- `MetricView`, `MetricSelect` and the metric card each set their own
  `calc(60vh - …)` height, so the left and right columns only lined up at one
  viewport size.
- `find_time_range` required *every* node inside the IQR band, starving
  heavy-tailed metrics of a usable baseline window.
- `process_columns_baseline` called `executor.map()` without iterating it, so a
  worker exception was discarded and the metric silently disappeared.
- Timeline "downtime" meant every selected metric reading exactly zero. Nodes
  that stop reporting emit no rows at all, so it never fired; `/api/coverage`
  buckets presence instead.
- `/api/coverage` counted a node as reporting whenever a row existed for it, so
  a node emitting all-NaN — or NaN-filled-with-zero — rows looked healthy.
- Its replacement counted blankness per row, needing every selected metric zero
  at once; no row in the sample satisfies that, so the gap row sat empty while
  whole metrics visibly collapsed to zero. Count per reading.
- `DRPlot`'s scatter was an SVG at `height: 100%` inside a `height: 100%` div.
  An SVG at 100% of an auto-height parent computes to zero, so one unresolved
  link in the percentage chain took the whole embedding off screen silently.
  The SVG is sized in pixels from the measured container, and the container
  carries a `minHeight`, so the worst case is a misfit rather than a blank.
- `.panel-fill` carried `min-height: 0` alongside `overflow: hidden` on its card
  body, so when a column's content outgrew it the filling card absorbed the
  whole shortfall and collapsed to nothing — intermittently, depending on how
  tall the heatmap happened to be. It now has a real `min-height` and its
  siblings have `flex-shrink: 0`, so the column scrolls instead.
- The lasso faded every point to `opacity: 0.05` whenever a drag selected
  nothing, so a stray click on the scatter blanked the embedding. An empty
  lasso now just clears the selection, and `handleSelection` repaints every
  point at its resting opacity.
- **`DRPlot` points entered at `opacity: 0` and faded in on an *unnamed* d3
  transition, while the update branch ran its own unnamed transition for
  position and fill.** Any redraw inside those 800ms cancelled the fade, and
  nothing else set opacity — so the whole embedding sat at opacity 0: in the
  DOM, hit-testable by the lasso, invisible on screen. Opacity is now assigned
  outright on every draw (enter and update alike) and the position transition
  is named `"move"` so it cannot cancel an opacity transition. `DRPlot.test.js`
  pins this; it fails against the old code.
- `MetricView`'s time-domain handler filtered each line's points to the brushed
  range, so a line began at the first sample *inside* it instead of crossing the
  boundary — a visible gap between the y-axis and the start of the data. The
  plot area is already clipped; pass every point and let the clip do the work.
- The heatmap's y-axis was appended before its x-axis, so rotated node labels
  scrolled left *over* the metric names instead of disappearing behind them.
- `TimelineView`'s x range subtracted `MARGIN.left` twice, and its cells were
  drawn a full bucket wide from the domain's last timestamp — so the strip ran
  past the right end of its own axis while leaving a gutter of dead space.
- `updateBaseline` sent `Date.toISOString()`, so every manual baseline change —
  every brush drag — reached `/api/mrdmd` as a tz-aware timestamp and 500'd.
- `updateBaseline` took `baselines` as a `useCallback` dependency, so its
  identity changed on every commit — and it is in `LineChart`'s draw-effect
  deps, so every commit redrew every chart and rebuilt the x-scale, discarding
  whatever range had been brushed on the timeline. It reads the list from a ref
  instead. Same hazard as the inline `timeRange` array, one level up: a
  *handler* that churns costs as much as a value that churns.
- Heatmap and DR hover handlers restored a fixed opacity on mouse-out, which
  permanently un-dimmed whatever had been hovered. They now read
  `data-rest-opacity` off each line.
- `process_baseline` ran mrDMD on whatever window the brush produced. Under 8
  columns `mrdmd()` returns `[]` and `compute_zscore` raises `min() iterable
  argument is empty` — a 500 on essentially every drag, since the charts open on
  a 30-minute window that holds 7 samples. Guard the column count before the
  call; there is nothing to recover afterwards.
- A failed baseline commit left the new window in `baselines` and in
  `baselinesRef`, so the boxes and the rectangle showed a baseline the server
  had rejected and the z-scores were never computed against.
