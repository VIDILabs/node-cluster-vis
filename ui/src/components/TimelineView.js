import { Card } from "antd";
import * as d3 from 'd3';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colorScale } from '../utils/colors.js';

// Fixed chart insets; these never varied at runtime.
const MARGIN = { top: 5, right: 10, bottom: 20, left: 50 };
// Both bands in a group are the same height — the height the gap band already
// had. Neither is the headline the old full-height coverage band was; they are
// two qualifiers on one cluster, read together.
export const ROW_HEIGHT = 7;
const BAND_GAP = 1;      // between the bands of one cluster
const GROUP_GAP = 7;     // between one cluster and the next
const ROWS_PER_GROUP = 2;
const GROUP_HEIGHT =
  ROWS_PER_GROUP * ROW_HEIGHT + (ROWS_PER_GROUP - 1) * BAND_GAP + GROUP_GAP;
const MIN_HEIGHT = 100;
const GAP_COLOR = '#B03A2E';

/**
 * Two things per cluster, over the same time axis.
 *
 * **In baseline** is how many of the cluster's *reporting* nodes were behaving
 * within that baseline — value-wise, not time-wise: a node counts when every
 * real reading it produced in the bucket falls inside its metric's baseline
 * value band. Darker is more. The denominator is the nodes actually running in
 * that bucket, not the cluster's full membership, so an outage lightens the row
 * only for the nodes that remain.
 *
 * **Missing** inverts the encoding: ink is blank readings, counted per
 * (node, metric, timestamp) cell that is null, NaN, or exactly 0.0 — which is
 * what a NaN looks like once the upstream export has filled it in. Counting per
 * reading rather than per row is what makes a metric collapsing to zero across
 * a cluster visible; the row rule needed every metric blank at once and so
 * found nothing.
 *
 * A bucket nothing reported in is left blank — white, not a grey ground — which
 * reads as "nothing here" rather than as a value. That is also what separates
 * "no node was in baseline" (the lightest ink) from "no node was running at
 * all" (no ink).
 *
 * This replaced a full-height coverage band that shaded how much of the cluster
 * reported. Presence is still what the in-baseline row is scored against, so
 * nothing was lost from the model — only the row that restated it.
 *
 * A third band drawing the baseline *window* along the time axis was tried and
 * removed. The window is per metric, and the union across a full selection
 * covers almost the whole range — on the bundled sample `proc_run`'s window
 * alone runs 00:33 to 18:22 — so it drew as a flat bar edge to edge and carried
 * no information. Don't reintroduce it without scoping it to a single metric.
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

    // A hidden cluster loses its bands here too, so the strip agrees with the
    // heatmap and the charts about which groups are on screen. The rows are
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

      // Laid out by hand rather than with a band scale: the bands are a fixed
      // pixel height with fixed gutters, and a band scale would rescale them
      // with the cluster count.
      const layout = new Map();
      clusters.forEach((row, index) => {
        const top = MARGIN.top + index * GROUP_HEIGHT;
        layout.set(row.cluster, {
          top,
          inBaseY: top,
          gapY: top + ROW_HEIGHT + BAND_GAP,
        });
      });
      const groupInk = ROWS_PER_GROUP * ROW_HEIGHT + (ROWS_PER_GROUP - 1) * BAND_GAP;

      svg.append("g")
        .attr('class', 'x-axis')
        .attr("transform", `translate(0,${height - MARGIN.bottom})`)
        .call(d3.axisBottom(xScale).tickFormat(d3.timeFormat("%H:%M")))
        .selectAll("text")
          .style("font-size", "12px");

      // One label per cluster, centred across both of its bands. The bands are
      // not labelled separately — they are one reading, not two.
      const yAxisGroup = svg.append("g").attr('class', 'y-axis');
      clusters.forEach((row) => {
        const { top } = layout.get(row.cluster);
        yAxisGroup.append("text")
          .attr("class", "row-label")
          .attr("x", MARGIN.left - 8)
          .attr("y", top + groupInk / 2)
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
      const stamp = d3.timeFormat("%H:%M");

      clusters.forEach((row) => {
        const { inBaseY, gapY } = layout.get(row.cluster);

        const cells = row.active.map((active, index) => ({
          index,
          active,
          inBaseline: row.inBaseline?.[index] || 0,
          time: times[index],
        })).filter(d => d.time);

        svg.append("g")
          .attr("class", `inbase-c${row.cluster}`)
          .selectAll(".inbase-cell")
          // A bucket with nothing running is left blank rather than drawn at
          // the lightest shade: "none of nobody" is not a reading.
          .data(cells.filter(d => d.active > 0))
          .join("rect")
          .attr("class", "inbase-cell")
          .attr("x", d => xScale(d.time))
          .attr("y", inBaseY)
          .attr("width", d => cellFrom(d.time))
          .attr("height", ROW_HEIGHT)
          .attr("fill", colorScale(row.cluster))
          .attr("opacity", d => 0.15 + 0.85 * (d.inBaseline / d.active))
          .append("title")
          .text(d => `c${row.cluster} · ${stamp(d.time)} · `
            + `${d.inBaseline}/${d.active} reporting nodes within baseline`);

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
          .attr("height", ROW_HEIGHT)
          .attr("fill", GAP_COLOR)
          .attr("opacity", d => 0.15 + 0.85 * (d.blank / d.readings))
          .append("title")
          .text(d => `c${row.cluster} · ${stamp(d.time)} · `
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
              <LegendSwatch color="#666" opacity={0.3} label="Few in baseline" />
              <LegendSwatch color="#666" opacity={1} label="Most in baseline" />
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
