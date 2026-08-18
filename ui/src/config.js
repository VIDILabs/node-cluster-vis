/**
 * Client-side presentation defaults.
 *
 * Dataset-specific choices (which nodes, which metrics, baseline window, UMAP
 * parameters) are no longer listed here — the server derives them per dataset
 * and returns them as `defaults` from /api/datasets, so a new dataset needs no
 * frontend change. What remains is UI behaviour that has no server equivalent.
 */

// Falls back only when the server has not answered yet.
export const FALLBACK_DEFAULTS = {
  selectedPoints: [],
  selectedDims: [],
  bStart: '',
  bEnd: '',
  nNeighbors: 15,
  minDist: 0.1,
  numClusters: 4,
};

// Bounds for the UMAP / k-means controls.
export const PARAM_LIMITS = {
  nNeighbors: { min: 2, max: 200, step: 1 },
  minDist: { min: 0.0, max: 1.0, step: 0.05 },
  numClusters: { min: 2, max: 20 },
};

// Number of buckets the timeline asks the server to summarize coverage into.
export const COVERAGE_BINS = 180;

// How much of the tail of the data the charts open on. Telemetry exports run for
// hours; opening on the whole range makes every line a solid band. Shorter
// datasets are shown whole rather than padded out to this.
export const DEFAULT_WINDOW_MINUTES = 30;

/**
 * Selection is drawn, not filtered.
 *
 * Every view renders the whole node set and dims what isn't selected, rather
 * than dropping unselected nodes. Filtering meant a small lasso emptied the
 * heatmap and the line charts, destroying the context the selection was
 * supposed to be read against — and it forced a round trip to the server on
 * every lasso, since the deviation scores had to be recomputed for the subset.
 */
export const OPACITY = {
  selected: 1,
  muted: 0.15,
};

// Points requested per node for the metric line charts.
export const SERIES_MAX_POINTS = 1500;

// How often streaming mode pulls the next batch, in milliseconds.
export const STREAM_INTERVAL_MS = 5000;

/**
 * Shared type scale for the charts.
 *
 * The heatmap and the line charts sit in adjacent panels, so their axes have to
 * agree: different axis type between two views reads as a hierarchy that isn't
 * there. `axis` is the dense tick text (node names, times, tick values),
 * `label` the sparser row/unit labels, `title` the chart heading.
 */
export const CHART_FONT = {
  axis: 12,
  label: 14,
  title: 16,
};
