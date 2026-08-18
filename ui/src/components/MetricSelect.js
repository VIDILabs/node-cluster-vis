import { Checkbox, List, Input, Tooltip } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import React, { useMemo, useState } from 'react';
import FeatureContributionBarGraph from "./FeatureContributionBarGraph";
import { colorScale } from '../utils/colors.js';

const SPARK_WIDTH = 60;
const SPARK_HEIGHT = 20;

function smoothSeries(series, windowSize = 5, maxPoints = 40) {
  if (!series || series.length === 0) return [];

  const smoothed = series.map((d, i) => {
    const start = Math.max(0, i - windowSize);
    const end = Math.min(series.length, i + windowSize);
    const slice = series.slice(start, end);
    const avg = slice.reduce((a, b) => a + b.value, 0) / slice.length;
    return { timestamp: d.timestamp, value: avg };
  });

  if (smoothed.length > maxPoints) {
    const step = Math.max(1, Math.floor(smoothed.length / maxPoints));
    return smoothed.filter((_, i) => i % step === 0);
  }
  return smoothed;
}

/**
 * Feature-contribution rows are indexed by the *server's* feature ordering, not
 * by whatever order the metric list happens to be in. Looking the name up in
 * `fcs.features` is what keeps each bar attached to the metric it describes.
 */
function contributionsFor(fcs, metric) {
  if (!fcs?.features || !fcs.agg_feat_contrib_mat) return [];
  const rowIndex = fcs.features.indexOf(metric);
  if (rowIndex === -1) return [];
  const row = fcs.agg_feat_contrib_mat[rowIndex];
  if (!row) return [];

  // order_col is a permutation of column indices giving the optimal-leaf order;
  // each column maps to the cluster label at the same position in fcs.clusters.
  return fcs.order_col.map((columnIndex) => ({
    cluster: fcs.clusters?.[columnIndex] ?? columnIndex,
    value: row[columnIndex] ?? 0,
  }));
}

function maxAbsContribution(fcs, metric) {
  const bars = contributionsFor(fcs, metric);
  if (!bars.length) return -Infinity;
  return Math.max(...bars.map((b) => Math.abs(b.value)));
}

function Sparkline({ points, color }) {
  if (!points.length) return <div style={{ height: SPARK_HEIGHT }} />;

  const values = points.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = (max - min) || 1;

  const path = points
    .map((d, i) => {
      const x = points.length === 1 ? 0 : (i / (points.length - 1)) * SPARK_WIDTH;
      const y = SPARK_HEIGHT - ((d.value - min) / span) * SPARK_HEIGHT;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      style={{ border: "1px solid #eee", borderRadius: "2px", background: "#fafafa" }}
    >
      <polyline fill="none" stroke={color} strokeWidth={1.5} points={path} />
    </svg>
  );
}

function MetricSelect({ selectedDims, headerMap, metrics, fcs, avgSeriesData, onMetricSelectChange, hiddenClusters }) {
  const [searchTerm, setSearchTerm] = useState("");

  // Drive the list from the metrics the dataset actually has, rather than from
  // whichever metrics happen to ship display metadata.
  const features = useMemo(
    () => (metrics?.length ? metrics : Object.keys(headerMap || {})),
    [metrics, headerMap]
  );

  const filteredFeatures = useMemo(() => {
    const needle = searchTerm.toLowerCase();
    return features
      .filter((f) => f.toLowerCase().includes(needle))
      .sort((a, b) => maxAbsContribution(fcs, b) - maxAbsContribution(fcs, a));
  }, [features, fcs, searchTerm]);

  // The contribution bars and the sparklines are read as one stack per row, so
  // both drop a hidden cluster or they stop lining up with each other — and
  // with the rest of the dashboard.
  const clusterOf = (columnIndex) => fcs?.clusters?.[columnIndex] ?? columnIndex;
  const clusterOrder = (fcs?.order_col ?? []).filter(
    (columnIndex) => !hiddenClusters?.has(clusterOf(columnIndex))
  );
  const visibleBars = (metric) => contributionsFor(fcs, metric)
    .filter((bar) => !hiddenClusters?.has(bar.cluster));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Input
        placeholder="Search features..."
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        prefix={<SearchOutlined />}
        style={{ marginBottom: 8 }}
      />
      <List
        style={{
          width: "100%",
          maxWidth: 300,
          overflowY: "auto",
          flex: "1 1 auto",
          minHeight: 0,
          // Same floor as MetricView's scroller: never taller than the viewport.
          maxHeight: "calc(100vh - 230px)",
        }}
        bordered
        dataSource={filteredFeatures}
        renderItem={(key) => {
          const headerInfo = headerMap[key] || {};
          const description = headerInfo.desc || "No description available";
          const formalTitle = headerInfo.title || key;
          const clusterSeries = avgSeriesData?.[key] || {};

          return (
            <List.Item key={key} style={{ display: "flex", alignItems: "flex-start", padding: "5px 10px" }}>
              <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
                <Tooltip
                  title={(
                    <div>
                      <strong>{formalTitle}</strong>
                      <br />
                      {description}
                      {headerInfo.units && <div><small>Units: {headerInfo.units}</small></div>}
                    </div>
                  )}
                  placement="top"
                  mouseEnterDelay={0.1}
                >
                  <div style={{ display: 'flex', alignItems: "center" }}>
                    <Checkbox
                      checked={selectedDims.includes(key)}
                      onChange={() => onMetricSelectChange(key)}
                      style={{ marginRight: "10px" }}
                    />
                    <span
                      style={{
                        flexGrow: 1,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        cursor: 'pointer',
                      }}
                      onClick={() => onMetricSelectChange(key)}
                    >
                      {key}
                    </span>
                  </div>
                </Tooltip>

                <div style={{ display: "flex", flexDirection: "row", marginTop: "4px" }}>
                  <FeatureContributionBarGraph
                    graphId={`${key.replace(/\W/g, "_")}-feat-graph`}
                    feature={key}
                    fcData={visibleBars(key)}
                  />
                  <div style={{ display: "flex", flexDirection: "column", marginLeft: "5px", gap: "4px" }}>
                    {clusterOrder.map((columnIndex) => {
                      const cluster = fcs?.clusters?.[columnIndex] ?? columnIndex;
                      return (
                        <Sparkline
                          key={cluster}
                          points={smoothSeries(clusterSeries[cluster], 5, 40)}
                          color={colorScale(cluster)}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            </List.Item>
          );
        }}
      />
    </div>
  );
}

// Memoized on the props that actually drive a redraw. Exported as the default so
// callers get the memoized component rather than the bare one.
export default React.memo(MetricSelect, (prev, next) => (
  prev.fcs === next.fcs
  && prev.selectedDims === next.selectedDims
  && prev.metrics === next.metrics
  && prev.headerMap === next.headerMap
  && prev.avgSeriesData === next.avgSeriesData
  && prev.hiddenClusters === next.hiddenClusters
));
