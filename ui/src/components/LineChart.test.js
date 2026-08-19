/**
 * The chart's drawing box and y-scale, which together decide whether a chart
 * shows anything and how much of the panel it uses.
 *
 * jsdom does no layout, so clientWidth is stubbed to stand in for a real panel.
 */
import { render } from '@testing-library/react';
import LineChart, { formatTick, HEIGHT, MARGIN, roundBounds } from './LineChart.js';

// Imported rather than restated: a local copy goes stale the moment the chart
// is resized, which is a design change and not a regression. The tests pin the
// geometry these produce, not the numbers themselves.
const PLOT_TOP = MARGIN.top;
const PLOT_BOTTOM = HEIGHT - MARGIN.bottom;
const MARGIN_LEFT = MARGIN.left;
const MARGIN_RIGHT = MARGIN.right;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;
const START = new Date('2024-01-01T00:00:00Z');

function series(values) {
  return values.map((value, i) => ({
    timestamp: new Date(+START + i * 60000),
    nodeId: `node-${i % 4}`,
    value,
  }));
}

function draw(data, selectedPoints = []) {
  const { container } = render(
    <LineChart
      data={data}
      field="metric"
      baselinesRef={{ current: {} }}
      selectedTimeRange={[START, new Date(+START + data.length * 60000)]}
      updateBaseline={() => {}}
      nodeClusterMap={new Map(data.map(d => [d.nodeId, 0]))}
      metadata={{ units: 'units' }}
      registerChart={() => {}}
      showBaselines
      selectedPoints={selectedPoints}
    />
  );
  return container;
}

// Vertical positions the polylines actually occupy.
function pathYs(container) {
  return Array.from(container.querySelectorAll('path.line'))
    .flatMap((path) => Array.from(
      (path.getAttribute('d') || '').matchAll(/[ML,]\s*[-\d.]+\s*,\s*([-\d.]+)/g),
      m => Number(m[1])
    ))
    .filter(Number.isFinite);
}

// Tick value -> y position, read off the rendered y-axis.
function yTicks(container) {
  return Array.from(container.querySelectorAll('.y-axis .tick')).map((tick) => ({
    value: Number(tick.textContent),
    y: Number(/translate\(\s*[-\d.]+\s*,\s*([-\d.]+)\s*\)/.exec(tick.getAttribute('transform'))[1]),
  }));
}

describe('LineChart y-scale', () => {
  test('every metric gets a linear axis, whatever its distribution', () => {
    // 199 samples clustered near zero plus one spike, cpu_wio's actual shape.
    // This used to trigger a symlog axis; all charts are linear now so two
    // metrics side by side can be read against each other.
    const heavyTailed = draw(series(
      Array.from({ length: 199 }, (_, i) => (i % 20) * 0.02).concat([46])
    ));
    const even = draw(series(Array.from({ length: 200 }, (_, i) => 100 + i)));

    [heavyTailed, even].forEach((container) => {
      expect(container.textContent).not.toContain('symlog');

      // Equal steps in value are equal steps in pixels — the definition of a
      // linear axis, and false for the symlog scale this replaced.
      const ticks = yTicks(container).filter(t => Number.isFinite(t.value));
      expect(ticks.length).toBeGreaterThan(2);

      const valueStep = ticks[1].value - ticks[0].value;
      const pixelStep = ticks[1].y - ticks[0].y;
      ticks.slice(1).forEach((tick, i) => {
        expect(tick.value - ticks[i].value).toBeCloseTo(valueStep, 6);
        expect(tick.y - ticks[i].y).toBeCloseTo(pixelStep, 6);
      });
    });
  });

  test('an evenly distributed metric fills the plot vertically', () => {
    const container = draw(series(Array.from({ length: 200 }, (_, i) => 100 + i)));
    const ys = pathYs(container);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(PLOT_HEIGHT * 0.4);
  });

  test('selection is drawn as opacity, keeping unselected lines on screen', () => {
    const container = draw(series(Array.from({ length: 40 }, (_, i) => i)), ['node-0']);

    const lines = Array.from(container.querySelectorAll('path.line'));
    expect(lines).toHaveLength(4); // all four nodes still drawn
    const opacities = lines.map(l => Number(l.style.opacity));
    expect(opacities.filter(o => o === 1)).toHaveLength(1);
    expect(opacities.filter(o => o === 0.15)).toHaveLength(3);
    // Hover handlers restore from this rather than assuming a single value.
    lines.forEach(l => expect(l.getAttribute('data-rest-opacity')).toBeTruthy());
  });
});

describe('LineChart width', () => {
  afterEach(() => { delete HTMLElement.prototype.clientWidth; });

  test('the plot spans the panel it is given rather than a fixed box', () => {
    const panelWidth = 1180;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return panelWidth; },
    });

    const container = draw(series(Array.from({ length: 60 }, (_, i) => i)));

    // Drawn at 1:1 against the measured width, so type renders at its true size
    // instead of being scaled down by a letterboxed viewBox.
    expect(container.querySelector('svg').getAttribute('viewBox'))
      .toBe(`0 0 ${panelWidth} ${HEIGHT}`);

    // Lines reach both ends of the plot area.
    const xs = Array.from(container.querySelectorAll('path.line'))
      .flatMap((path) => Array.from(
        (path.getAttribute('d') || '').matchAll(/[ML]\s*([-\d.]+)\s*,/g),
        m => Number(m[1])
      ));
    expect(Math.min(...xs)).toBeCloseTo(MARGIN_LEFT, 0);
    expect(Math.max(...xs)).toBeGreaterThan(panelWidth - MARGIN_RIGHT - 30);
  });
});

describe('LineChart baseline toggle', () => {
  const data = series(Array.from({ length: 40 }, (_, i) => i));
  const props = {
    data,
    field: 'metric',
    baselinesRef: { current: {} },
    selectedTimeRange: [START, new Date(+START + 40 * 60000)],
    updateBaseline: () => {},
    nodeClusterMap: new Map(data.map(d => [d.nodeId, 0])),
    metadata: { units: 'units' },
    registerChart: () => {},
    selectedPoints: [],
  };

  test('the brush group is hidden when baselines are switched off', () => {
    const { container, rerender } = render(<LineChart {...props} showBaselines />);
    const group = () => container.querySelector('.brush-group');

    expect(Number(group().style.opacity || 1)).toBe(1);

    rerender(<LineChart {...props} showBaselines={false} />);
    expect(Number(group().style.opacity)).toBe(0);
    expect(group().style.pointerEvents).toBe('none');

    rerender(<LineChart {...props} showBaselines />);
    expect(Number(group().style.opacity)).toBe(1);
  });

  test('a redraw does not put a hidden brush group back on screen', () => {
    const { container, rerender } = render(<LineChart {...props} showBaselines={false} />);
    const group = () => container.querySelector('.brush-group');

    expect(Number(group().style.opacity)).toBe(0);

    // Any prop the draw effect depends on — this is what a metric toggle or a
    // timeline brush does to every chart on screen.
    rerender(
      <LineChart {...props} showBaselines={false} selectedPoints={['node-0']} />
    );
    expect(Number(group().style.opacity)).toBe(0);
    expect(group().style.pointerEvents).toBe('none');
  });
});

describe('LineChart y-axis labels', () => {
  test('every magnitude is written the same way', () => {
    // A byte counter in the millions and a fraction below one get the same
    // form, so two charts stacked above each other share a gutter width and
    // neither has to be read by counting zeros.
    expect(formatTick(0)).toBe('0');
    expect(formatTick(12000000)).toBe('1.2e7');
    expect(formatTick(2000000)).toBe('2.0e6');
    expect(formatTick(0.2)).toBe('2.0e-1');
    expect(formatTick(-0.02)).toBe('-2.0e-2');
    expect(formatTick(1)).toBe('1.0e0');

    // Every non-zero label is mantissa-to-one-decimal plus a bare exponent.
    [1e-9, 0.5, 7, 3456, 9.9e12].forEach((v) => {
      expect(formatTick(v)).toMatch(/^-?\d\.\de-?\d+$/);
    });
  });

  test('a chart of huge values labels its axis in exponent form', () => {
    const container = draw(series(
      Array.from({ length: 60 }, (_, i) => 4_000_000 + i * 200_000)
    ));

    const labels = Array.from(container.querySelectorAll('.y-axis .tick text'))
      .map(t => t.textContent);

    expect(labels.length).toBeGreaterThan(2);
    labels.forEach(label => expect(label).toMatch(/^(0|-?\d\.\de-?\d+)$/));
    // No six-zero run anywhere on the axis.
    labels.forEach(label => expect(label).not.toMatch(/000000/));
  });
});

describe('LineChart plot furniture', () => {
  const container = () => draw(series(Array.from({ length: 60 }, (_, i) => i)));

  test('the frame outlines exactly the plot area', () => {
    const frame = container().querySelector('rect.plot-frame');
    expect(frame).toBeTruthy();
    // No fill: it is an outline over the grid, not a panel behind it.
    expect(frame.style.fill).toBe('none');
    expect(Number(frame.getAttribute('x'))).toBe(MARGIN_LEFT);
    expect(Number(frame.getAttribute('y'))).toBe(PLOT_TOP);
    expect(Number(frame.getAttribute('height'))).toBe(PLOT_HEIGHT);
  });

  test('grid rules land on the labelled ticks, not near them', () => {
    const c = container();
    const gridYs = Array.from(c.querySelectorAll('.grid-y .tick')).map(
      t => Number(/translate\(\s*[-\d.]+\s*,\s*([-\d.]+)/.exec(t.getAttribute('transform'))[1])
    );
    const axisYs = yTicks(c).map(t => t.y);
    expect(gridYs.length).toBeGreaterThan(2);
    expect(gridYs).toEqual(axisYs);

    // Horizontal rules span the plot; vertical ones span its height.
    const rule = c.querySelector('.grid-y .tick line');
    expect(Math.abs(Number(rule.getAttribute('x2')))).toBeGreaterThan(100);
    const vertical = c.querySelector('.grid-x .tick line');
    expect(Math.abs(Number(vertical.getAttribute('y2')))).toBe(PLOT_HEIGHT);
  });

  test('furniture is drawn under the data and the spine only once', () => {
    const c = container();
    const classesInOrder = Array.from(c.querySelector('svg').children).map(n => n.getAttribute('class'));
    // SVG has no z-index: document order is paint order, so the grid and the
    // frame have to precede the polylines or they cover them.
    expect(classesInOrder.indexOf('grid grid-x')).toBeLessThan(classesInOrder.indexOf('lines'));
    expect(classesInOrder.indexOf('plot-frame')).toBeLessThan(classesInOrder.indexOf('lines'));

    // The frame is the spine; a domain path would lay a second line on top of
    // its left and bottom edges at a different weight.
    expect(c.querySelectorAll('.x-axis .domain')).toHaveLength(0);
    expect(c.querySelectorAll('.y-axis .domain')).toHaveLength(0);
  });
});


describe('roundBounds', () => {
  test('a dragged bound is rounded to two decimals', () => {
    // What `yScale.invert` actually returns for a pixel.
    expect(roundBounds(0.8271604938271605, 12.34567)).toEqual([0.83, 12.35]);
    expect(roundBounds(53089.0912, 198862.2149)).toEqual([53089.09, 198862.21]);
  });

  test('a value already at two decimals is left alone', () => {
    expect(roundBounds(0.25, 12.5)).toEqual([0.25, 12.5]);
  });

  test('a band narrower than a hundredth keeps full precision', () => {
    // `cpu_wio` tops out at 0.21 in the sample, so a drag there can easily land
    // inside one hundredth. Rounding would collapse it to a zero-width band,
    // which is not a window — and which BaselineControls would then refuse as
    // an inverted range.
    const [low, high] = roundBounds(0.001, 0.004);
    expect(high).toBeGreaterThan(low);
    expect([low, high]).toEqual([0.001, 0.004]);
  });

  test('rounding never inverts the band', () => {
    const [low, high] = roundBounds(0.004999, 0.005001);
    expect(high).toBeGreaterThan(low);
  });
});

describe('a brushed time domain survives a redraw', () => {
  // The timeline brush applies its range by mutating the chart's scale in
  // place. Nothing but the live d3 object knew about it, so any redraw rebuilt
  // the scale from `selectedTimeRange` and snapped the chart back — which is
  // what a baseline commit started doing once `updateBaseline` gained a
  // dependency on `baselines` and so changed identity on every commit.
  //
  // Local dates, because `d3.timeFormat` labels the axis in local time.
  const FULL = [new Date(2024, 0, 1, 0, 0), new Date(2024, 0, 1, 18, 0)];
  const BRUSHED = [new Date(2024, 0, 1, 4, 0), new Date(2024, 0, 1, 8, 0)];
  const data = series(Array.from({ length: 40 }, (_, i) => i));

  const propsFor = (timeDomainRef) => ({
    data,
    field: 'metric',
    baselinesRef: { current: {} },
    selectedTimeRange: FULL,
    timeDomainRef,
    updateBaseline: () => {},
    nodeClusterMap: new Map(data.map(d => [d.nodeId, 0])),
    metadata: { units: 'units' },
    registerChart: () => {},
    showBaselines: true,
    selectedPoints: [],
  });

  const hours = (container) =>
    Array.from(container.querySelectorAll('.x-axis .tick text'))
      .map(t => Number(t.textContent.split(':')[0]));

  test('a redraw keeps the brushed window, not the derived one', () => {
    const timeDomainRef = { current: null };
    const props = propsFor(timeDomainRef);

    const { container, rerender } = render(<LineChart {...props} />);
    expect(Math.max(...hours(container))).toBeGreaterThan(8);

    // What the timeline's event handler records.
    timeDomainRef.current = BRUSHED;
    // Any prop change that re-runs the draw effect; `updateBaseline` changing
    // identity on every baseline commit is the one that regressed this.
    rerender(<LineChart {...props} updateBaseline={() => {}} />);

    const after = hours(container);
    expect(after.length).toBeGreaterThan(0);
    // 04:00-08:00 cannot label an hour outside itself.
    after.forEach(hour => {
      expect(hour).toBeGreaterThanOrEqual(4);
      expect(hour).toBeLessThanOrEqual(8);
    });
  });

  test('with nothing brushed the derived window is used', () => {
    const { container } = render(<LineChart {...propsFor({ current: null })} />);
    expect(Math.max(...hours(container))).toBeGreaterThan(8);
  });
});
