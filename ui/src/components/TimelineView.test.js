/**
 * That drawing the timeline does not drive itself.
 *
 * The brush's `end` handler wrote the selection back into state, and `drawChart`
 * depends on that state — so the initial `brush.move` re-ran the draw, which
 * moved the brush again. d3 emits `end` for programmatic moves too, so nothing
 * stopped the cycle; React eventually reported it as a nested update overflow.
 */
import { render } from '@testing-library/react';
import TimelineView, { ROW_HEIGHT } from './TimelineView.js';

const START = new Date('2024-01-01T00:00:00Z');
const times = Array.from({ length: 24 }, (_, i) => new Date(+START + i * 3600000).toISOString());

const coverage = {
  times,
  binSeconds: 3600,
  metrics: ['a', 'b'],
  nodeCount: 8,
  clusters: [0, 1].map(cluster => ({
    cluster,
    nodeCount: 4,
    active: times.map((_, i) => (i % 5 === 0 ? 0 : 4)),
    // 4 of 4 in baseline at i=1, none at i=2, so both ends of the ramp appear.
    inBaseline: times.map((_, i) => (i % 5 === 0 ? 0 : (i % 3 === 2 ? 0 : 4))),
    blank: times.map((_, i) => (i % 4 === 0 ? 3 : 0)),
    readings: times.map(() => 8),
  })),
};

function draw(hiddenClusters = undefined, props = {}) {
  return render(
    <TimelineView
      hiddenClusters={hiddenClusters}
      coverage={coverage}
      windowStart={new Date(+START + 20 * 3600000)}
      windowEnd={new Date(+START + 23 * 3600000)}
      nodeDataStart={times[0]}
      nodeDataEnd={times[times.length - 1]}
      {...props}
    />
  );
}

describe('TimelineView', () => {
  test('drawing does not announce a time-domain change', () => {
    const seen = [];
    const listener = (e) => seen.push(e.detail);
    window.addEventListener('time-domain-updated', listener);

    const { rerender } = draw();
    rerender(
      <TimelineView
        coverage={coverage}
        windowStart={new Date(+START + 20 * 3600000)}
        windowEnd={new Date(+START + 23 * 3600000)}
        nodeDataStart={times[0]}
        nodeDataEnd={times[times.length - 1]}
      />
    );

    window.removeEventListener('time-domain-updated', listener);
    // Positioning the brush is not a user action and must not be reported as one.
    expect(seen).toHaveLength(0);
  });

  test('each cluster gets two bands and no reporting band', () => {
    const { container } = draw();

    // The full-height "reporting" band is gone; presence now only sets the
    // denominator of the in-baseline row.
    expect(container.querySelectorAll('g[class^="coverage-c"]')).toHaveLength(0);
    expect(container.querySelectorAll('rect.coverage-cell')).toHaveLength(0);

    // ...and so is the baseline-window band: the union across a selection
    // covers nearly the whole range, so it drew as a flat bar edge to edge.
    expect(container.querySelectorAll('.baseline-cell')).toHaveLength(0);

    expect(container.querySelectorAll('g[class^="inbase-c"]')).toHaveLength(2);
    expect(container.querySelectorAll('g[class^="gap-c"]')).toHaveLength(2);

    // One label per cluster, covering both of its bands.
    const labels = Array.from(container.querySelectorAll('.y-axis .row-label'))
      .map(t => t.textContent);
    expect(labels).toEqual(['c0', 'c1']);
  });

  test('both bands are the height the gap band already was', () => {
    const { container } = draw();
    const heights = ['.inbase-cell', '.gap-cell'].map(
      sel => Number(container.querySelector(sel).getAttribute('height'))
    );
    expect(heights).toEqual([ROW_HEIGHT, ROW_HEIGHT]);
  });

  test('the two bands stack without overlapping', () => {
    const { container } = draw();
    const y = (sel) => Number(container.querySelector(`${sel}`).getAttribute('y'));
    // How much of the cluster sat inside baseline, then what was missing.
    expect(y('.inbase-cell')).toBeLessThan(y('.gap-cell'));
    expect(y('.gap-cell') - y('.inbase-cell')).toBeGreaterThanOrEqual(ROW_HEIGHT);
  });
});

describe('TimelineView in-baseline row', () => {
  test('more nodes in baseline is darker, and an idle bucket is blank', () => {
    const { container } = draw();
    const cells = Array.from(container.querySelectorAll('.inbase-c0 .inbase-cell'));

    // i % 5 === 0 has nothing running; those buckets get no rect at all rather
    // than the lightest shade, which would read as "none in baseline".
    const idle = times.filter((_, i) => i % 5 === 0).length;
    expect(cells).toHaveLength(times.length - idle);

    const opacities = cells.map(c => Number(c.getAttribute('opacity')));
    expect(Math.max(...opacities)).toBeGreaterThan(Math.min(...opacities));
    // 4/4 in baseline is full ink, 0/4 is the floor.
    expect(Math.max(...opacities)).toBeCloseTo(1, 5);
    expect(Math.min(...opacities)).toBeCloseTo(0.15, 5);
  });

  test('the count is read against the nodes running, not the cluster size', () => {
    const { container } = draw();
    const titles = Array.from(container.querySelectorAll('.inbase-c0 .inbase-cell title'))
      .map(t => t.textContent);
    expect(titles.some(t => t.includes('4/4 reporting nodes within baseline'))).toBe(true);
    expect(titles.some(t => t.includes('0/4 reporting nodes within baseline'))).toBe(true);
  });
});

describe('TimelineView cluster visibility', () => {
  test('a hidden cluster loses both of its bands', () => {
    const both = draw().container;
    expect(both.querySelectorAll('.row-label')).toHaveLength(2);
    expect(both.querySelectorAll('g[class^="inbase-c"]')).toHaveLength(2);

    const one = draw(new Set([0])).container;
    // The bands go with the label: no orphaned strip, and no label with
    // nothing under it.
    expect(Array.from(one.querySelectorAll('.row-label')).map(t => t.textContent))
      .toEqual(['c1']);
    expect(one.querySelectorAll('g[class^="inbase-c"]')).toHaveLength(1);
    expect(one.querySelectorAll('g[class^="gap-c"]')).toHaveLength(1);
  });
});

describe('TimelineView right edge', () => {
  const PANEL_WIDTH = 600;
  const MARGIN_RIGHT = 10;

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return PANEL_WIDTH; },
    });
  });
  afterEach(() => { delete HTMLElement.prototype.clientWidth; });

  test('no cell is drawn past the end of the axis', () => {
    const { container } = draw();
    const plotRight = PANEL_WIDTH - MARGIN_RIGHT;

    const cells = Array.from(container.querySelectorAll('rect.inbase-cell, rect.gap-cell'));
    expect(cells.length).toBeGreaterThan(10);

    const rightEdges = cells.map(
      c => Number(c.getAttribute('x')) + Number(c.getAttribute('width'))
    );
    // A cell covers the bucket starting at its timestamp, so the last one used
    // to be laid down entirely to the right of the axis.
    expect(Math.max(...rightEdges)).toBeLessThanOrEqual(plotRight + 0.5);

    // ...and it is still drawn: the fix widens the domain by one bucket rather
    // than clipping the final cell to nothing.
    expect(Math.max(...rightEdges)).toBeGreaterThan(plotRight - 5);
    cells.forEach(c => expect(Number(c.getAttribute('width'))).toBeGreaterThan(0));
  });

  test('the axis spans the panel rather than stopping a gutter short', () => {
    const { container } = draw();
    const domain = container.querySelector('.x-axis .domain');
    const ends = /H([-\d.]+)/.exec(domain.getAttribute('d'));
    // The range subtracted the left gutter a second time, leaving 50px of dead
    // space on the right. (d3 offsets the domain path by half a pixel to keep
    // the line crisp, hence the tolerance rather than an equality.)
    expect(Math.abs(Number(ends[1]) - (PANEL_WIDTH - MARGIN_RIGHT))).toBeLessThan(1);
  });
});
