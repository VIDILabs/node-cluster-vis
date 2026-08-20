import { Card, Col, Layout, Row, Select, Typography, Switch, Alert, Spin, Input, Button, Space, Tooltip } from "antd";
import { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import api from './api.js';
import { COVERAGE_BINS, DEFAULT_WINDOW_MINUTES, FALLBACK_DEFAULTS, STREAM_INTERVAL_MS } from './config.js';
import DRView from './components/DRPlot.js';
import MetricSelect, { LIST_WIDTH as METRIC_LIST_WIDTH } from "./components/MetricSelect.js";
import MetricView from './components/MetricView.js';
import HeatmapView, { panelWidth as heatmapPanelWidth } from './components/HeatmapView.js';
import TimelineView from './components/TimelineView.js';
import { toNaiveISO } from './utils/time.js';

const { Header, Content } = Layout;

// Header readout of the range the dataset covers. The date is dropped from the
// end when both fall on the same day, which is the usual shape of one export.
function formatExtent([start, end]) {
  const from = new Date(start);
  const to = new Date(end);
  if (Number.isNaN(+from) || Number.isNaN(+to)) return null;

  const day = (d) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
  const clock = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

  return from.toDateString() === to.toDateString()
    ? `${day(from)} ${clock(from)} – ${clock(to)}`
    : `${day(from)} ${clock(from)} – ${day(to)} ${clock(to)}`;
}
const { Option } = Select;
const { Text } = Typography;

const Placeholder = ({ height, message }) => (
  <Card style={{ height, display: "flex", justifyContent: "center", alignItems: "center" }}>
    <Typography.Text type="secondary">{message}</Typography.Text>
  </Card>
);

// The Metric Reading row's gutter. Named because the metric-list column's width
// is LIST_WIDTH plus this, and the two have to agree or the list is clipped.
const METRIC_GUTTER = 16;

function App() {
  const [datasets, setDatasets] = useState([]);
  const [activeDataset, setActiveDataset] = useState(null);
  const [remoteSource, setRemoteSource] = useState("");
  const [loadingDataset, setLoadingDataset] = useState(false);

  const [selectedPoints, setSelectedPoints] = useState(FALLBACK_DEFAULTS.selectedPoints);
  const [selectedDims, setSelectedDims] = useState(FALLBACK_DEFAULTS.selectedDims);
  const [bStart, setBStart] = useState(FALLBACK_DEFAULTS.bStart);
  const [bEnd, setBEnd] = useState(FALLBACK_DEFAULTS.bEnd);
  const [nNeighbors, setNNeighbors] = useState(FALLBACK_DEFAULTS.nNeighbors);
  const [minDist, setMinDist] = useState(FALLBACK_DEFAULTS.minDist);
  const [numClusters, setNumClusters] = useState(FALLBACK_DEFAULTS.numClusters);

  const [FCs, setFCs] = useState(null);
  const [DRTData, setDRTData] = useState(null);
  const [allMetrics, setAllMetrics] = useState([]);
  const [hiddenClusters, setHiddenClusters] = useState(() => new Set());
  const [dataExtent, setDataExtent] = useState([null, null]);
  const [metricData, setMetricData] = useState(null);
  const [avgSeriesData, setAvgSeriesData] = useState({});
  const [zScores, setzScores] = useState(null);
  const [baselines, setBaselines] = useState(null);
  const [headerMap, setHeaderMap] = useState({});
  const [nodeClusterMap, setNodeClusterMap] = useState(new Map());
  const [coverage, setCoverage] = useState(null);
  const [allNodes, setAllNodes] = useState([]);
  const [error, setError] = useState(null);

  const baselinesRef = useRef({});
  // Mirrors `baselines` for `refreshCoverage`, which must send them without
  // taking a dependency on them.
  const baselinesStateRef = useRef(null);
  // `{ start, end }` on the wire, or null for the whole range. A ref because
  // every fetch callback has to send it and none of them should be rebuilt when
  // it changes — that is what would redraw every chart on each brush.
  const scopeRef = useRef(null);

  const [streamingMode, setStreamingMode] = useState(false);
  // When on, every stage — DR, clustering, ccPCA contributions, mrDMD, the
  // cluster-average sparklines — is recomputed over the timeline's selection
  // instead of the whole run.
  const [timeScoped, setTimeScoped] = useState(false);
  const [scopeRange, setScopeRange] = useState(null);
  const [rescoping, setRescoping] = useState(false);
  const [streamStatus, setStreamStatus] = useState(null);

  const totalNodes = DRTData?.length || 0;
  const totalMeasures = allMetrics.length;

  // --- derived views ------------------------------------------------------

  // Group the flat rows the API returns into one array per metric, which is the
  // shape the line charts consume. Every node is kept: the charts draw the whole
  // population and fade what isn't selected, so this no longer has to be redone
  // each time the lasso moves.
  const buildMetricData = useCallback((rows, dims) => {
    const grouped = {};
    dims.forEach((dim) => { grouped[dim] = []; });

    rows.forEach((row) => {
      const timestamp = new Date(row.timestamp);
      dims.forEach((dim) => {
        if (row[dim] === undefined) return;
        grouped[dim].push({ timestamp, nodeId: row.nodeId, value: row[dim] });
      });
    });
    return grouped;
  }, []);

  // --- data loading -------------------------------------------------------

  const applyDrPayload = useCallback((payload) => {
    setDRTData(payload.dr_features);
    setFCs(payload.feat_contributions);
    setNodeClusterMap(new Map(payload.node_cluster_map.map((d) => [d.nodeId, d.Cluster])));
    // The server picks n_neighbors and k from the data unless the user overrode
    // them, so the controls have to be told what it settled on.
    if (payload.params) {
      setNNeighbors(payload.params.nNeighbors);
      setMinDist(payload.params.minDist);
      setNumClusters(payload.params.numClusters);
    }
  }, []);

  useEffect(() => { baselinesStateRef.current = baselines; }, [baselines]);

  // The window the charts and the timeline brush open on: the tail of the data,
  // or the whole of it when that is shorter. Distinct from bStart/bEnd, which
  // are the mrDMD baseline window and answer a different question.
  //
  // Also memoized because every LineChart's draw effect depends on it — built
  // inline in the JSX it was a new array on every render, so any state change
  // anywhere in the app redrew every chart on screen.
  const timeRange = useMemo(() => {
    const start = new Date(dataExtent[0]);
    const end = new Date(dataExtent[1]);
    if (Number.isNaN(+start) || Number.isNaN(+end)) {
      return [new Date(bStart), new Date(bEnd)];
    }
    const windowStart = new Date(+end - DEFAULT_WINDOW_MINUTES * 60000);
    return [windowStart > start ? windowStart : start, end];
  }, [dataExtent, bStart, bEnd]);

  const effectiveScope = timeScoped ? (scopeRange || timeRange) : null;
  scopeRef.current = effectiveScope
    ? { start: toNaiveISO(effectiveScope[0]), end: toNaiveISO(effectiveScope[1]) }
    : null;
  // A string, so the effect below compares windows by value; two Date objects
  // for the same instant are never `===`, which would recompute on every render.
  const scopeSignature = effectiveScope
    ? `${toNaiveISO(effectiveScope[0])}/${toNaiveISO(effectiveScope[1])}`
    : '';

  // The timeline announces its brush; App only acts on it when scoping is on,
  // but it records the range either way so switching the toggle on uses the
  // selection already on screen rather than waiting for the next drag.
  useEffect(() => {
    const onDomain = (event) => setScopeRange(event.detail);
    window.addEventListener('time-domain-updated', onDomain);
    return () => window.removeEventListener('time-domain-updated', onDomain);
  }, []);

  // Coverage is per-cluster but scoped to the current selection, so it answers
  // "when did the nodes I just picked have data".
  // `metrics` scopes the gap row: a row counts as a reading only if one of them
  // is a real value, so the strip describes what the charts are showing.
  // The baselines travel with it because the timeline's in-baseline row is
  // scored against them and they are editable. They are read from a ref rather
  // than closed over: five callbacks depend on `refreshCoverage`, and making it
  // depend on `baselines` would rebuild all of them on every drag of a baseline
  // rectangle. A caller that already knows the new window passes it explicitly.
  const refreshCoverage = useCallback(async (nodes, metrics, baselineOverride) => {
    try {
      setCoverage(await api.coverage(
        nodes, COVERAGE_BINS, metrics, baselineOverride ?? baselinesStateRef.current,
      ));
    } catch (err) {
      console.error('Could not load coverage', err);
      setCoverage(null);
    }
  }, []);

  // Always scored over every node. The heatmap shows the whole population and
  // dims what isn't selected, so narrowing this to the lasso would blank out
  // most of the panel and cost a round trip on every selection change.
  const fetchMrdmd = useCallback(async (nodes, dims) => {
    if (!dims.length || !nodes.length) {
      setzScores([]);
      setBaselines([]);
      return;
    }
    const data = await api.mrdmd({
      nodes, metrics: dims, recomputeBase: true, ...(scopeRef.current || {}),
    });
    setzScores(data.zscores);
    setBaselines(data.baselines);
    baselinesRef.current = data.baselines.reduce((acc, baseline) => {
      acc[baseline.feature] = {
        baselineX: [new Date(baseline.b_start), new Date(baseline.b_end)],
        baselineY: [baseline.v_min, baseline.v_max],
      };
      return acc;
    }, {});
  }, []);

  // Fetched for *every* metric, not just the selected ones: the sparklines in
  // the metric list are what you choose from, so a blank one for an unselected
  // metric defeats the purpose. It only has to be refetched when the clustering
  // changes, since that is what the averages are grouped by.
  const refreshClusterAverages = useCallback(async (dims) => {
    if (!dims.length) return setAvgSeriesData({});
    try {
      setAvgSeriesData(await api.clusterAverages(dims, undefined, undefined,
        scopeRef.current?.start, scopeRef.current?.end));
    } catch (err) {
      console.error('Could not load cluster averages', err);
      setAvgSeriesData({});
    }
  }, []);

  // Load everything that depends on the active dataset.
  const initializeDataset = useCallback(async (description) => {
    const defaults = description.defaults || FALLBACK_DEFAULTS;

    setActiveDataset(description);
    setSelectedPoints(defaults.selectedPoints);
    setSelectedDims(defaults.selectedDims);
    setBStart(defaults.bStart);
    setBEnd(defaults.bEnd);
    setNNeighbors(defaults.nNeighbors);
    setMinDist(defaults.minDist);
    setNumClusters(defaults.numClusters);
    setDataExtent([description.start, description.end]);
    setAllNodes(description.nodes || []);

    const [headers, seriesPayload, drPayload] = await Promise.all([
      api.metadata(),
      api.series(defaults.selectedDims),
      // No parameters: the server derives n_neighbors, min_dist and k from the
      // data and reports back what it used.
      api.dr({}),
    ]);

    setHeaderMap(headers);
    setAllMetrics(seriesPayload.allMetrics);
    setMetricData(buildMetricData(seriesPayload.data, defaults.selectedDims));
    applyDrPayload(drPayload);

    await Promise.all([
      fetchMrdmd(description.nodes || [], defaults.selectedDims),
      refreshClusterAverages(seriesPayload.allMetrics),
      refreshCoverage([], defaults.selectedDims),
    ]);
  }, [applyDrPayload, buildMetricData, fetchMrdmd, refreshClusterAverages, refreshCoverage]);

  const switchDataset = useCallback(async (source) => {
    setLoadingDataset(true);
    setError(null);
    try {
      const description = await api.loadDataset(source);
      await initializeDataset(description);
      const listing = await api.datasets();
      setDatasets(listing.available);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Could not load that source.');
    } finally {
      setLoadingDataset(false);
    }
  }, [initializeDataset]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingDataset(true);
      try {
        const listing = await api.datasets();
        if (cancelled) return;
        setDatasets(listing.available);
        if (listing.active) {
          await initializeDataset(listing.active);
        } else {
          setError('No dataset is loaded on the server. Choose or enter a source below.');
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) setError(`Cannot reach the API. Is the server running? (${err.message})`);
      } finally {
        if (!cancelled) setLoadingDataset(false);
      }
    })();
    return () => { cancelled = true; };
    // Runs once on mount; initializeDataset is stable via useCallback.
  }, [initializeDataset]);

  // --- interactions -------------------------------------------------------

  const handleRecompute = useCallback(async (k, neighbors, dist, force, useDefaults) => {
    // "Reset defaults" sends nothing at all, which is how the server is asked to
    // re-derive every parameter from the data. applyDrPayload then mirrors what
    // it chose back into the controls.
    const params = useDefaults
      ? { numClusters: 0, nNeighbors: 0, minDist: -1 }
      : { numClusters: k, nNeighbors: neighbors, minDist: dist };

    try {
      // Changing k alone reuses the cached embedding; changing UMAP parameters
      // requires the full pass.
      const changedEmbedding = useDefaults
        || params.nNeighbors !== nNeighbors
        || params.minDist !== minDist;
      const scope = scopeRef.current || {};
      const payload = changedEmbedding
        ? await api.dr({ ...params, force: true, ...scope })
        : await api.clusters({ ...params, force, ...scope });

      applyDrPayload(payload);
      await Promise.all([
        refreshClusterAverages(allMetrics),
        refreshCoverage(selectedPoints, selectedDims),
      ]);
      setError(null);
    } catch (err) {
      console.error(err);
      setError(`Could not recompute clusters: ${err.message}`);
    }
  }, [
    allMetrics, applyDrPayload, minDist, nNeighbors, refreshClusterAverages,
    refreshCoverage, selectedDims, selectedPoints,
  ]);

  const handleMetricSelectChange = useCallback(async (key) => {
    const isRemoving = selectedDims.includes(key);
    const nextDims = isRemoving
      ? selectedDims.filter((dim) => dim !== key)
      : [key, ...selectedDims];

    // Ticking the box is local; it should not wait on the network.
    setSelectedDims(nextDims);

    if (isRemoving) {
      setMetricData((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setzScores((prev) => (prev || []).map(({ [key]: _removed, ...rest }) => rest));
      await refreshCoverage(selectedPoints, nextDims);
      return;
    }

    try {
      // Both requests at once, and the state they feed applied in a single
      // batch. Awaiting them in turn made the charts, the heatmap and the
      // timeline each land on their own render, which is what read as several
      // separate reloads.
      const [payload, dmd] = await Promise.all([
        api.series([key], undefined),
        api.mrdmd({
          nodes: allNodes, metrics: [key], recomputeBase: true,
          ...(scopeRef.current || {}),
        }),
      ]);

      dmd.baselines.forEach((baseline) => {
        baselinesRef.current[baseline.feature] = {
          baselineX: [new Date(baseline.b_start), new Date(baseline.b_end)],
          baselineY: [baseline.v_min, baseline.v_max],
        };
      });

      setMetricData((prev) => ({
        ...prev,
        ...buildMetricData(payload.data, [key]),
      }));
      setzScores((prev) => mergeZScores(prev || [], dmd.zscores, key));
      setBaselines((prev) => [...dmd.baselines, ...(prev || [])]);

      await refreshCoverage(selectedPoints, nextDims);
    } catch (err) {
      console.error(err);
      setError(`Could not load metric "${key}": ${err.message}`);
      // Put the list back the way it was; the metric never arrived.
      setSelectedDims(selectedDims);
    }
  }, [allNodes, buildMetricData, refreshCoverage, selectedDims, selectedPoints]);

  // Everything is refetched rather than patched: the embedding, the cluster
  // labels, the ccPCA contributions and the z-scores are all functions of the
  // rows in scope, and a windowed embedding read against full-range deviations
  // would be worse than either on its own.
  const applyTimeScope = useCallback(async () => {
    setRescoping(true);
    try {
      const payload = await api.dr({ force: true, ...(scopeRef.current || {}) });
      applyDrPayload(payload);
      await Promise.all([
        fetchMrdmd(allNodes, selectedDims),
        refreshClusterAverages(allMetrics),
        refreshCoverage(selectedPoints, selectedDims),
      ]);
      setError(null);
    } catch (err) {
      console.error(err);
      // A window with too few nodes or timestamps comes back as a 422 naming
      // both floors, which is more use than "recompute failed".
      setError(`Could not analyse that time range: ${err.message}`);
    } finally {
      setRescoping(false);
    }
  }, [
    allMetrics, allNodes, applyDrPayload, fetchMrdmd, refreshClusterAverages,
    refreshCoverage, selectedDims, selectedPoints,
  ]);

  // Fires when the toggle flips and on each brush while it is on. The first run
  // only records the current window, so a page load does not pay for a
  // recompute nobody asked for; after that only a *changed* window recomputes,
  // which is what keeps an unrelated re-render from costing a DR pass.
  const appliedScopeRef = useRef(null);
  useEffect(() => {
    if (!activeDataset) return;
    if (appliedScopeRef.current === scopeSignature) return;
    const first = appliedScopeRef.current === null;
    appliedScopeRef.current = scopeSignature;
    if (!first) applyTimeScope();
  }, [activeDataset, scopeSignature, applyTimeScope]);

  // A committed baseline — dragged rectangle or typed bound — changes which
  // nodes count as behaving normally, so the timeline's in-baseline row is
  // refetched against the window that was just set.
  const handleBaselineChange = useCallback((nextBaselines) => {
    refreshCoverage(selectedPoints, selectedDims, nextBaselines);
  }, [refreshCoverage, selectedDims, selectedPoints]);

  // Selection changes nothing that has to be recomputed: the charts already hold
  // every node and fade the ones outside the selection. Only the coverage strip
  // is scoped to it, and that is a single cheap request.
  const updateSelectedNodes = useCallback((selectedNodeIds) => {
    setSelectedPoints(selectedNodeIds);
    refreshCoverage(selectedNodeIds, selectedDims);
  }, [refreshCoverage, selectedDims]);

  // --- streaming ----------------------------------------------------------

  useEffect(() => {
    if (!streamingMode || !activeDataset) return undefined;

    let cancelled = false;
    const tick = async () => {
      try {
        const payload = await api.streamNext({
          metrics: selectedDims,
          nodes: selectedPoints,
          n_neighbors: nNeighbors,
          min_dist: minDist,
          num_clusters: numClusters,
        });
        if (cancelled) return;

        // Nothing new at the source yet. Keep polling and leave every view
        // alone — repainting identical data would flash the charts once a
        // second for no reason.
        if (payload.status === 'waiting') {
          setStreamStatus({ nextBatch: payload.nextBatch, exhausted: false, waiting: true });
          return;
        }

        setMetricData(buildMetricData(payload.data, selectedDims));
        applyDrPayload(payload.dr_results);
        const nextBaselines = payload.mrdmd_results?.baselines;
        if (payload.mrdmd_results?.zscores?.length) {
          setzScores(payload.mrdmd_results.zscores);
          setBaselines(nextBaselines);
        }
        // New rows shift the extent, which is what the timeline and the charts
        // open on; without this the window never moves to cover them.
        if (payload.extent) setDataExtent(payload.extent);
        setStreamStatus({ nextBatch: payload.nextBatch, exhausted: false, waiting: false });

        // The timeline and the metric-list sparklines are the two views the
        // batch payload does *not* carry: coverage is bucketed per cluster and
        // the averages are grouped by cluster, so both are stale the moment
        // `applyDrPayload` re-labels the nodes — and neither would extend over
        // the buckets the new rows just added. The new baselines are passed
        // explicitly because `setBaselines` has not committed at this point, so
        // `baselinesStateRef` still holds the previous window (same hazard as
        // `updateBaseline`).
        await Promise.all([
          refreshCoverage(selectedPoints, selectedDims, nextBaselines),
          refreshClusterAverages(allMetrics),
        ]);
      } catch (err) {
        if (cancelled) return;
        if (err.status === 404) {
          setStreamStatus({ exhausted: true });
          setStreamingMode(false);
        } else if (err.status === 422) {
          // The batch did not continue this dataset, or the pipeline could not
          // digest it. The server has rolled back, so stopping here leaves the
          // views showing exactly what they showed before.
          setError(`Streaming stopped: ${err.message}`);
          setStreamingMode(false);
        } else {
          console.error(err);
          setError(`Streaming stopped: ${err.message}`);
          setStreamingMode(false);
        }
      }
    };

    const handle = setInterval(tick, STREAM_INTERVAL_MS);
    tick();
    return () => { cancelled = true; clearInterval(handle); };
  }, [
    streamingMode, activeDataset, selectedDims, selectedPoints,
    nNeighbors, minDist, numClusters, applyDrPayload, buildMetricData,
    refreshCoverage, refreshClusterAverages, allMetrics,
  ]);

  // --- render -------------------------------------------------------------


  const extentLabel = useMemo(() => formatExtent(dataExtent), [dataExtent]);

  // Cluster visibility is owned here and set in exactly one place — the button
  // row under the Node Similarity controls. Every view reads it: the embedding
  // drops those points, the heatmap those columns, the charts those polylines,
  // the timeline those rows, the metric list those bars and sparklines.
  const clusters = useMemo(() => {
    const seen = new Set();
    nodeClusterMap.forEach((cluster) => {
      if (Number.isFinite(cluster)) seen.add(cluster);
    });
    return Array.from(seen).sort((a, b) => a - b);
  }, [nodeClusterMap]);

  // Re-running k renumbers the clusters, so a stale hidden set would leave
  // nodes invisible with no button switched off to explain it.
  const clusterKey = clusters.join(',');
  useEffect(() => { setHiddenClusters(new Set()); }, [clusterKey]);

  const toggleCluster = useCallback((cluster) => {
    setHiddenClusters((prev) => {
      const next = new Set(prev);
      if (next.has(cluster)) next.delete(cluster);
      else next.add(cluster);
      return next;
    });
  }, []);

  const hasSeries = Boolean(metricData && baselines && zScores && Object.keys(headerMap).length);
  const hasDr = Boolean(DRTData && FCs);

  // The deviation panel is exactly as wide as its map: one 20px column per
  // metric plus the two gutters. Everything else goes to the reading column.
  // Derived from the z-scores rather than from `selectedDims` because a metric
  // whose baseline could not be computed has no column in the map, and a panel
  // sized for a column that isn't drawn leaves a strip of dead space.
  const heatmapWidth = useMemo(
    () => heatmapPanelWidth(zScores?.length ? Object.keys(zScores[0]).length - 1 : 0),
    [zScores]
  );

  return (
    <Layout style={{ height: "100vh", padding: "5px" }}>
      <Header style={{ background: "#fff", padding: "0 10px", marginBottom: "2px" }}>
        <Row justify="space-between" align="middle">
          <Col>
            <Row align="middle" gutter={8}>
              <Col>
                <Typography.Title level={1} style={{ margin: 0, fontSize: "20px", paddingRight: '20px' }}>
                  Cluster-Based Multivariate Time Series Analysis
                </Typography.Title>
              </Col>
              <Col>
                <Select
                  style={{ width: 200 }}
                  value={activeDataset?.name}
                  onChange={switchDataset}
                  loading={loadingDataset}
                  placeholder="Select dataset"
                >
                  {datasets.map((f) => (
                    <Option key={f} value={f}>{f}</Option>
                  ))}
                </Select>
              </Col>
              <Col>
                <Space.Compact>
                  <Input
                    style={{ width: 220 }}
                    placeholder="or a CSV/Parquet URL or path"
                    value={remoteSource}
                    onChange={(e) => setRemoteSource(e.target.value)}
                    onPressEnter={() => remoteSource && switchDataset(remoteSource)}
                  />
                  <Button
                    onClick={() => remoteSource && switchDataset(remoteSource)}
                    loading={loadingDataset}
                  >
                    Ingest
                  </Button>
                </Space.Compact>
              </Col>
            </Row>
          </Col>

          <Col>
            <Row gutter={24} align="middle">
              <Col>
                <Text strong italic style={{ fontSize: "14px", paddingRight: '10px' }}>
                  Streaming
                </Text>
                <Switch
                  size="small"
                  aria-label="Streaming"
                  checked={streamingMode}
                  disabled={!activeDataset || streamStatus?.exhausted}
                  onChange={setStreamingMode}
                />
              </Col>
              <Col>
                <Tooltip title="Recompute the embedding, clusters, feature contributions and mrDMD scores over the Time Domain View's selection. Moving the selection recomputes them again.">
                  <Text strong italic style={{ fontSize: "14px", paddingRight: '10px' }}>
                    Time Domain Scope
                  </Text>
                </Tooltip>
                <Switch
                  size="small"
                  aria-label="Time Domain Scope"
                  checked={timeScoped}
                  loading={rescoping}
                  disabled={!activeDataset}
                  onChange={setTimeScoped}
                />
              </Col>
              <Col>
                <Text strong italic style={{ fontSize: "16px" }}>
                  Nodes: {totalNodes}
                </Text>
              </Col>
              <Col>
                <Text strong italic style={{ fontSize: "16px" }}>Metrics: {totalMeasures}</Text>
              </Col>
              {extentLabel && (
                <Col>
                  <Text strong italic style={{ fontSize: "16px" }}>{extentLabel}</Text>
                </Col>
              )}
            </Row>
          </Col>
        </Row>
      </Header>

      {error && (
        <Alert
          type="error"
          showIcon
          closable
          message={error}
          onClose={() => setError(null)}
          style={{ marginBottom: 4 }}
        />
      )}

      <Content style={{ marginTop: "5px" }}>
        <Spin spinning={loadingDataset} tip="Loading dataset…">
          {/* Three columns, left to right: the time-and-series reading on the
              left, then the embedding, then the per-node deviations.

              The heatmap column is sized in pixels, not 24ths: its map is a
              fixed 20px per metric plus two gutters, so it has an exact natural
              width and nothing to spend anything beyond it on. The reading
              column takes whatever that leaves.

              `wrap={false}` and a flex-basis of 0 on that column are both
              load-bearing. A row of columns wraps on the items' *hypothetical*
              sizes — their flex-basis — before any shrinking is considered, and
              `flex="auto"` means `flex: 1 1 auto`, whose basis is the column's
              content width. `min-width: 0` does not reduce a content basis, so
              the reading column measured wider than the space left and the
              other two dropped onto a second line. A basis of 0 asks for
              nothing and grows into the leftover; nowrap says outright that
              these are three columns, not a grid. The min-width is the floor at
              which the row overflows sideways instead of squeezing the charts
              into nothing — visible and recoverable, unlike a silent collapse. */}
          <Row gutter={[8, 8]} wrap={false}>
            <Col flex="1 1 0" style={{ minWidth: 320 }} className="dashboard-column">
              {hasDr && coverage?.clusters?.length ? (
                <TimelineView
                  windowStart={timeRange[0]}
                  windowEnd={timeRange[1]}
                  coverage={coverage}
                  nodeDataStart={dataExtent[0]}
                  nodeDataEnd={dataExtent[1]}
                  hiddenClusters={hiddenClusters}
                />
              ) : (
                <Placeholder height="30vh" message="No timeline data yet" />
              )}

              {hasSeries ? (
                <Card title="METRIC READING VIEW" size="small" className="panel-fill">
                  {/* Same shape as the dashboard row above, for the same
                      reason. MetricSelect caps itself at LIST_WIDTH, so a
                      fractional span gave it whatever 7/24 happened to be —
                      which, once the reading column grew to take the dashboard's
                      leftover, was ~100px more than the list can use. That
                      surplus showed as a band of empty space to the left of the
                      charts. Sized to the list, the charts get it back. */}
                  <Row gutter={[METRIC_GUTTER, METRIC_GUTTER]} wrap={false}>
                    <Col
                      flex={`0 0 ${METRIC_LIST_WIDTH + METRIC_GUTTER}px`}
                      style={{ height: "100%", minHeight: 0 }}
                    >
                      <MetricSelect
                        selectedDims={selectedDims}
                        headerMap={headerMap}
                        metrics={allMetrics}
                        fcs={FCs}
                        avgSeriesData={avgSeriesData}
                        onMetricSelectChange={handleMetricSelectChange}
                        hiddenClusters={hiddenClusters}
                      />
                    </Col>
                    <Col flex="1 1 0" style={{ height: "100%", minHeight: 0, minWidth: 0 }}>
                      <MetricView
                        data={metricData}
                        timeRange={timeRange}
                        selectedDims={selectedDims}
                        selectedPoints={selectedPoints}
                        fcs={FCs}
                        setSelectedDims={setSelectedDims}
                        baselines={baselines}
                        baselinesRef={baselinesRef}
                        onBaselineChange={handleBaselineChange}
                        onError={setError}
                        scopeRef={scopeRef}
                        zScores={zScores}
                        setzScores={setzScores}
                        setBaselines={setBaselines}
                        nodeClusterMap={nodeClusterMap}
                        headerMap={headerMap}
                        hiddenClusters={hiddenClusters}
                      />
                    </Col>
                  </Row>
                </Card>
              ) : (
                <Placeholder height="60vh" message="No metric data yet" />
              )}
            </Col>

            <Col span={6} className="dashboard-column">
              {hasDr ? (
                <DRView
                  data={DRTData}
                  type="time"
                  setSelectedPoints={setSelectedPoints}
                  selectedPoints={selectedPoints}
                  nodeClusterMap={nodeClusterMap}
                  handleRecompute={handleRecompute}
                  updateSelectedNodes={updateSelectedNodes}
                  nNeighbors={nNeighbors}
                  setNNeighbors={setNNeighbors}
                  minDist={minDist}
                  setMinDist={setMinDist}
                  numClusters={numClusters}
                  setNumClusters={setNumClusters}
                  clusters={clusters}
                  hiddenClusters={hiddenClusters}
                  onToggleCluster={toggleCluster}
                />
              ) : (
                <Placeholder height="40vh" message="No embedding yet" />
              )}
            </Col>

            <Col flex={`0 0 ${heatmapWidth}px`} className="dashboard-column">
              {zScores?.length ? (
                <HeatmapView
                  data={zScores}
                  nodeClusterMap={nodeClusterMap}
                  selectedPoints={selectedPoints}
                  hiddenClusters={hiddenClusters}
                />
              ) : (
                <Placeholder height="50vh" message="No deviation scores yet" />
              )}
            </Col>
          </Row>
        </Spin>
      </Content>
    </Layout>
  );
}

function mergeZScores(oldZScores, newZScores, newFeature) {
  const merged = new Map(oldZScores.map((entry) => [entry.nodeId, { ...entry }]));
  newZScores.forEach((entry) => {
    const existing = merged.get(entry.nodeId) || { nodeId: entry.nodeId };
    merged.set(entry.nodeId, { ...existing, [newFeature]: entry[newFeature] });
  });
  return Array.from(merged.values());
}

export default App;
