/**
 * End-to-end check against a running backend.
 *
 * Skipped unless NCV_TEST_API points at a live server, so `npm test` stays
 * offline by default:
 *
 *   NCV_TEST_API=http://127.0.0.1:5010 npm test -- --watchAll=false
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toNaiveISO } from './utils/time.js';
import { LIST_WIDTH } from './components/MetricSelect.js';

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

    // The metric list caps itself at LIST_WIDTH, so its column is sized to the
    // list rather than to a fraction of the reading column. As a fraction it
    // grew with the panel, and the surplus showed as a band of empty space to
    // the left of the charts.
    const listCol = container
      .querySelector('input[placeholder="Search metrics..."]')
      .closest('.ant-col');
    expect(listCol.style.flex).toMatch(/^0 0 \d+px$/);
    const basis = Number(/(\d+)px/.exec(listCol.style.flex)[1]);
    expect(basis).toBeGreaterThanOrEqual(LIST_WIDTH);
    expect(basis).toBeLessThan(LIST_WIDTH + 40);

    // The charts take the rest, and neither column may wrap onto its own line.
    expect(listCol.nextElementSibling.style.flex).toMatch(/^1 1 0(px)?$/);
    expect(listCol.parentElement.className).toContain('ant-row-no-wrap');

    // The charts are laid out in the metric list's order. They used to run in
    // the order metrics were switched on, so reading a chart meant hunting for
    // its metric in a list sorted by something else.
    const listOrder = Array.from(listCol.querySelectorAll('[data-metric]'))
      .map((item) => item.dataset.metric);
    const chartOrder = Array.from(container.querySelectorAll('.chart-title'))
      .map((title) => title.textContent);
    expect(listOrder.length).toBeGreaterThan(1);
    expect(chartOrder).toEqual(listOrder);

    // Nodes run down the rows and metrics across the columns.
    const declaredNodes = Number(/Nodes:\s*(\d+)/.exec(container.textContent)[1]);
    const cells = Array.from(container.querySelectorAll('.heatmap-cell'));
    const heatmapNodes = new Set(cells.map(c => c.getAttribute('y')));
    expect(heatmapNodes.size).toBe(declaredNodes);

    // One column per selected metric. Metrics whose baseline computation threw
    // were silently dropped from the heatmap, because the failure happened
    // inside a thread pool whose results were never collected.
    expect(new Set(cells.map(c => c.getAttribute('x'))).size).toBe(boxes.length);

    // The timeline draws a real in-baseline row rather than sitting empty, and
    // it discriminates: a single opacity across every cell would mean the band
    // resolution had collapsed. On the sample this spans the full 0..1 range.
    const inBaseCells = Array.from(container.querySelectorAll('.inbase-cell'));
    expect(inBaseCells.length).toBeGreaterThan(0);
    const shades = new Set(inBaseCells.map(c => c.getAttribute('opacity')));
    expect(shades.size).toBeGreaterThan(1);

    // One label per cluster, covering both of its bands — they are one
    // reading, not two, so only the group is labelled.
    const rowLabels = Array.from(container.querySelectorAll('.y-axis .row-label'))
      .map(t => t.textContent);
    expect(rowLabels.length).toBeGreaterThan(0);
    rowLabels.forEach(label => expect(label).toMatch(/^c\d+$/));
    // `g` restricts this to the per-cluster groups; the cells inside them are
    // rects whose class also begins "gap-c".
    expect(container.querySelectorAll('g[class^="gap-c"]')).toHaveLength(rowLabels.length);

    // Both bands are the same height, and the full-height reporting band is gone.
    expect(container.querySelectorAll('.coverage-cell')).toHaveLength(0);
    const bandHeights = new Set(
      ['.inbase-cell', '.gap-cell'].map(
        sel => container.querySelector(sel).getAttribute('height'))
    );
    expect(bandHeights.size).toBe(1);

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

  test('a baseline window too short for mrDMD is refused, not a 500', async () => {
    // A brush drag across a chart opened on the default 30-minute view holds
    // only a handful of samples on a coarsely sampled export, and mrDMD returns
    // no nodes below `8 * max_cycles` columns. That surfaced as a 500 from
    // inside compute_zscore; it is now a 422 the client can report and undo.
    const { active } = await (await fetch(`${API}/api/datasets`)).json();
    const metric = active.metrics[0];

    // Taken from the data rather than from a wall-clock offset: "20 minutes"
    // is a different number of samples on a 15-second export than on a
    // 5-minute one, and only the sample count decides this.
    const series = await (await fetch(
      `${API}/api/series?metrics=${encodeURIComponent(metric)}`)).json();
    const stamps = [...new Set(series.data.map(row => row.timestamp))].sort();
    expect(stamps.length).toBeGreaterThan(8);
    const window = stamps.slice(0, 5);           // 5 < the 8-column floor

    const params = new URLSearchParams({
      metrics: metric,
      vMin: '0', vMax: '1',
      // toNaiveISO, not toISOString: a `Z` would be a tz-aware Timestamp the
      // frame's naive index cannot be compared against — a different 500.
      bStart: toNaiveISO(new Date(window[0])),
      bEnd: toNaiveISO(new Date(window[window.length - 1])),
    });
    const response = await fetch(`${API}/api/mrdmd?${params}`);

    expect(response.status).toBe(422);
    const { error } = await response.json();
    // Specific enough to act on: how many samples there were, and how many are
    // needed. A bare "500 Internal Server Error" told the user nothing.
    expect(error).toMatch(/sample/);
    expect(error).toMatch(/at least \d+/);
  });

  test('a time-scoped pass analyses only the window', async () => {
    const { active } = await (await fetch(`${API}/api/datasets`)).json();
    const end = new Date(active.end);
    const start = new Date(+end - 2 * 3600000);      // the last two hours
    const q = `start=${encodeURIComponent(toNaiveISO(start))}`
            + `&end=${encodeURIComponent(toNaiveISO(end))}`;

    const full = await (await fetch(`${API}/api/dr`)).json();
    const scoped = await (await fetch(`${API}/api/dr?${q}`)).json();

    // Every stage moves, contributions included — they are what the metric
    // list ranks itself by, so a stale set would describe the wrong window.
    expect(scoped.feat_contributions.features.length)
      .toBe(full.feat_contributions.features.length);
    expect(scoped.node_cluster_map.length).toBeGreaterThan(0);

    const labels = (payload) => payload.node_cluster_map
      .map(r => `${r.nodeId}:${r.Cluster}`).sort().join('|');
    expect(labels(scoped)).not.toBe(labels(full));

    // mrDMD picks its baseline inside the window rather than across the run.
    const metric = active.metrics[0];
    const dmd = await (await fetch(
      `${API}/api/mrdmd?metrics=${encodeURIComponent(metric)}&${q}`)).json();
    const baseline = dmd.baselines.find(b => b.feature === metric);
    expect(new Date(baseline.b_start).getTime()).toBeGreaterThanOrEqual(+start);
    expect(new Date(baseline.b_end).getTime()).toBeLessThanOrEqual(+end);
  });

  test('the Time Scope switch rescopes every stage', async () => {
    const calls = [];
    const real = global.fetch;
    global.fetch = (...args) => { calls.push(String(args[0])); return real(...args); };

    try {
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelectorAll('.dr-circle').length)
        .toBeGreaterThan(0), { timeout: 60000 });

      // Nothing is scoped until the switch is on.
      expect(calls.some(u => u.includes('/api/dr') && u.includes('start='))).toBe(false);

      const scope = screen.getByText('Time Domain Scope').closest('div')
        .querySelector('button[role="switch"]');
      fireEvent.click(scope);

      // The embedding, the contributions, the deviations and the sparklines all
      // have to move together — a windowed embedding read against full-range
      // z-scores is worse than either on its own.
      await waitFor(() => {
        expect(calls.some(u => u.includes('/api/dr') && u.includes('start='))).toBe(true);
        expect(calls.some(u => u.includes('/api/mrdmd') && u.includes('start='))).toBe(true);
        expect(calls.some(u => u.includes('/api/cluster-averages') && u.includes('start='))).toBe(true);
      }, { timeout: 60000 });
    } finally {
      global.fetch = real;
    }
  }, 120000);

  test('a window too narrow to analyse names both floors', async () => {
    // Nodes ramp in over a run, so a window can be long and still nearly empty;
    // which floor was missed is what tells you to widen it or move it.
    const { active } = await (await fetch(`${API}/api/datasets`)).json();
    const end = new Date(active.end);
    const start = new Date(+end - 5 * 60000);
    const response = await fetch(`${API}/api/dr?start=${
      encodeURIComponent(toNaiveISO(start))}&end=${encodeURIComponent(toNaiveISO(end))}`);

    expect(response.status).toBe(422);
    const { error } = await response.json();
    expect(error).toMatch(/node/);
    expect(error).toMatch(/timestamp/);
  });

  test('the stream idles rather than stopping when nothing new has arrived', async () => {
    const status = await (await fetch(`${API}/api/stream/status`)).json();
    expect(status).toHaveProperty('nextBatch');
    expect(status).toHaveProperty('available');
    expect(status).toHaveProperty('watchingSource');
    // A file-backed dataset can always be re-read, so the stream never runs
    // out — there is only "nothing yet".
    if (status.watchingSource) expect(status.exhausted).toBe(false);

    const active = async () =>
      (await (await fetch(`${API}/api/datasets`)).json()).active;
    const rows = async () => (await active()).rows;
    const before = await rows();
    const beforeEnd = (await active()).end;

    // Metrics matter: with none the server skips mrDMD entirely and returns no
    // z-scores, which is correct but tests nothing. The client always sends its
    // current selection, so the test does too.
    const metrics = (await active()).metrics.slice(0, 2);
    const response = await fetch(`${API}/api/stream/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metrics, nodes: [] }),
    });
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(['waiting', 'success']).toContain(payload.status);

    if (payload.status === 'waiting') {
      // Idling must leave the dataset alone. The client relies on this to skip
      // its state updates, so a poll that quietly mutated anything would flash
      // every chart once per interval.
      expect(await rows()).toBe(before);
      return;
    }

    // A batch was folded in: the dataset grew, the extent moved, and every
    // algorithm was re-run over the larger frame. All four have to happen —
    // rows arriving without a recompute is the failure this whole path exists
    // to avoid.
    expect(payload.batch).toBeTruthy();
    expect(await rows()).toBeGreaterThan(before);
    expect(new Date(payload.extent[1]).getTime())
      .toBeGreaterThan(new Date(beforeEnd).getTime());
    expect(payload.dr_results.node_cluster_map.length).toBeGreaterThan(0);
    expect(payload.dr_results.feat_contributions.features.length).toBeGreaterThan(0);
    expect(payload.mrdmd_results.zscores.length).toBeGreaterThan(0);
  }, 120000);

  test('a streamed batch extends the time domain view', async () => {
    // The batch payload carries the series, the embedding and the z-scores but
    // *not* the coverage strip, so the timeline is the one view that only moves
    // if the client goes and asks for it. It sat frozen on the pre-stream
    // buckets while every panel beside it advanced.
    const status = await (await fetch(`${API}/api/stream/status`)).json();
    // `available` is the *total* batch count, not the remaining one, so a
    // prepared batch is left only while nextBatch is still short of it. With
    // the fixture consumed the source is watchable but not growing, so nothing
    // would ever arrive and there is nothing to assert.
    if (status.nextBatch >= status.available) return;

    const { container } = render(<App />);

    // The last cell d3 laid down in the first cluster's band. Document order is
    // the order of `coverage.times`, so this is the latest bucket that had a
    // node running — read positionally rather than by sorting the titles, whose
    // `HH:MM` carries no date: the first bucket starts a few minutes before the
    // dataset does, i.e. on the previous day, and sorts as the maximum.
    const lastBucket = () => {
      const band = container.querySelector('g[class^="inbase-c"]');
      const cells = band?.querySelectorAll('.inbase-cell title');
      const text = cells?.length ? cells[cells.length - 1].textContent : '';
      return /\u00b7 (\d{2}:\d{2}) \u00b7/.exec(text)?.[1];
    };

    await waitFor(() => expect(lastBucket()).toBeTruthy(), { timeout: 60000 });
    const before = lastBucket();

    fireEvent.click(screen.getByLabelText('Streaming'));

    // The fixture resumes one cadence step after the sample ends and runs two
    // hours past it, so the last populated bucket has to move forward.
    await waitFor(() => expect(lastBucket() > before).toBe(true), { timeout: 120000 });

    fireEvent.click(screen.getByLabelText('Streaming'));
  }, 180000);

  test('a metric can be switched off and back on', async () => {
    const { container } = render(<App />);

    await waitFor(
      () => expect(container.querySelectorAll('.heatmap-cell').length).toBeGreaterThan(0),
      { timeout: 60000 }
    );

    const boxes = () => Array.from(container.querySelectorAll('.ant-checkbox-input'));
    const charts = () => container.querySelectorAll('svg .lines').length;
    // A metric is a heatmap *column* now, not a row.
    const heatmapMetrics = () =>
      new Set(Array.from(container.querySelectorAll('.heatmap-cell'))
        .map(c => c.getAttribute('x'))).size;

    const total = boxes().length;
    expect(charts()).toBe(total);
    expect(heatmapMetrics()).toBe(total);

    // Off. Removing needs no network round trip — it is a local edit.
    fireEvent.click(boxes()[0]);
    await waitFor(() => expect(charts()).toBe(total - 1), { timeout: 30000 });
    await waitFor(() => expect(heatmapMetrics()).toBe(total - 1), { timeout: 30000 });

    // And back on: the series and the deviation scores are fetched together.
    fireEvent.click(boxes()[0]);
    await waitFor(() => expect(charts()).toBe(total), { timeout: 60000 });
    await waitFor(() => expect(heatmapMetrics()).toBe(total), { timeout: 60000 });

    expect(screen.queryByText(/Could not load metric/i)).not.toBeInTheDocument();
  }, 180000);
});
