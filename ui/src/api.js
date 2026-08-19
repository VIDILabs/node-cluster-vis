/**
 * Single point of contact with the backend.
 *
 * The base URL comes from REACT_APP_API_BASE at build time and falls back to the
 * page's own origin, so a deployed bundle talks to whatever host serves it
 * without a rebuild. Nothing else in the app should mention a host or a port.
 */
const RAW_BASE = process.env.REACT_APP_API_BASE || '';

export const API_BASE = RAW_BASE.replace(/\/+$/, '');

const url = (path, params) => {
  const target = new URL(`${API_BASE}${path}`, window.location.origin);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    // Arrays are joined rather than repeated so metric names keep their order;
    // URLSearchParams handles escaping, so names with spaces need no massaging.
    target.searchParams.set(key, Array.isArray(value) ? value.join(',') : value);
  });
  return target.toString();
};

async function request(path, { params, method = 'GET', body } = {}) {
  const response = await fetch(url(path, params), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (payload && payload.error) detail = payload.error;
    } catch (err) {
      /* response had no JSON body; the status line is all we have */
    }
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export const api = {
  health: () => request('/api/health'),

  datasets: () => request('/api/datasets'),

  loadDataset: (source, name) =>
    request('/api/datasets/load', { method: 'POST', body: { source, name } }),

  metadata: () => request('/api/metadata'),

  series: (metrics, nodes, maxPoints) =>
    request('/api/series', { params: { metrics, nodes, maxPoints } }),

  clusterAverages: (metrics, binSeconds, maxPoints, start, end) =>
    request('/api/cluster-averages', {
      params: { metrics, binSeconds, maxPoints, start, end },
    }),

  // Per-cluster coverage over time. `nodes` narrows it to a selection; `metrics`
  // decides which columns count as a reading for the gap row. `baselines` are
  // the windows currently in effect — sent because they are editable, so a
  // dragged or typed bound has to move the in-baseline row with it. Only the
  // value bounds travel; the server reads nothing else from them.
  coverage: (nodes, bins, metrics, baselines) =>
    request('/api/coverage', {
      params: {
        nodes,
        bins,
        metrics,
        baselines: baselines?.length
          ? JSON.stringify(baselines.map(({ feature, v_min, v_max }) => ({
              feature, v_min, v_max,
            })))
          : undefined,
      },
    }),

  // `start`/`end` scope every stage — DR, clustering and the ccPCA
  // contributions — to that window. Absent, the whole range is used, which is
  // what every caller got before time scoping existed.
  dr: ({ nNeighbors, minDist, numClusters, force, start, end }) =>
    request('/api/dr', {
      params: {
        n_neighbors: nNeighbors,
        min_dist: minDist,
        num_clusters: numClusters,
        force: force ? 1 : undefined,
        start,
        end,
      },
    }),

  clusters: ({ nNeighbors, minDist, numClusters, force, start, end }) =>
    request('/api/clusters', {
      params: {
        n_neighbors: nNeighbors,
        min_dist: minDist,
        num_clusters: numClusters,
        force: force ? 1 : undefined,
        start,
        end,
      },
    }),

  mrdmd: ({ nodes, metrics, recomputeBase, vMin, vMax, bStart, bEnd, start, end }) =>
    request('/api/mrdmd', {
      params: {
        nodes,
        metrics,
        recomputeBase: recomputeBase ? 1 : undefined,
        vMin,
        vMax,
        bStart,
        bEnd,
        // The analysis window, not the baseline window: `start`/`end` narrow
        // the rows mrDMD sees, `bStart`/`bEnd` pick the baseline inside them.
        start,
        end,
      },
    }),

  streamStatus: () => request('/api/stream/status'),

  streamNext: (payload) =>
    request('/api/stream/next', { method: 'POST', body: payload }),
};

export default api;
