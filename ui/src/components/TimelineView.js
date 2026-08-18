import { Card } from "antd";
import * as d3 from 'd3';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colorScale } from '../utils/colors.js';

// Fixed chart insets; these never varied at runtime.
const MARGIN = { top: 5, right: 10, bottom: 20, left: 50 };
// Each cluster is one group of two bands: coverage, and a deliberately thinner
// gap band under it. The gap band is a qualifier on the row above rather than a
// peer of it, so it carries less weight and only one label serves both.
const COVERAGE_HEIGHT = 20;
const GAP_HEIGHT = 7;
const BAND_GAP = 1;      // between a cluster's two bands
const GROUP_GAP = 7;     // between one cluster and the next
const GROUP_HEIGHT = COVERAGE_HEIGHT + BAND_GAP + GAP_HEIGHT + GROUP_GAP;
const MIN_HEIGHT = 100;
const GAP_COLOR = '#B03A2E';

/**
 * When each cluster's nodes were reporting, and when their readings were blank.
 *
 * The original version drew "downtime", defined as every selected metric reading
 * exactly zero. That almost never happens: a node that goes away stops emitting
 * rows entirely rather than emitting zeroes, so the view was reliably empty. The
 * server now buckets *presence* against a regular time grid, and each coverage
 * cell is shaded by how much of the cluster reported in that bucket. A bucket
 * nothing reported in is left blank — white, not a grey ground.
 *
 * Under each coverage band is a thinner gap band with the encoding inverted:
 * ink is blank readings, counted per (node, metric, timestamp) cell that is
 * null, NaN, or exactly 0.0 — which is what a NaN looks like once the upstream
 * export has filled it in. Counting per reading rather than per row is what
 * makes a metric collapsing to zero across a cluster visible; the row rule
 * needed every metric blank at once and so found nothing.
 */
const TimelineView = ({ coverage, windowStart, windowEnd, nodeDataStart, nodeDataEnd, hiddenClusters }) => {
    const svgContainerRef = useRef();
    const [brushStart, setBrushStart] = useState(() => new Date(windowStart));
    const [brushEnd, setBrushEnd] = useState(() => new Date(windowEnd));

    // The window is derived from the dataset, so a swap has to move the brush.
    // Seeded once from the initial props, it kept the previous dataset's range.
    useEffect(() => {
      setBrushStart(new Date(windowStart));
      setBrushEnd(new Date(windowEnd));
    }, [windowStart, windowEnd]);

    // A hidden cluster loses its band pair here too, so the strip agrees with
    // the heatmap and the charts about which groups are on screen. The rows are
    // laid out from this list, so the panel also gives the height back.
    const rows = useMemo(() => {
      const all = coverage?.clusters || [];
      return hiddenClusters?.size ? all.filter(r => !hiddenClusters.has(r.cluster)) : all;
    }, [coverage, hiddenClusters]);

    const height = Math.max(
      rows.length * GROUP_HEIGHT + MARGIN.top + MARGIN.bottom,
      MIN_HEIGHT
    );

    const drawChart = useCallback(() => {
      const container = svgContainerRef.current;
      if (!container) return;
      d3.select(container).selectAll("*").remove();

      const width = container.clientWidth;
      const clusters = rows;
      const times = (coverage?.times || []).map(t => new Date(t));

      const svg = d3.select(container)
                .append("svg")
                .attr('id', `context-window`)
                .attr('class', 'context')
                .attr("width", "100%")
                .attr("height", "100%")
                .attr("viewBox", `0 0 ${width} ${height}`)
                .attr("preserveAspectRatio", "xMidYMid meet");

      // One cell covers the bucket that *starts* at its timestamp, so the strip
      // is one bucket wider than the span of the timestamps themselves. Ending
      // the domain at the last timestamp drew that final cell entirely to the
      // right of the axis; the domain therefore runs to the end of the last
      // bucket, and every cell lands inside the plot.
      const binMs = (coverage?.binSeconds || 60) * 1000;
      const lastTime = times.length ? +times[times.length - 1] : +new Date(nodeDataEnd);
      const plotRight = width - MARGIN.right;

      const xScale = d3
        .scaleTime()
        .domain([
          new Date(nodeDataStart),
          new Date(Math.max(+new Date(nodeDataEnd), lastTime + binMs)),
        ])
        // Was `width - MARGIN.right - MARGIN.left`, which subtracted the left
        // gutter a second time and stopped the axis 50px short of the panel.
        .range([MARGIN.left, plotRight]);

      // Laid out by hand rather than with a band scale: the two bands in a
      // group are deliberately different heights, which a band scale cannot do.
      const layout = new Map();
      clusters.forEach((row, index) => {
        const top = MARGIN.top + index * GROUP_HEIGHT;
        layout.set(row.cluster, {
          coverageY: top,
          gapY: top + COVERAGE_HEIGHT + BAND_GAP,
        });
      });

      svg.append("g")
        .attr('class', 'x-axis')
        .attr("transform", `translate(0,${height - MARGIN.bottom})`)
        .call(d3.axisBottom(xScale).tickFormat(d3.timeFormat("%H:%M")))
        .selectAll("text")
          .style("font-size", "12px");

      // One label per cluster, centred across both of its bands. The gap band
      // is not labelled separately — it belongs to the row above it.
      const yAxisGroup = svg.append("g").attr('class', 'y-axis');
      clusters.forEach((row) => {
        const { coverageY } = layout.get(row.cluster);
        yAxisGroup.append("text")
          .attr("class", "row-label")
          .attr("x", MARGIN.left - 8)
          .attr("y", coverageY + (COVERAGE_HEIGHT + BAND_GAP + GAP_HEIGHT) / 2)
          .attr("dy", "0.32em")
          .attr("text-anchor", "end")
          .style("fill", colorScale(row.cluster))
          .style('font-weight', 'bold')
          .style("font-size", "12px")
          .text(`c${row.cluster}`);
      });

      svg.append("text")
        .attr("transform", `rotate(-90)`)
        .attr("x", -height / 2)
        .attr("y", 10)
        .attr("fill", "black")
        .attr("text-anchor", "middle")
        .style("font-size", "14px")
        .text("Cluster");

      // One cell per (cluster, time bucket). Cell width comes from the bucket
      // spacing rather than a fixed number, so the strip stays gap-free at any
      // bin count the server hands back.
      const cellWidth = times.length > 1
        ? Math.max(xScale(times[1]) - xScale(times[0]), 1)
        : Math.max(xScale(new Date(+times[0] + binMs)) - xScale(times[0]), 1);

      // Belt and braces against rounding: nothing is drawn past the axis end.
      const cellFrom = (time) => Math.max(Math.min(cellWidth, plotRight - xScale(time)), 0);

      clusters.forEach((row) => {
        const { coverageY, gapY } = layout.get(row.cluster);

        const cells = row.active.map((active, index) => ({
          index, active, time: times[index],
        })).filter(d => d.time);

        svg.append("g")
          .attr("class", `coverage-c${row.cluster}`)
          .selectAll(".coverage-cell")
          .data(cells.filter(d => d.active > 0))
          .join("rect")
          .attr("class", "coverage-cell")
          .attr("x", d => xScale(d.time))
          .attr("y", coverageY)
          .attr("width", d => cellFrom(d.time))
          .attr("height", COVERAGE_HEIGHT)
          .attr("fill", colorScale(row.cluster))
          // Opacity carries the share of the cluster that reported, so a partial
          // outage is distinguishable from a full one at a glance.
          .attr("opacity", d => 0.25 + 0.75 * (d.active / Math.max(row.nodeCount, 1)))
          .append("title")
          .text(d => `c${row.cluster} · ${d3.timeFormat("%H:%M")(d.time)} · `
            + `${d.active}/${row.nodeCount} nodes reporting`);

        if (!row.blank?.length) return;

        svg.append("g")
          .attr("class", `gap-c${row.cluster}`)
          .selectAll(".gap-cell")
          .data(row.blank
            .map((blank, index) => ({
              blank,
              readings: row.readings?.[index] || 0,
              time: times[index],
            }))
            .filter(d => d.time && d.blank > 0 && d.readings > 0))
          .join("rect")
          .attr("class", "gap-cell")
          .attr("x", d => xScale(d.time))
          .attr("y", gapY)
          .attr("width", d => cellFrom(d.time))
          .attr("height", GAP_HEIGHT)
          .attr("fill", GAP_COLOR)
          .attr("opacity", d => 0.15 + 0.85 * (d.blank / d.readings))
          .append("title")
          .text(d => `c${row.cluster} · ${d3.timeFormat("%H:%M")(d.time)} · `
            + `${d.blank}/${d.readings} readings missing`);
      });

      // adding brush
      const defaultWindow = [xScale(brushStart), xScale(brushEnd)];
      const earliestNodeDataTime = xScale(new Date(nodeDataStart)) || 0;

      const brush = d3.brushX(xScale)
        .extent([
          [Math.max(MARGIN.left, earliestNodeDataTime), MARGIN.top],
          // Flush with the axis end, so the last bucket can be brushed.
          [plotRight, height - MARGIN.bottom - 1]
        ])
        .on('end', (event) => {
            // Only a brush the user dragged. `brush.move` emits 'end' too, and
            // the initial move below feeding its own position back into state
            // re-ran the draw, which moved the brush again — an unbounded
            // redraw loop that React eventually flagged as a nested update.
            // `sourceEvent` is null for programmatic moves, which is the
            // distinction d3 provides for exactly this.
            if (!event.sourceEvent || !event.selection) return;

            const [start, end] = event.selection.map(xScale.invert);
            setBrushStart(start);
            setBrushEnd(end);
            window.dispatchEvent(
              new CustomEvent('time-domain-updated', { detail: [start, end] })
            );
        });

        svg.append('g')
          .attr('class', 'x-brush')
          .call(brush)
          .call(brush.move, defaultWindow);
    }, [brushStart, brushEnd, nodeDataStart, nodeDataEnd, coverage, rows, height]);

    useEffect(() => {
      if (!svgContainerRef.current || !nodeDataStart || !nodeDataEnd) return;
      drawChart();
    }, [drawChart, nodeDataStart, nodeDataEnd]);

    return  (
        <Card title="TIME DOMAIN VIEW" size="small" style={{ height: 'auto', width: '100%' }}>
           <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: '12px',
              marginBottom: '8px',
              marginRight: '10px'
            }}>
              <LegendSwatch color="#666" opacity={0.35} label="Some reporting" />
              <LegendSwatch color="#666" opacity={1} label="All reporting" />
              <LegendSwatch color={GAP_COLOR} opacity={0.85} label="Missing" />
            </div>
            <div ref={svgContainerRef} style={{ width: '100%', height: `${height}px` }}></div>
        </Card>
    );
  };

const LegendSwatch = ({ color, opacity, label }) => (
  <span style={{ display: 'flex', alignItems: 'center' }}>
    <span style={{
      width: '12px',
      height: '12px',
      backgroundColor: color,
      opacity,
      marginRight: '6px',
      borderRadius: '2px'
    }} />
    <span style={{ fontSize: '13px' }}>{label}</span>
  </span>
);

export default TimelineView;
