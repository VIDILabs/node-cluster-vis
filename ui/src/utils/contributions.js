/**
 * ccPCA feature contributions, and the metric ordering derived from them.
 *
 * Shared rather than owned by the metric list, because the list and the charts
 * have to agree: reading a chart means finding it in the list first, and two
 * different orders make that a search instead of a glance.
 */

/**
 * The contribution bars for one metric, in cluster order.
 *
 * Rows are indexed by the *server's* feature ordering, not by whatever order
 * the client's metric list happens to be in. Looking the name up in
 * `fcs.features` is what keeps each bar attached to the metric it describes.
 */
export function contributionsFor(fcs, metric) {
  if (!fcs?.features || !fcs.agg_feat_contrib_mat) return [];
  const rowIndex = fcs.features.indexOf(metric);
  if (rowIndex === -1) return [];
  const row = fcs.agg_feat_contrib_mat[rowIndex];
  if (!row) return [];

  // order_col is a permutation of column indices giving the optimal-leaf order;
  // each column maps to the cluster label at the same position in fcs.clusters.
  return fcs.order_col.map((columnIndex) => ({
    cluster: fcs.clusters?.[columnIndex] ?? columnIndex,
    value: row[columnIndex] ?? 0,
  }));
}

/** How strongly a metric separates any one cluster from the rest. */
export function maxAbsContribution(fcs, metric) {
  const bars = contributionsFor(fcs, metric);
  if (!bars.length) return -Infinity;
  return Math.max(...bars.map((b) => Math.abs(b.value)));
}

/**
 * The dashboard's metric order: most discriminating first.
 *
 * Ties — and metrics the server sent no contributions for, which all score
 * -Infinity — fall back to the order they arrived in, so the result is stable
 * rather than dependent on the sort implementation.
 */
export function byContribution(fcs, metrics) {
  const arrival = new Map(metrics.map((metric, index) => [metric, index]));
  return [...metrics].sort((a, b) => {
    const delta = maxAbsContribution(fcs, b) - maxAbsContribution(fcs, a);
    if (delta) return delta;
    return arrival.get(a) - arrival.get(b);
  });
}
