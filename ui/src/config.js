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

// Timeline bucket width for the downtime segments, in milliseconds.
export const TIMELINE_BIN_MS = 15 * 60 * 1000;

// Points requested per node for the metric line charts.
export const SERIES_MAX_POINTS = 1500;

// How often streaming mode pulls the next batch, in milliseconds.
export const STREAM_INTERVAL_MS = 5000;
