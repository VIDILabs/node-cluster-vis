/**
 * End-to-end check against a running backend.
 *
 * Skipped unless NCV_TEST_API points at a live server, so `npm test` stays
 * offline by default:
 *
 *   NCV_TEST_API=http://127.0.0.1:5010 npm test -- --watchAll=false
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const API = process.env.NCV_TEST_API;
const maybe = API ? describe : describe.skip;

maybe('App against a live API', () => {
  let App;

  beforeAll(async () => {
    process.env.REACT_APP_API_BASE = API;
    // jsdom ships no fetch; hand the app Node's real one so requests hit the
    // server instead of being stubbed.
    global.fetch = fetch;
    App = (await import('./App')).default;
  });

  test('loads a dataset and renders every panel', async () => {
    render(<App />);

    // Panels only lose their placeholder once real data has arrived.
    await waitFor(
      () => {
        expect(screen.getByText(/TIME DOMAIN VIEW/i)).toBeInTheDocument();
        expect(screen.getByText(/NODE SIMILARITY VIEW/i)).toBeInTheDocument();
        expect(screen.getByText(/METRIC READING VIEW/i)).toBeInTheDocument();
        expect(screen.getByText(/NODE BEHAVIOR VIEW/i)).toBeInTheDocument();
      },
      { timeout: 60000 }
    );

    // A node count only renders once the DR response has been applied.
    await waitFor(() => {
      expect(screen.getByText(/Nodes: [1-9]/)).toBeInTheDocument();
      expect(screen.getByText(/Metrics: [1-9]/)).toBeInTheDocument();
    }, { timeout: 60000 });

    expect(screen.queryByText(/Cannot reach the API/i)).not.toBeInTheDocument();
  }, 120000);

  test('opens with every metric and every node in play', async () => {
    const { container } = render(<App />);

    // Wait for the deviation scores, the last thing to land.
    await waitFor(
      () => expect(container.querySelectorAll('.heatmap-cell').length).toBeGreaterThan(0),
      { timeout: 60000 }
    );

    const boxes = Array.from(container.querySelectorAll('.ant-checkbox-input'));
    expect(boxes.length).toBeGreaterThan(0);
    // Every metric the dataset carries starts selected, so nothing in the
    // metric-reading view is silently missing.
    expect(boxes.filter(b => b.checked)).toHaveLength(boxes.length);

    // One line chart per metric, each carrying lines for the whole node set.
    const charts = Array.from(container.querySelectorAll('svg .lines'));
    expect(charts.length).toBe(boxes.length);

    // Every chart draws real polylines with vertical spread. Metrics used to
    // render as flat lines on the axis floor — the chart's time domain covered
    // only the first fifth of the range, and one outlier crushed the rest of
    // the distribution onto zero.
    charts.forEach((chart) => {
      const paths = Array.from(chart.querySelectorAll('path.line'));
      expect(paths.length).toBeGreaterThan(0);

      const ys = paths.flatMap((path) => {
        const d = path.getAttribute('d') || '';
        return Array.from(d.matchAll(/[ML,]\s*[-\d.]+\s*,\s*([-\d.]+)/g), (m) => Number(m[1]));
      }).filter(Number.isFinite);

      expect(ys.length).toBeGreaterThan(10);
      // Not every point pinned to the same height.
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(20);
    });

    const declaredNodes = Number(/Nodes:\s*(\d+)/.exec(container.textContent)[1]);
    const cells = Array.from(container.querySelectorAll('.heatmap-cell'));
    const heatmapNodes = new Set(cells.map(c => c.getAttribute('x')));
    expect(heatmapNodes.size).toBe(declaredNodes);

    // One row per selected metric. Metrics whose baseline computation threw were
    // silently dropped from the heatmap, because the failure happened inside a
    // thread pool whose results were never collected.
    expect(new Set(cells.map(c => c.getAttribute('y'))).size).toBe(boxes.length);

    // The timeline draws real coverage rather than sitting empty, which is what
    // the old all-metrics-read-zero downtime rule produced.
    expect(container.querySelectorAll('.coverage-cell').length).toBeGreaterThan(0);

    // One label per cluster, covering both of its bands — the gap band is a
    // qualifier on the row above, not a peer of it, so it is not labelled.
    const rowLabels = Array.from(container.querySelectorAll('.y-axis .row-label'))
      .map(t => t.textContent);
    expect(rowLabels.length).toBeGreaterThan(0);
    rowLabels.forEach(label => expect(label).toMatch(/^c\d+$/));
    // `g` restricts this to the per-cluster groups; the cells inside them are
    // rects whose class also begins "gap-c".
    expect(container.querySelectorAll('g[class^="gap-c"]')).toHaveLength(rowLabels.length);

    // Gap bands are drawn shorter than the coverage bands above them.
    const coverageHeight = Number(container.querySelector('.coverage-cell').getAttribute('height'));
    const gapHeight = Number(container.querySelector('.gap-cell').getAttribute('height'));
    expect(gapHeight).toBeLessThan(coverageHeight);

    // And they find real blank readings. Counting per (node, metric, timestamp)
    // cell is what makes them fire; the old per-row rule needed every metric
    // blank at once and found nothing in this sample.
    expect(container.querySelectorAll('.gap-cell').length).toBeGreaterThan(0);

    // The embedding is actually drawn, at a real pixel size. An SVG at
    // height:100% inside an auto-height div computes to zero, which took the
    // whole scatter plot off the screen without failing anything.
    const scatter = container.querySelector('[id^="dr-chart-svg"]');
    expect(Number(scatter.getAttribute('width'))).toBeGreaterThan(0);
    expect(Number(scatter.getAttribute('height'))).toBeGreaterThan(0);
    expect(container.querySelectorAll('.dr-circle').length).toBe(declaredNodes);
  }, 120000);

  test('a metric can be switched off and back on', async () => {
    const { container } = render(<App />);

    await waitFor(
      () => expect(container.querySelectorAll('.heatmap-cell').length).toBeGreaterThan(0),
      { timeout: 60000 }
    );

    const boxes = () => Array.from(container.querySelectorAll('.ant-checkbox-input'));
    const charts = () => container.querySelectorAll('svg .lines').length;
    const heatmapRows = () =>
      new Set(Array.from(container.querySelectorAll('.heatmap-cell'))
        .map(c => c.getAttribute('y'))).size;

    const total = boxes().length;
    expect(charts()).toBe(total);
    expect(heatmapRows()).toBe(total);

    // Off. Removing needs no network round trip — it is a local edit.
    fireEvent.click(boxes()[0]);
    await waitFor(() => expect(charts()).toBe(total - 1), { timeout: 30000 });
    await waitFor(() => expect(heatmapRows()).toBe(total - 1), { timeout: 30000 });

    // And back on: the series and the deviation scores are fetched together.
    fireEvent.click(boxes()[0]);
    await waitFor(() => expect(charts()).toBe(total), { timeout: 60000 });
    await waitFor(() => expect(heatmapRows()).toBe(total), { timeout: 60000 });

    expect(screen.queryByText(/Could not load metric/i)).not.toBeInTheDocument();
  }, 180000);
});
