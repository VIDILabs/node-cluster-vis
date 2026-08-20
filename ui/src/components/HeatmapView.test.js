/**
 * Geometry checks for the node-behaviour heatmap.
 *
 * The map runs nodes down the rows and metrics across the top, so the long axis
 * is the vertical one and the panel can be narrow. jsdom does no layout, so
 * clientWidth/clientHeight are stubbed to stand in for a real panel. That is
 * enough to pin what the geometry has to hold: the metric axis flush with the
 * top of the rows, every node keeping its own label, and cells that stay the
 * same size however many nodes there are.
 */
import { useCallback, useMemo, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import HeatmapView, {
  CARD_CHROME, CELL, MARGIN, MAX_ROWS_HEIGHT, MIN_PANEL_WIDTH, panelWidth,
} from './HeatmapView.js';
import ClusterToggles from './ClusterToggles.js';

// Imported rather than restated: these are the numbers the component lays out
// with, and a local copy of them silently goes stale the moment a cell is
// resized — which is a change to the design, not a regression for a test to
// catch. What the tests pin is the geometry these produce.
const PANEL_WIDTH = 400;
const CELL_WIDTH = CELL.width;
const CELL_HEIGHT = CELL.height;
const MARGIN_TOP = MARGIN.top;

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

// The component sizes its own container from the node count, then measures it.
// Mirror that here so the stub reports what the browser would have laid out.
function stubLayout(nodeCount) {
  const rowsHeight = Math.min(nodeCount * CELL_HEIGHT, MAX_ROWS_HEIGHT);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return this.id === 'heatmap-scroll' ? 0 : rowsHeight + MARGIN_TOP; },
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

// d3's axis transform is `translate(x, y)`.
function axisTranslate(container, selector) {
  const transform = container.querySelector(selector).getAttribute('transform');
  const [, x, y] = /translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(transform);
  return { x: Number(x), y: Number(y) };
}

describe('HeatmapView geometry', () => {
  afterEach(() => {
    delete HTMLElement.prototype.clientHeight;
    delete HTMLElement.prototype.clientWidth;
  });

  test('metrics label the top and nodes label the side', () => {
    const nodes = 12;
    const features = 5;
    stubLayout(nodes);
    const { container } = render(
      <Harness data={makeData(nodes, features)} nodeClusterMap={clusterMap(nodes)} selectedPoints={[]} />
    );

    // The metric names are the x-axis, pinned to the top of the rows; the node
    // ids are the y-axis, in the left gutter.
    expect(container.querySelectorAll('.x-axis .tick text')).toHaveLength(features);
    expect(container.querySelectorAll('.y-axis .tick text')).toHaveLength(nodes);

    expect(axisTranslate(container, '.x-axis').y).toBe(MARGIN.top);
    expect(axisTranslate(container, '.y-axis').x).toBe(MARGIN.left);

    // Metric names rise to the right of their column so they never reach back
    // over the node gutter; node names are level and need no rotation.
    const metric = container.querySelector('.x-axis .tick text');
    expect(metric.getAttribute('transform')).toMatch(/^rotate\(-\d+\)$/);
    expect(container.querySelector('.y-axis .tick text').getAttribute('transform')).toBeNull();
  });

  test('a cell is at the metric column and the node row', () => {
    const nodes = 6;
    const features = 3;
    stubLayout(nodes);
    const { container } = render(
      <Harness data={makeData(nodes, features)} nodeClusterMap={clusterMap(nodes)} selectedPoints={[]} />
    );

    const cells = Array.from(container.querySelectorAll('.heatmap-cell'));
    expect(cells).toHaveLength(nodes * features);
    // One distinct x per metric, one distinct y per node — the transpose of
    // what this drew before.
    expect(new Set(cells.map(c => c.getAttribute('x'))).size).toBe(features);
    expect(new Set(cells.map(c => c.getAttribute('y'))).size).toBe(nodes);
  });

  test('rows scroll instead of pushing the map past the panel', () => {
    const nodes = 120;
    stubLayout(nodes);
    const { container } = render(
      <Harness data={makeData(nodes, 8)} nodeClusterMap={clusterMap(nodes)} selectedPoints={[]} />
    );

    expect(nodes * CELL_HEIGHT).toBeGreaterThan(MAX_ROWS_HEIGHT);
    // The map keeps its full height and the window onto it is capped.
    expect(Number(container.querySelector('#heatmap-svg').getAttribute('height')))
      .toBe(nodes * CELL_HEIGHT);
    expect(container.querySelector('#heatmap-scroll').style.height).toBe(`${MAX_ROWS_HEIGHT}px`);
    expect(container.querySelector('#heatmap-scroll').style.overflowY).toBe('auto');
  });

  test('the map ends flush with the last row when the rows fit', () => {
    const nodes = 10;
    const rowsHeight = stubLayout(nodes);
    const { container } = render(
      <Harness data={makeData(nodes, 8)} nodeClusterMap={clusterMap(nodes)} selectedPoints={[]} />
    );

    // No gap between the last node and the bottom of the rows area, and nothing
    // to scroll.
    expect(container.querySelector('#heatmap-scroll').style.height).toBe(`${rowsHeight}px`);
    expect(container.querySelector('#heatmap-scroll').style.overflowY).toBe('hidden');
  });

  test('cells are the same size whatever the node count', () => {
    const sizeFor = (nodes) => {
      stubLayout(nodes);
      const { container } = render(
        <Harness data={makeData(nodes, 8)} nodeClusterMap={clusterMap(nodes)} selectedPoints={[]} />
      );
      const cells = Array.from(container.querySelectorAll('.heatmap-cell'));
      // Every node still has a row — none are dropped.
      expect(new Set(cells.map(c => c.getAttribute('y'))).size).toBe(nodes);
      return {
        height: Number(cells[0].getAttribute('height')),
        width: Number(cells[0].getAttribute('width')),
        map: Number(container.querySelector('#heatmap-svg').getAttribute('height')),
      };
    };

    // Sizing cells to fit the panel meant the same z-score was drawn at a
    // different size depending on how many clusters happened to be visible.
    const few = sizeFor(10);
    const many = sizeFor(120);
    // Within a rounding artifact of d3's band outer padding, not the 12x
    // difference that fitting to the panel would produce.
    expect(Math.abs(few.height - many.height)).toBeLessThan(0.5);
    [few.height, many.height].forEach(h => expect(h).toBeGreaterThan(CELL_HEIGHT - 2));
    [few.width, many.width].forEach(w => expect(w).toBeGreaterThan(CELL_WIDTH - 2));

    // The panel is what gives: tall node sets scroll rather than being squeezed.
    expect(few.map).toBeLessThanOrEqual(MAX_ROWS_HEIGHT);
    expect(many.map).toBeGreaterThan(MAX_ROWS_HEIGHT);
  });

  test('every node carries a label at the fixed cell height', () => {
    stubLayout(120);
    const { container } = render(
      <Harness data={makeData(120, 8)} nodeClusterMap={clusterMap(120)} selectedPoints={[]} />
    );
    // Thinning only kicks in below a line of type, which CELL.height clears —
    // so nothing is dropped from the axis.
    expect(container.querySelectorAll('.y-axis .tick text')).toHaveLength(120);
  });

  test('rows can be ordered by name or grouped by cluster', () => {
    const nodes = 20;
    stubLayout(nodes);
    const { container } = render(
      <Harness data={makeData(nodes, 4)} nodeClusterMap={clusterMap(nodes)} selectedPoints={[]} />
    );

    // clusterMap assigns n % 4, so name order interleaves all four clusters.
    const clusters = () => Array.from(container.querySelectorAll('.y-axis .tick text'))
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

  test('cluster buttons start on and toggle their rows out and back', () => {
    const nodes = 20;   // clusterMap assigns n % 4, so four clusters of five
    stubLayout(nodes);
    const { container } = render(
      <Harness data={makeData(nodes, 4)} nodeClusterMap={clusterMap(nodes)} selectedPoints={[]} />
    );

    const rowCount = () => new Set(
      Array.from(container.querySelectorAll('.heatmap-cell')).map(c => c.getAttribute('y'))
    ).size;
    const button = (cluster) => screen.getByRole('button', { name: `c${cluster}` });

    // Every cluster is on until it is explicitly switched off.
    expect(rowCount()).toBe(nodes);
    [0, 1, 2, 3].forEach(c => expect(button(c)).toHaveAttribute('aria-pressed', 'true'));

    // Hiding drops the rows outright — this is a request for the space back,
    // not a selection, so it filters rather than dimming.
    fireEvent.click(button(1));
    expect(button(1)).toHaveAttribute('aria-pressed', 'false');
    expect(rowCount()).toBe(15);

    fireEvent.click(button(1));
    expect(rowCount()).toBe(nodes);

    // Hiding everything empties the rows without collapsing the metric columns
    // off the top axis.
    [0, 1, 2, 3].forEach(c => fireEvent.click(button(c)));
    expect(rowCount()).toBe(0);
    expect(container.querySelectorAll('.x-axis .tick').length).toBe(4);
  });

  test('selection dims the rest instead of removing it', () => {
    const nodes = 20;
    stubLayout(nodes);
    const selected = ['node-000', 'node-001'];
    const { container } = render(
      <Harness data={makeData(nodes, 4)} nodeClusterMap={clusterMap(nodes)} selectedPoints={selected} />
    );

    const cells = Array.from(container.querySelectorAll('.heatmap-cell'));
    // Nothing is dropped: all nodes are still on screen.
    expect(new Set(cells.map(c => c.getAttribute('y'))).size).toBe(nodes);

    const opacities = cells.map(c => Number(c.style.opacity));
    expect(new Set(opacities)).toEqual(new Set([1, 0.15]));
    expect(opacities.filter(o => o === 1)).toHaveLength(selected.length * 4);
  });

  test('an empty selection leaves everything at full opacity', () => {
    stubLayout(10);
    const { container } = render(
      <Harness data={makeData(10, 4)} nodeClusterMap={clusterMap(10)} selectedPoints={[]} />
    );
    const opacities = Array.from(container.querySelectorAll('.heatmap-cell'))
      .map(c => Number(c.style.opacity));
    expect(new Set(opacities)).toEqual(new Set([1]));
  });
});

describe('HeatmapView panel width', () => {
  afterEach(() => {
    delete HTMLElement.prototype.clientHeight;
    delete HTMLElement.prototype.clientWidth;
  });

  // App sizes the whole column from this, so it has to be the width the map
  // genuinely needs — a panel a few pixels short puts a horizontal scrollbar
  // under a map that visibly fits, and one too wide leaves dead space beside a
  // map that can never use it.
  function stubWidth(featureCount, nodeCount) {
    const rowsHeight = Math.min(nodeCount * CELL.height, MAX_ROWS_HEIGHT);
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() { return this.id === 'heatmap-scroll' ? 0 : rowsHeight + MARGIN.top; },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      // What is left inside the card once its own padding and border are taken.
      get() { return panelWidth(featureCount) - CARD_CHROME; },
    });
  }

  test.each([1, 3, 8, 12])('the map fits the panel width at %i metrics', (features) => {
    stubWidth(features, 40);
    const { container } = render(
      <Harness data={makeData(40, features)} nodeClusterMap={clusterMap(40)} selectedPoints={[]} />
    );

    const scroll = container.querySelector('#heatmap-scroll');
    // Wide enough: no sideways scrolling, whatever the metric count.
    expect(scroll.style.overflowX).toBe('hidden');
    // And no wider than it needs to be — the map plus its two gutters is the
    // whole panel, give or take the deliberate few pixels of slack. The one
    // exception is the floor that keeps the card's own header legible, which a
    // very short metric selection sits on.
    const mapWidth = features * CELL.width;
    const slack = panelWidth(features) - CARD_CHROME - MARGIN.left - MARGIN.right - mapWidth;
    if (panelWidth(features) > MIN_PANEL_WIDTH) {
      expect(slack).toBeLessThan(CELL.width);
    } else {
      expect(panelWidth(features)).toBe(MIN_PANEL_WIDTH);
    }
  });
});

describe('HeatmapView axis paint order', () => {
  afterEach(() => {
    delete HTMLElement.prototype.clientHeight;
    delete HTMLElement.prototype.clientWidth;
  });

  test('node labels slide behind the metric axis rather than over it', () => {
    stubLayout(40);
    const { container } = render(
      <Harness data={makeData(40, 6)} nodeClusterMap={clusterMap(40)} selectedPoints={[]} />
    );

    const order = Array.from(container.querySelector('#axis-svg').children).map(
      n => n.id || n.getAttribute('class')
    );
    // The node labels are the ones that move: they scroll up with the rows and
    // would otherwise print over the metric names. SVG has no z-index, so the
    // metric axis has to come last.
    expect(order.indexOf('y-axis')).toBeLessThan(order.indexOf('x-axis-bg'));
    expect(order.indexOf('x-axis-bg')).toBeLessThan(order.indexOf('x-axis'));
  });
});
