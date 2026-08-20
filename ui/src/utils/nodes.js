/**
 * Node identifiers become part of CSS class and id selectors so that hovering a
 * point in one view can highlight the same node in the others. Raw identifiers
 * are not safe there — real ones contain dots, colons, or leading digits, all of
 * which produce an invalid selector. Everything that builds such a selector goes
 * through these helpers so both sides agree on the spelling.
 */

/** Stable, selector-safe token for a node id. */
export const nodeToken = (nodeId) =>
  String(nodeId).replace(/[^a-zA-Z0-9_-]/g, '_');

/** Class applied to every mark representing a node (heatmap cells, lines). */
export const nodeClass = (nodeId) => `node-${nodeToken(nodeId)}`;

/** Class applied to a node's line in the metric charts. */
export const lineClass = (nodeId) => `line-${nodeToken(nodeId)}`;

/** Id applied to a node's point in the DR scatterplot. */
export const pointId = (nodeId) => `dr-point-${nodeToken(nodeId)}`;
