import { Card, Col, Layout, Row, Select, Typography, Switch, Alert, Spin, Input, Button, Space } from "antd";
import { useMemo, useRef, useCallback, useEffect, useState } from 'react';
import './App.css';
import api from './api.js';
import { FALLBACK_DEFAULTS, STREAM_INTERVAL_MS } from './config.js';
import DRView from './components/DRPlot.js';
import MetricSelect from "./components/MetricSelect.js";
import MetricView from './components/MetricView.js';
import HeatmapView from './components/HeatmapView.js';
import TimelineView from './components/TimelineView.js';

const { Header, Content } = Layout;
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
  const [seriesRows, setSeriesRows] = useState(null);
  const [allMetrics, setAllMetrics] = useState([]);
  const [dataExtent, setDataExtent] = useState([null, null]);
  const [metricData, setMetricData] = useState(null);
  const [avgSeriesData, setAvgSeriesData] = useState({});
  const [zScores, setzScores] = useState(null);
  const [baselines, setBaselines] = useState(null);
  const [headerMap, setHeaderMap] = useState({});
  const [nodeClusterMap, setNodeClusterMap] = useState(new Map());
  const [error, setError] = useState(null);

  const baselinesRef = useRef({});
  const defaultsRef = useRef(FALLBACK_DEFAULTS);

  const [streamingMode, setStreamingMode] = useState(false);
  const [streamStatus, setStreamStatus] = useState(null);

  const totalNodes = DRTData?.length || 0;
  const totalMeasures = allMetrics.length;

  // --- derived views ------------------------------------------------------

  // Group the flat rows the API returns into one array per metric, which is the
  // shape the line charts consume.
  const buildMetricData = useCallback((rows, dims, nodes) => {
    const nodeFilter = nodes && nodes.length ? new Set(nodes) : null;
    const grouped = {};
    dims.forEach((dim) => { grouped[dim] = []; });

    rows.forEach((row) => {
      if (nodeFilter && !nodeFilter.has(row.nodeId)) return;
      const timestamp = new Date(row.timestamp);
      dims.forEach((dim) => {
        if (row[dim] === undefined) return;
        grouped[dim].push({ timestamp, nodeId: row.nodeId, value: row[dim] });
      });
    });
    return grouped;
  }, []);

  const timelineData = useMemo(() => {
    if (!seriesRows?.length || !nodeClusterMap.size) return [];

    // Contiguous runs where every selected metric read zero, per cluster.
    const byCluster = new Map();
    seriesRows.forEach((row) => {
      const cluster = nodeClusterMap.get(row.nodeId);
      if (cluster == null) return;
      if (!byCluster.has(cluster)) byCluster.set(cluster, []);
      byCluster.get(cluster).push(row);
    });

    const segments = [];
    byCluster.forEach((rows, cluster) => {
      rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      let start = null;
      let previous = null;

      rows.forEach((row) => {
        if (row.downtime === 1) {
          const stamp = new Date(row.timestamp);
          if (!start) start = stamp;
          previous = stamp;
        } else if (start) {
          segments.push({ cluster, start, end: previous || start });
          start = null;
          previous = null;
        }
      });

      if (start) {
        segments.push({ cluster, start, end: previous || start });
      }
    });
    return segments;
  }, [seriesRows, nodeClusterMap]);

  // --- data loading -------------------------------------------------------

  const applyDrPayload = useCallback((payload) => {
    setDRTData(payload.dr_features);
    setFCs(payload.feat_contributions);
    setNodeClusterMap(new Map(payload.node_cluster_map.map((d) => [d.nodeId, d.Cluster])));
  }, []);

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
    defaultsRef.current = defaults;

    setActiveDataset(description);
    setSelectedPoints(defaults.selectedPoints);
    setSelectedDims(defaults.selectedDims);
    setBStart(defaults.bStart);
    setBEnd(defaults.bEnd);
    setNNeighbors(defaults.nNeighbors);
    setMinDist(defaults.minDist);
    setNumClusters(defaults.numClusters);
    setDataExtent([description.start, description.end]);

    const [headers, seriesPayload, drPayload] = await Promise.all([
      api.metadata(),
      api.series(defaults.selectedDims),
      api.dr({
        nNeighbors: defaults.nNeighbors,
        minDist: defaults.minDist,
        numClusters: defaults.numClusters,
      }),
    ]);

    setHeaderMap(headers);
    setSeriesRows(seriesPayload.data);
    setAllMetrics(seriesPayload.allMetrics);
    setMetricData(buildMetricData(
      seriesPayload.data, defaults.selectedDims, defaults.selectedPoints
    ));
    applyDrPayload(drPayload);

    await Promise.all([
      fetchMrdmd(defaults.selectedPoints, defaults.selectedDims),
      refreshClusterAverages(defaults.selectedDims),
    ]);
  }, [applyDrPayload, buildMetricData, fetchMrdmd, refreshClusterAverages]);

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
    const defaults = defaultsRef.current;
    const params = useDefaults
      ? {
          numClusters: defaults.numClusters,
          nNeighbors: defaults.nNeighbors,
          minDist: defaults.minDist,
        }
      : { numClusters: k, nNeighbors: neighbors, minDist: dist };

    setNumClusters(params.numClusters);
    setNNeighbors(params.nNeighbors);
    setMinDist(params.minDist);

    try {
      // Changing k alone reuses the cached embedding; changing UMAP parameters
      // requires the full pass.
      const changedEmbedding = params.nNeighbors !== nNeighbors || params.minDist !== minDist;
      const payload = changedEmbedding
        ? await api.dr({ ...params, force: true })
        : await api.clusters({ ...params, force });

      applyDrPayload(payload);
      await refreshClusterAverages(selectedDims);
      setError(null);
    } catch (err) {
      console.error(err);
      setError(`Could not recompute clusters: ${err.message}`);
    }
  }, [applyDrPayload, minDist, nNeighbors, refreshClusterAverages, selectedDims]);

  const handleMetricSelectChange = useCallback(async (key) => {
    const isRemoving = selectedDims.includes(key);
    const nextDims = isRemoving
      ? selectedDims.filter((dim) => dim !== key)
      : [key, ...selectedDims];

    setSelectedDims(nextDims);

    if (isRemoving) {
      setMetricData((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setzScores((prev) => (prev || []).map(({ [key]: _removed, ...rest }) => rest));
      refreshClusterAverages(nextDims);
      return;
    }

    try {
      // Fetch only the newly selected metric, then merge it into what we hold.
      const payload = await api.series([key], undefined);
      setSeriesRows((prev) => mergeSeriesRows(prev, payload.data, key));
      setMetricData((prev) => ({
        ...prev,
        ...buildMetricData(payload.data, [key], selectedPoints),
      }));

      const dmd = await api.mrdmd({
        nodes: selectedPoints, metrics: [key], recomputeBase: true,
      });
      setzScores((prev) => mergeZScores(prev || [], dmd.zscores, key));
      setBaselines((prev) => [...dmd.baselines, ...(prev || [])]);
      dmd.baselines.forEach((baseline) => {
        baselinesRef.current[baseline.feature] = {
          baselineX: [new Date(baseline.b_start), new Date(baseline.b_end)],
          baselineY: [baseline.v_min, baseline.v_max],
        };
      });
      refreshClusterAverages(nextDims);
    } catch (err) {
      console.error(err);
      setError(`Could not load metric "${key}": ${err.message}`);
    }
  }, [buildMetricData, refreshClusterAverages, selectedDims, selectedPoints]);

  const updateSelectedNodes = useCallback(async (selectedNodeIds) => {
    setSelectedPoints(selectedNodeIds);
    if (!seriesRows) return;
    setMetricData(buildMetricData(seriesRows, selectedDims, selectedNodeIds));

    if (!selectedNodeIds.length) return;
    try {
      await fetchMrdmd(selectedNodeIds, selectedDims);
    } catch (err) {
      console.error(err);
      setError(`Could not recompute deviations: ${err.message}`);
    }
  }, [buildMetricData, fetchMrdmd, selectedDims, seriesRows]);

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

        setSeriesRows(payload.data);
        setMetricData(buildMetricData(payload.data, selectedDims, selectedPoints));
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
                <Text strong italic style={{ fontSize: "16px" }}>Nodes: {totalNodes}</Text>
              </Col>
              <Col>
                <Text strong italic style={{ fontSize: "16px" }}>Metrics: {totalMeasures}</Text>
              </Col>
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
            <Col span={14}>
              {hasDr && seriesRows ? (
                <TimelineView
                  bStart={bStart}
                  bEnd={bEnd}
                  data={timelineData}
                  nodeDataStart={dataExtent[0]}
                  nodeDataEnd={dataExtent[1]}
                  nodeClusterMap={nodeClusterMap}
                />
              ) : (
                <Placeholder height="30vh" message="No timeline data yet" />
              )}

              {hasSeries ? (
                <Card title="METRIC READING VIEW" size="small" style={{ height: "auto" }}>
                  <Row gutter={[16, 16]}>
                    <Col span={8}>
                      <MetricSelect
                        selectedDims={selectedDims}
                        headerMap={headerMap}
                        metrics={allMetrics}
                        fcs={FCs}
                        avgSeriesData={avgSeriesData}
                        onMetricSelectChange={handleMetricSelectChange}
                      />
                    </Col>
                    <Col span={16}>
                      <MetricView
                        data={metricData}
                        timeRange={[new Date(bStart), new Date(bEnd)]}
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
                      />
                    </Col>
                  </Row>
                </Card>
              ) : (
                <Placeholder height="60vh" message="No metric data yet" />
              )}
            </Col>

            <Col span={10}>
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
                />
              ) : (
                <Placeholder height="40vh" message="No embedding yet" />
              )}

              {zScores?.length ? (
                <HeatmapView data={zScores} nodeClusterMap={nodeClusterMap} />
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

// Merge a newly fetched metric column into the rows we already hold, keyed on
// (node, timestamp) so the timeline stays aligned.
function mergeSeriesRows(previous, incoming, key) {
  if (!previous) return incoming;
  const lookup = new Map(incoming.map((row) => [`${row.nodeId}|${row.timestamp}`, row[key]]));
  return previous.map((row) => {
    const value = lookup.get(`${row.nodeId}|${row.timestamp}`);
    return value === undefined ? row : { ...row, [key]: value };
  });
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
