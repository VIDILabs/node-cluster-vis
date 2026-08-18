/**
 * Geometry checks for the node-behaviour heatmap.
 *
 * jsdom does no layout, so clientWidth/clientHeight are stubbed to stand in for
 * a real panel. That is enough to pin the two things that were wrong: the
 * x-axis floating far below the last row, and every node past the first ~30
 * sitting off-screen at a fixed cell width.
 */
import { useCallback, useMemo, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import HeatmapView, { CELL, MARGIN, MAX_ROWS_HEIGHT } from './HeatmapView.js';
import ClusterToggles from './ClusterToggles.js';

// Imported rather than restated: these are the numbers the component lays out
// with, and a local copy of them silently goes stale the moment a cell is
// resized — which is a change to the design, not a regression for a test to
// catch. What the tests pin is the geometry these produce.
const PANEL_WIDTH = 600;
const CELL_WIDTH = CELL.width;
const CELL_HEIGHT = CELL.height;
const MARGIN_BOTTOM = MARGIN.bottom;

// App owns cluster visibility and the buttons live in the Node Similarity
// panel, not here. This mirrors that split: the toggles are rendered alongside
// the heatmap rather than inside it, and the heatmap only reads the result.
function Harness({ data, nodeClusterMap, selectedPoints = [] }) {
  const [hiddenClusters, setHiddenClusters] = useState(() => new Set());
  const clusters = useMemo(
    () => Array.from(new Set(nodeClusterMap.values())).sort((a, b) => a - b),
    [nodeClusterMap]
  );
  const onToggleCluster = useCallback((cluster) => {
    setHiddenClusters((prev) => {
      const next = new Set(prev);
      if (next.has(cluster)) next.delete(cluster);
      else next.add(cluster);
      return next;
    });
  }, []);

  return (
    <>
      <ClusterToggles
        clusters={clusters}
        hidden={hiddenClusters}
        onToggle={onToggleCluster}
      />
      <HeatmapView
        data={data}
        nodeClusterMap={nodeClusterMap}
        selectedPoints={selectedPoints}
        hiddenClusters={hiddenClusters}
      />
    </>
  );
}

// The component sizes its own container, then measures it. Mirror that here so
// the stub reports what the browser would have laid out.
function stubLayout(featureCount) {
  const rowsHeight = Math.min(featureCount * CELL_HEIGHT, MAX_ROWS_HEIGHT);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return this.id === 'heatmap-scroll' ? 0 : rowsHeight + MARGIN_BOTTOM; },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return PANEL_WIDTH; },
  });
  return rowsHeight;
}

function makeData(nodeCount, featureCount) {
  const features = Array.from({ length: featureCount }, (_, i) => `metric_${i}`);
  return Array.from({ length: nodeCount }, (_, n) => {
    const row = { nodeId: `node-${String(n).padStart(3, '0')}` };
    features.forEach((f, i) => { row[f] = ((n + i) % 11) - 5; });
    return row;
  });
}

function clusterMap(nodeCount) {
  return new Map(
    Array.from({ length: nodeCount }, (_, n) => [`node-${String(n).padStart(3, '0')}`, n % 4])
  );
}

// d3's axis transform is `translate(x, y)`; we only care about y.
function axisY(container) {
  const transform = container.querySelector('.x-axis').getAttribute('transform');
  return Number(/translate\(\s*[-\d.]+\s*,\s*([-\d.]+)\s*\)/.exec(transform)[1]);
}

describe('HeatmapView geometry', () => {
  afterEach(() => {
    delete HTMLElement.prototype.clientHeight;
    delete HTMLElement.prototype.clientWidth;
  });

  test('x-axis sits directly under the last row when the rows fit', () => {
    const features = 8;
    const rowsHeight = stubLayout(features);
    const { container } = render(
      <Harness data={makeData(30, features)} nodeClusterMap={clusterMap(30)} selectedPoints={[]} />
    );

    // Flush against the rows, not parked at the bottom of the panel.
    expect(axisY(container)).toBe(features * CELL_HEIGHT);
    expect(axisY(container)).toBe(rowsHeight);
  });

  test('rows scroll instead of pushing the axis off the panel', () => {
    const features = 20;
    stubLayout(features);
    const { container } = render(
      <Harness data={makeData(30, features)} nodeClusterMap={clusterMap(30)} selectedPoints={[]} />
    );

    expect(features * CELL_HEIGHT).toBeGreaterThan(MAX_ROWS_HEIGHT);
    expect(axisY(container)).toBe(MAX_ROWS_HEIGHT);
    expect(container.querySelector('#heatmap-scroll').style.overflowY).toBe('auto');
  });

  test('cells are the same size whatever the node count', () => {
    stubLayout(8);

    const widthFor = (nodes) => {
      const { container } = render(
        <Harness data={makeData(nodes, 8)} nodeClusterMap={clusterMap(nodes)} selectedPoints={[]} />
      );
      const cells = Array.from(container.querySelectorAll('.heatmap-cell'));
      // Every node still has a column — none are dropped.
      expect(new Set(cells.map(c => c.getAttribute('x'))).size).toBe(nodes);
      return {
        cell: Number(cells[0].getAttribute('width')),
        map: Number(container.querySelector('#heatmap-svg').getAttribute('width')),
        scroll: container.querySelector('#heatmap-scroll').style.overflow,
      };
    };

    // Sizing cells to fit the panel meant the same z-score was drawn at a
    // different size depending on how many clusters happened to be visible.
    const few = widthFor(20);
    const many = widthFor(120);
    // Within a rounding artifact of d3's band outer padding, not the 2.5x
    // difference that fitting to the panel produced.
    expect(Math.abs(few.cell - many.cell)).toBeLessThan(0.5);
    [few.cell, many.cell].forEach(w => expect(w).toBeGreaterThan(CELL_WIDTH - 2));

    // The panel is what gives: wide node sets scroll rather than being squeezed.
    expect(few.map).toBeLessThanOrEqual(PANEL_WIDTH);
    expect(many.map).toBeGreaterThan(PANEL_WIDTH);
    expect(many.scroll).toBe('auto');
  });

  test('every node carries a label at the fixed cell width', () => {
    stubLayout(8);
    const { container } = render(
      <Harness data={makeData(120, 8)} nodeClusterMap={clusterMap(120)} selectedPoints={[]} />
    );
    // Thinning only kicks in below LABEL_MIN_WIDTH, which the fixed cell width
    // clears — so nothing is dropped from the axis.
    expect(container.querySelectorAll('.x-axis .tick text')).toHaveLength(120);
  });

  test('columns can be ordered by name or grouped by cluster', () => {
    const nodes = 20;
    stubLayout(4);
    const { container } = render(
      <Harness data={makeData(nodes, 4)} nodeClusterMap={clusterMap(nodes)} selectedPoints={[]} />
    );

    // clusterMap assigns n % 4, so name order interleaves all four clusters.
    const clusters = () => Array.from(container.querySelectorAll('.x-axis .tick text'))
      .map(t => Number(/node-(\d+)/.exec(t.textContent)[1]) % 4);

    expect(clusters()).toHaveLength(nodes);
    expect(clusters().slice(0, 4)).toEqual([0, 1, 2, 3]);

    fireEvent.click(screen.getByText('Cluster'));

    // Each cluster is now one contiguous block, which is what makes a
    // whole-cluster excursion legible as a band.
    const grouped = clusters();
    expect(grouped).toHaveLength(nodes);
    expect(grouped).toEqual([...grouped].sort((a, b) => a - b));
    expect(new Set(grouped).size).toBe(4);
  });

  test('cluster buttons start on and toggle their columns out and back', () => {
    const nodes = 20;   // clusterMap assigns n % 4, so four clusters of five
    stubLayout(4);
    const { container } = render(
      <Harness data={makeData(nodes, 4)} nodeClusterMap={clusterMap(nodes)} selectedPoints={[]} />
    );

    const columnCount = () => new Set(
      Array.from(container.querySelectorAll('.heatmap-cell')).map(c => c.getAttribute('x'))
    ).size;
    const button = (cluster) => screen.getByRole('button', { name: `c${cluster}` });

    // Every cluster is on until it is explicitly switched off.
    expect(columnCount()).toBe(nodes);
    [0, 1, 2, 3].forEach(c => expect(button(c)).toHaveAttribute('aria-pressed', 'true'));

    // Hiding drops the columns outright — this is a request for the space back,
    // not a selection, so it filters rather than dimming.
    fireEvent.click(button(1));
    expect(button(1)).toHaveAttribute('aria-pressed', 'false');
    expect(columnCount()).toBe(15);

    fireEvent.click(button(1));
    expect(columnCount()).toBe(nodes);

    // Hiding everything empties the columns without collapsing the metric rows.
    [0, 1, 2, 3].forEach(c => fireEvent.click(button(c)));
    expect(columnCount()).toBe(0);
    expect(container.querySelectorAll('.y-axis .tick').length).toBe(4);
  });

  test('selection dims the rest instead of removing it', () => {
    const nodes = 20;
    stubLayout(4);
    const selected = ['node-000', 'node-001'];
    const { container } = render(
      <Harness data={makeData(nodes, 4)} nodeClusterMap={clusterMap(nodes)} selectedPoints={selected} />
    );

    const cells = Array.from(container.querySelectorAll('.heatmap-cell'));
    // Nothing is dropped: all nodes are still on screen.
    expect(new Set(cells.map(c => c.getAttribute('x'))).size).toBe(nodes);

    const opacities = cells.map(c => Number(c.style.opacity));
    expect(new Set(opacities)).toEqual(new Set([1, 0.15]));
    expect(opacities.filter(o => o === 1)).toHaveLength(selected.length * 4);
  });

  test('an empty selection leaves everything at full opacity', () => {
    stubLayout(4);
    const { container } = render(
      <Harness data={makeData(10, 4)} nodeClusterMap={clusterMap(10)} selectedPoints={[]} />
    );
    const opacities = Array.from(container.querySelectorAll('.heatmap-cell'))
      .map(c => Number(c.style.opacity));
    expect(new Set(opacities)).toEqual(new Set([1]));
  });
});

describe('HeatmapView axis paint order', () => {
  afterEach(() => {
    delete HTMLElement.prototype.clientHeight;
    delete HTMLElement.prototype.clientWidth;
  });

  test('node labels slide behind the metric axis rather than over it', () => {
    stubLayout(6);
    const { container } = render(
      <Harness data={makeData(40, 6)} nodeClusterMap={clusterMap(40)} selectedPoints={[]} />
    );

    const order = Array.from(container.querySelector('#axis-svg').children).map(
      n => n.id || n.getAttribute('class')
    );
    // Rotated node labels reach left of their own column, and scrolling the
    // columns right slides more of them into the metric-name gutter. SVG has
    // no z-index, so the y-axis has to come last to cover them.
    expect(order.indexOf('x-axis')).toBeLessThan(order.indexOf('y-axis-bg'));
    expect(order.indexOf('y-axis-bg')).toBeLessThan(order.indexOf('y-axis'));
  });
});
