/**
 * The dashboard's one metric ordering.
 *
 * The metric list and the line charts both go through `byContribution`, because
 * reading a chart means finding its metric in the list first — two orders make
 * that a search instead of a glance.
 */
import { byContribution, contributionsFor, maxAbsContribution } from './contributions.js';

// Two clusters, four metrics. Rows are in the *server's* feature order, which
// is deliberately not alphabetical and not the caller's order.
const fcs = {
  features: ['bytes_in', 'cpu_user', 'mem_free', 'proc_run'],
  clusters: [7, 3],
  order_col: [1, 0],
  agg_feat_contrib_mat: [
    [0.10, -0.20],   // bytes_in  -> 0.20
    [0.90, 0.05],    // cpu_user  -> 0.90
    [-0.50, 0.40],   // mem_free  -> 0.50
    [0.05, 0.05],    // proc_run  -> 0.05
  ],
};

describe('contributionsFor', () => {
  test('resolves the row by name and the column by order_col', () => {
    // Not row 0 — `cpu_user` is the second feature the server sent.
    expect(contributionsFor(fcs, 'cpu_user')).toEqual([
      { cluster: 3, value: 0.05 },   // order_col[0] === 1 -> clusters[1]
      { cluster: 7, value: 0.90 },
    ]);
  });

  test('a metric the server sent no contributions for has no bars', () => {
    expect(contributionsFor(fcs, 'not_a_metric')).toEqual([]);
    expect(contributionsFor(undefined, 'cpu_user')).toEqual([]);
    expect(maxAbsContribution(fcs, 'not_a_metric')).toBe(-Infinity);
  });
});

describe('byContribution', () => {
  test('orders by how strongly a metric separates any one cluster', () => {
    const metrics = ['proc_run', 'bytes_in', 'mem_free', 'cpu_user'];
    expect(byContribution(fcs, metrics)).toEqual([
      'cpu_user',   // 0.90
      'mem_free',   // 0.50
      'bytes_in',   // 0.20
      'proc_run',   // 0.05
    ]);
  });

  test('the input is left alone', () => {
    const metrics = ['proc_run', 'cpu_user'];
    byContribution(fcs, metrics);
    expect(metrics).toEqual(['proc_run', 'cpu_user']);
  });

  test('a subset keeps the same relative order as the whole list', () => {
    const all = byContribution(fcs, ['proc_run', 'bytes_in', 'mem_free', 'cpu_user']);
    const some = byContribution(fcs, ['proc_run', 'cpu_user']);
    // What makes the charts findable: switching a metric off must not reshuffle
    // the ones left.
    expect(some).toEqual(all.filter((m) => some.includes(m)));
  });

  test('ties and unscored metrics fall back to the order they arrived in', () => {
    // Every metric scores -Infinity against an absent fcs, so this is entirely
    // the tiebreak — and it has to be stable, not sort-implementation-defined.
    const metrics = ['zeta', 'alpha', 'mu'];
    expect(byContribution(undefined, metrics)).toEqual(['zeta', 'alpha', 'mu']);
    expect(byContribution({}, metrics)).toEqual(['zeta', 'alpha', 'mu']);
  });
});
