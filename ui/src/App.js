import { Card, Col, Layout, Row, Select, Typography, Switch, Alert, Spin, Input, Button, Space } from "antd";
import { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import api from './api.js';
import { COVERAGE_BINS, DEFAULT_WINDOW_MINUTES, FALLBACK_DEFAULTS, STREAM_INTERVAL_MS } from './config.js';
import DRView from './components/DRPlot.js';
import MetricSelect from "./components/MetricSelect.js";
import MetricView from './components/MetricView.js';
import HeatmapView from './components/HeatmapView.js';
import TimelineView from './components/TimelineView.js';

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

  const [streamingMode, setStreamingMode] = useState(false);
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

  // Coverage is per-cluster but scoped to the current selection, so it answers
  // "when did the nodes I just picked have data".
  // `metrics` scopes the gap row: a row counts as a reading only if one of them
  // is a real value, so the strip describes what the charts are showing.
  const refreshCoverage = useCallback(async (nodes, metrics) => {
    try {
      setCoverage(await api.coverage(nodes, COVERAGE_BINS, metrics));
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
    const data = await api.mrdmd({ nodes, metrics: dims, recomputeBase: true });
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
      setAvgSeriesData(await api.clusterAverages(dims));
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
      const payload = changedEmbedding
        ? await api.dr({ ...params, force: true })
        : await api.clusters({ ...params, force });

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
        api.mrdmd({ nodes: allNodes, metrics: [key], recomputeBase: true }),
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

        setMetricData(buildMetricData(payload.data, selectedDims));
        applyDrPayload(payload.dr_results);
        if (payload.mrdmd_results?.zscores?.length) {
          setzScores(payload.mrdmd_results.zscores);
          setBaselines(payload.mrdmd_results.baselines);
        }
        setStreamStatus({ nextBatch: payload.nextBatch, exhausted: false });
      } catch (err) {
        if (cancelled) return;
        if (err.status === 404) {
          setStreamStatus({ exhausted: true });
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
  ]);

  // --- render -------------------------------------------------------------

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
                  style={{ width: 230 }}
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
                    style={{ width: 260 }}
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
                  checked={streamingMode}
                  disabled={!activeDataset || streamStatus?.exhausted}
                  onChange={setStreamingMode}
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
          <Row gutter={[8, 8]}>
            <Col span={14} className="dashboard-column">
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
                  <Row gutter={[16, 16]}>
                    <Col span={8} style={{ height: "100%", minHeight: 0 }}>
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
                    <Col span={16} style={{ height: "100%", minHeight: 0 }}>
                      <MetricView
                        data={metricData}
                        timeRange={timeRange}
                        selectedDims={selectedDims}
                        selectedPoints={selectedPoints}
                        fcs={FCs}
                        setSelectedDims={setSelectedDims}
                        baselines={baselines}
                        baselinesRef={baselinesRef}
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

            <Col span={10} className="dashboard-column">
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
