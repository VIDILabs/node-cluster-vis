/**
 * That drawing the timeline does not drive itself.
 *
 * The brush's `end` handler wrote the selection back into state, and `drawChart`
 * depends on that state — so the initial `brush.move` re-ran the draw, which
 * moved the brush again. d3 emits `end` for programmatic moves too, so nothing
 * stopped the cycle; React eventually reported it as a nested update overflow.
 */
import { render } from '@testing-library/react';
import TimelineView from './TimelineView.js';

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
    blank: times.map((_, i) => (i % 4 === 0 ? 3 : 0)),
    readings: times.map(() => 8),
  })),
};

function draw(hiddenClusters = undefined) {
  return render(
    <TimelineView
      hiddenClusters={hiddenClusters}
      coverage={coverage}
      windowStart={new Date(+START + 20 * 3600000)}
      windowEnd={new Date(+START + 23 * 3600000)}
      nodeDataStart={times[0]}
      nodeDataEnd={times[times.length - 1]}
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

  test('each cluster gets a coverage band and a shorter gap band', () => {
    const { container } = draw();

    expect(container.querySelectorAll('g[class^="coverage-c"]')).toHaveLength(2);
    expect(container.querySelectorAll('g[class^="gap-c"]')).toHaveLength(2);

    // One label per cluster, covering both of its bands.
    const labels = Array.from(container.querySelectorAll('.y-axis .row-label'))
      .map(t => t.textContent);
    expect(labels).toEqual(['c0', 'c1']);

    const coverageHeight = Number(container.querySelector('.coverage-cell').getAttribute('height'));
    const gapHeight = Number(container.querySelector('.gap-cell').getAttribute('height'));
    expect(gapHeight).toBeLessThan(coverageHeight);
  });
});

describe('TimelineView cluster visibility', () => {
  test('a hidden cluster loses both of its bands', () => {
    const both = draw().container;
    expect(both.querySelectorAll('.row-label')).toHaveLength(2);
    expect(both.querySelectorAll('g[class^="coverage-c"]')).toHaveLength(2);

    const one = draw(new Set([0])).container;
    // The band pair goes with the label: no orphaned strip, and no label with
    // nothing under it.
    expect(Array.from(one.querySelectorAll('.row-label')).map(t => t.textContent))
      .toEqual(['c1']);
    expect(one.querySelectorAll('g[class^="coverage-c"]')).toHaveLength(1);
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

    const cells = Array.from(container.querySelectorAll('rect.coverage-cell, rect.gap-cell'));
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
