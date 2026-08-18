import * as d3 from 'd3';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { colorScale } from '../utils/colors.js';
import { lineClass } from '../utils/nodes.js';
import { CHART_FONT, OPACITY } from '../config.js';

// The chart draws at the container's real pixel width — no viewBox scaling — so
// a 12px label is 12px on screen. Previously a fixed 800x300 viewBox was letter-
// boxed into a 190px-tall box, which both shrank every font by ~0.6x and left
// the plot floating in the middle of the panel instead of spanning it.
export const HEIGHT = 190;
const DEFAULT_WIDTH = 800;   // used before the first measurement, and in jsdom
const MIN_WIDTH = 260;
// Gutters are sized to CHART_FONT and to the tick format below, and have to be
// re-checked if either changes. The left one holds a tick label of the form
// `-1.0e-2` at TICK_SIZE + TICK_PADDING from the axis.
export const MARGIN = { top: 30, right: 24, bottom: 38, left: 42 };
const TICK_SIZE = 4;
const TICK_PADDING = 2;

// One fixed form for every y tick on every chart. Telemetry mixes byte counters
// in the millions with utilisation fractions below one; printed plainly those
// are `12000000` and `0.2`, so the magnitude has to be read by counting zeros
// and each chart claims a different amount of gutter. Mantissa-plus-exponent
// states the magnitude outright and keeps every chart's gutter the same width.
// Rendered in a monospace face so the digits line up as well as the labels do.
const TICK_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// Plot furniture, in the manner of a seaborn grid: a light rule at every
// labelled tick and a hairline frame around the plot area. Both sit far below
// the cluster colours in contrast, so they read as structure and never compete
// with a polyline. The frame is the only spine — the axes' own domain paths are
// removed, or the left and bottom edges get drawn twice at different weights.
const GRID_COLOR = '#e9e9e9';
const FRAME_COLOR = '#d6d6d6';

export function formatTick(value) {
    if (!Number.isFinite(value) || value === 0) return '0';
    const exponent = Math.floor(Math.log10(Math.abs(value)));
    const mantissa = value / Math.pow(10, exponent);
    return `${mantissa.toFixed(1)}e${exponent}`;
}

const LineChart = ({ data, field, baselinesRef, selectedTimeRange, updateBaseline, nodeClusterMap, metadata, registerChart, showBaselines, selectedPoints, hiddenClusters }) => {
    const svgContainerRef = useRef();

    const xScaleRef = useRef();
    const yScaleRef = useRef();
    const brushGroupRef = useRef();

    const isUserBrush = useRef(false);

    // Track the panel width so the plot fills it. jsdom reports 0, hence the
    // fallback rather than a bare clientWidth.
    const [width, setWidth] = useState(DEFAULT_WIDTH);
    useEffect(() => {
        const node = svgContainerRef.current;
        if (!node) return undefined;
        const measure = () => setWidth(Math.max(node.clientWidth || DEFAULT_WIDTH, MIN_WIDTH));
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    // Position the baseline rectangle from the current baseline. Declared before
    // the draw effect so the effect can depend on it without a TDZ error.
    const updateBox = useCallback(() => {
        const baseline = baselinesRef.current[field];
        if (!baseline || !brushGroupRef.current || !xScaleRef.current) return;

        const x0 = xScaleRef.current(new Date(baseline.baselineX[0]));
        const x1 = xScaleRef.current(new Date(baseline.baselineX[1]));
        const yTop = yScaleRef.current(baseline.baselineY[1]);
        const yBottom = yScaleRef.current(baseline.baselineY[0]);

        // Read the plot bounds off the scale rather than a module constant, so
        // this stays correct as the panel resizes.
        const [rMin, rMax] = xScaleRef.current.range();
        const isVisible = x1 >= rMin && x0 <= rMax;

        isUserBrush.current = true;
        if (isVisible) {
            brushGroupRef.current.call(brushGroupRef.current.brush.move, [[x0, yTop], [x1, yBottom]]);
        } else {
            brushGroupRef.current.call(brushGroupRef.current.brush.move, null);
        }
    }, [baselinesRef, field]);

    // Applied outright, never through a transition. d3-brush's `move` calls
    // `interrupt()` on the group, and `updateBox` runs `move` at the end of
    // every draw — so a fading toggle was cancelled mid-flight and the switch
    // appeared to do nothing. Also re-applied on every draw, so a redraw
    // cannot bring a hidden brush back.
    const applyBaselineVisibility = useCallback(() => {
        if (!brushGroupRef.current) return;
        brushGroupRef.current
            .style("opacity", showBaselines ? 1 : 0)
            .style("pointer-events", showBaselines ? "all" : "none");
    }, [showBaselines]);

    useEffect(() => {
      if (!svgContainerRef.current || !data) return;

      const svg = d3.select(svgContainerRef.current).select("svg").empty()
        ? d3.select(svgContainerRef.current).append("svg")
        : d3.select(svgContainerRef.current).select("svg");

      svg.attr('id', `context-window`)
        .attr('class', 'context')
        .attr("width", "100%")
        .attr("height", HEIGHT)
        .attr("viewBox", `0 0 ${width} ${HEIGHT}`)
        // The viewBox tracks the measured width, so this is a 1:1 mapping; it is
        // only here to keep the drawing sane during the frame between a resize
        // and the observer firing.
        .attr("preserveAspectRatio", "xMidYMid meet");

      // Created before anything else so they paint underneath the data: SVG has
      // no z-index, only document order.
      if (svg.select(".grid-x").empty()) {
        svg.append("g").attr("class", "grid grid-x");
        svg.append("g").attr("class", "grid grid-y");
        svg.append("rect").attr("class", "plot-frame");
      }

      const xScale = d3.scaleTime().domain(selectedTimeRange).range([MARGIN.left, width - MARGIN.right]);

      // Anchor at zero only when the data is non-negative. Metrics that legitimately
      // go negative (temperature deltas, signed counters) were previously clipped
      // to the axis floor and drew as a flat line along the bottom.
      const [dataMin, dataMax] = d3.extent(data, d => d.value);
      const yMin = Number.isFinite(dataMin) ? Math.min(0, dataMin) : 0;
      const yMax = Number.isFinite(dataMax) && dataMax > yMin ? dataMax : yMin + 1;

      // Every metric shares a linear axis. A per-metric scale choice made two
      // charts sitting side by side incomparable, and a compressed axis is easy
      // to misread as a small excursion.
      const yScale = d3.scaleLinear()
        .domain([yMin, yMax])
        .range([HEIGHT - MARGIN.bottom, MARGIN.top])
        .nice();

      xScaleRef.current = xScale;
      yScaleRef.current = yScale;

      // Create the axis groups once, but re-call them on every render — the
      // previous "only if empty" guard meant the y-axis kept the domain it was
      // first drawn with while the lines moved underneath it.
      if (svg.select(".x-axis").empty()) {
        svg.append("g").attr("class", "x-axis");
      }
      if (svg.select(".y-axis").empty()) {
        svg.append("g").attr("class", "y-axis");
      }

      svg.select(".x-axis")
        .attr("transform", `translate(0, ${HEIGHT - MARGIN.bottom})`)
        .call(d3.axisBottom(xScale).ticks(6).tickFormat(d3.timeFormat("%H:%M")))
        // The frame below draws the spine; the axis's own domain path would lay
        // a second line directly on top of it.
        .call(g => g.select(".domain").remove())
        .call(g => g.selectAll(".tick line").style("stroke", FRAME_COLOR))
        .selectAll("text")
        .style("font-size", `${CHART_FONT.axis}px`);

      svg.select(".y-axis")
        .attr("transform", `translate(${MARGIN.left}, 0)`)
        .call(d3.axisLeft(yScale)
          .ticks(5)
          .tickFormat(formatTick)
          .tickSize(TICK_SIZE)
          .tickPadding(TICK_PADDING))
        .call(g => g.select(".domain").remove())
        .call(g => g.selectAll(".tick line").style("stroke", FRAME_COLOR))
        .selectAll("text")
        .style("font-size", `${CHART_FONT.axis}px`)
        .style("font-family", TICK_FONT);

      const plotWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
      const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

      // The grids re-use the same tick counts as the axes above, so every rule
      // lands on a labelled tick rather than near one.
      svg.select(".grid-y")
        .attr("transform", `translate(${MARGIN.left}, 0)`)
        .call(d3.axisLeft(yScale).ticks(5).tickSize(-plotWidth).tickFormat(""))
        .call(g => g.select(".domain").remove())
        .call(g => g.selectAll(".tick line")
          .style("stroke", GRID_COLOR)
          .style("shape-rendering", "crispEdges"));

      svg.select(".grid-x")
        .attr("transform", `translate(0, ${HEIGHT - MARGIN.bottom})`)
        .call(d3.axisBottom(xScale).ticks(6).tickSize(-plotHeight).tickFormat(""))
        .call(g => g.select(".domain").remove())
        .call(g => g.selectAll(".tick line")
          .style("stroke", GRID_COLOR)
          .style("shape-rendering", "crispEdges"));

      svg.select(".plot-frame")
        .attr("x", MARGIN.left)
        .attr("y", MARGIN.top)
        .attr("width", plotWidth)
        .attr("height", plotHeight)
        .style("fill", "none")
        .style("stroke", FRAME_COLOR)
        .style("stroke-width", 1)
        .style("shape-rendering", "crispEdges");

      const line = d3.line().x(d => xScale(new Date(d.timestamp))).y(d => yScale(d.value));
      // Hiding a cluster drops its lines outright, the same as it drops the
      // heatmap's columns. That is an explicit request for them to go, unlike a
      // lasso selection, which is drawn rather than filtered.
      const visible = hiddenClusters?.size
        ? data.filter(d => !hiddenClusters.has(nodeClusterMap.get(d.nodeId)))
        : data;
      const grouped = d3.group(visible, d => d.nodeId);

      const clipId = `clip-${field.replace(/\s+/g, '-')}`; // Unique ID per chart
      if (svg.select("defs").empty()) {
        svg.append("defs").append("clipPath")
          .attr("id", clipId)
          .append("rect");
      }
      // Re-sized on every pass: the clip was created once at a fixed width, so
      // after a resize it cropped the lines short of the axis.
      svg.select("defs clipPath rect")
        .attr("x", MARGIN.left)
        .attr("y", MARGIN.top)
        .attr("width", Math.max(width - MARGIN.left - MARGIN.right, 0))
        .attr("height", HEIGHT - MARGIN.top - MARGIN.bottom);

      if (svg.select(".lines").empty()) {
        svg.append("g")
          .attr("class", "lines")
          .attr("clip-path", `url(#${clipId})`); 
      }
      
      // Every node is drawn; selection is carried by opacity rather than by
      // dropping lines, so a lasso keeps its surrounding context visible.
      const restOpacity = (nodeId) => (
        !selectedPoints?.length || selectedPoints.includes(nodeId)
          ? OPACITY.selected
          : OPACITY.muted
      );

      svg.select(".lines").selectAll(".line").data(Array.from(grouped), d => d[0])
          .join("path")
          .attr("class", d => `line ${lineClass(d[0])}`)
          // MetricView recolors lines by reading this attribute, so it has to
          // carry the raw id even though the class is the sanitized token.
          .attr("nodeId", d => d[0])
          .attr("fill", "none")
          .style("stroke", d => colorScale(nodeClusterMap.get(d[0])))
          // Hover handlers in the scatter plot and the heatmap fade every other
          // line, then have to put it back. They read this attribute rather than
          // assuming a single resting value, which used to un-dim whatever was
          // last hovered.
          .attr("data-rest-opacity", d => restOpacity(d[0]))
          .style("opacity", d => restOpacity(d[0]))
          .attr("d", d => line(d[1]));

      svg.selectAll(".chart-title").data([field]).join("text")
        .attr("class", "chart-title")
        .attr("x", width / 2)
        .attr("y", 20)
        .attr("text-anchor", "middle")
        .style("font-size", `${CHART_FONT.title}px`)
        .style("font-weight", "bold")
        .text(d => d);

      // Y-Axis unit label, sitting above the axis it describes.
      svg.selectAll(".y-label").data([metadata?.units || "Value"]).join("text")
          .attr("class", "y-label")
          .attr("y", 20)
          .attr("x", 4)
          .attr("text-anchor", "start")
          .style("font-size", `${CHART_FONT.label}px`)
          .text(d => d);
      
      if (svg.select(".brush-group").empty()) {
        const brush = d3.brush()
            .on("end", (event) => {
                if (isUserBrush.current || !event.selection) {
                    isUserBrush.current = false;
                    return;
                }
                const [[x0, y0], [x1, y1]] = event.selection;
                const newBaseline = {
                    baselineX: [xScaleRef.current.invert(x0), xScaleRef.current.invert(x1)],
                    baselineY: [yScaleRef.current.invert(y1), yScaleRef.current.invert(y0)]
                };
                updateBaseline(field, newBaseline);
            });

        brushGroupRef.current = svg.append("g")
                                  .attr("class", "brush-group")
                                  .attr("clip-path", `url(#${clipId})`);

        brushGroupRef.current.brush = brush; 
      }

      // The brushable area has to follow the plot width, so it is set here
      // rather than at creation time.
      brushGroupRef.current.brush.extent([
        [MARGIN.left, MARGIN.top],
        [Math.max(width - MARGIN.right, MARGIN.left + 1), HEIGHT - MARGIN.bottom]
      ]);
      brushGroupRef.current.call(brushGroupRef.current.brush);

      registerChart({ chartEl: svg, xScale, yScale, lines: svg.selectAll(".line"), field, brushGroup: brushGroupRef.current });
      updateBox();
      applyBaselineVisibility();
      }, [data, selectedTimeRange, nodeClusterMap, field, metadata, registerChart, updateBaseline, updateBox, selectedPoints, width, applyBaselineVisibility, hiddenClusters]);

    const currentBaseline = baselinesRef.current[field];
    useEffect(() => { updateBox(); }, [currentBaseline, updateBox]);

    useEffect(() => { applyBaselineVisibility(); }, [applyBaselineVisibility]);
  
    return (
      <div>
        <div ref={svgContainerRef} style={{ width: '100%', height: `${HEIGHT}px` }}></div>
    </div>
  );

};

// Memoized: adding or removing a metric re-renders the whole list, but only the
// chart whose data actually changed needs to redraw.
export default React.memo(LineChart);
