import * as d3 from 'd3';
import React, { useCallback, useEffect, useRef } from 'react';
import { colorScale } from '../utils/colors.js';
import { lineClass } from '../utils/nodes.js';

// Fixed drawing box; these were state that was never set.
const SIZE = { width: 800, height: 300 };
const MARGIN = { top: 40, right: 60, bottom: 60, left: 70 };

const LineChart = ({ data, field, baselinesRef, selectedTimeRange, updateBaseline, nodeClusterMap, metadata, registerChart, showBaselines }) => {
    const svgContainerRef = useRef();
    
    const xScaleRef = useRef();
    const yScaleRef = useRef();
    const brushGroupRef = useRef();

    const isUserBrush = useRef(false);

    // Position the baseline rectangle from the current baseline. Declared before
    // the draw effect so the effect can depend on it without a TDZ error.
    const updateBox = useCallback(() => {
        const baseline = baselinesRef.current[field];
        if (!baseline || !brushGroupRef.current) return;

        const x0 = xScaleRef.current(new Date(baseline.baselineX[0]));
        const x1 = xScaleRef.current(new Date(baseline.baselineX[1]));
        const yTop = yScaleRef.current(baseline.baselineY[1]);
        const yBottom = yScaleRef.current(baseline.baselineY[0]);

        const isVisible = x1 >= MARGIN.left && x0 <= (SIZE.width - MARGIN.right);

        isUserBrush.current = true;
        if (isVisible) {
            brushGroupRef.current.call(brushGroupRef.current.brush.move, [[x0, yTop], [x1, yBottom]]);
        } else {
            brushGroupRef.current.call(brushGroupRef.current.brush.move, null);
        }
    }, [baselinesRef, field]);

    useEffect(() => {
      if (!svgContainerRef.current || !data) return;

      const svg = d3.select(svgContainerRef.current).select("svg").empty()
        ? d3.select(svgContainerRef.current).append("svg")
        : d3.select(svgContainerRef.current).select("svg");

      svg.attr('id', `context-window`)
        .attr('class', 'context')
        .attr("width", "100%")
        .attr("height", "100%")
        .attr("viewBox", `0 0 ${SIZE.width} ${SIZE.height}`)
        .attr("preserveAspectRatio", "xMidYMid meet");

      const xScale = d3.scaleTime().domain(selectedTimeRange).range([MARGIN.left, SIZE.width - MARGIN.right]);

      // Anchor at zero only when the data is non-negative. Metrics that legitimately
      // go negative (temperature deltas, signed counters) were previously clipped
      // to the axis floor and drew as a flat line along the bottom.
      const [dataMin, dataMax] = d3.extent(data, d => d.value);
      const yMin = Number.isFinite(dataMin) ? Math.min(0, dataMin) : 0;
      const yMax = Number.isFinite(dataMax) && dataMax > yMin ? dataMax : yMin + 1;
      const yScale = d3.scaleLinear().domain([yMin, yMax]).nice().range([SIZE.height - MARGIN.bottom, MARGIN.top]);

      xScaleRef.current = xScale;
      yScaleRef.current = yScale;

      // Create the axis groups once, but re-call them on every render — the
      // previous "only if empty" guard meant the y-axis kept the domain it was
      // first drawn with while the lines moved underneath it.
      if (svg.select(".x-axis").empty()) {
        svg.append("g")
          .attr("class", "x-axis")
          .attr("transform", `translate(0, ${SIZE.height - MARGIN.bottom})`);
      }
      if (svg.select(".y-axis").empty()) {
        svg.append("g")
          .attr("class", "y-axis")
          .attr("transform", `translate(${MARGIN.left}, 0)`);
      }

      svg.select(".x-axis")
        .call(d3.axisBottom(xScale).ticks(6).tickFormat(d3.timeFormat("%H:%M")))
        .selectAll("text")
        .style("font-size", "16px");

      svg.select(".y-axis")
        .call(d3.axisLeft(yScale).ticks(5))
        .selectAll("text")
        .style("font-size", "16px");

      const line = d3.line().x(d => xScale(new Date(d.timestamp))).y(d => yScale(d.value));
      const grouped = d3.group(data, d => d.nodeId);

      const clipId = `clip-${field.replace(/\s+/g, '-')}`; // Unique ID per chart
      if (svg.select("defs").empty()) {
        svg.append("defs").append("clipPath")
          .attr("id", clipId)
          .append("rect")
          .attr("x", MARGIN.left)
          .attr("y", MARGIN.top)
          .attr("width", SIZE.width - MARGIN.left - MARGIN.right)
          .attr("height", SIZE.height - MARGIN.top - MARGIN.bottom);
      }

      if (svg.select(".lines").empty()) {
        svg.append("g")
          .attr("class", "lines")
          .attr("clip-path", `url(#${clipId})`); 
      }
      
      svg.select(".lines").selectAll(".line").data(Array.from(grouped), d => d[0])
          .join("path")
          .attr("class", d => `line ${lineClass(d[0])}`)
          // MetricView recolors lines by reading this attribute, so it has to
          // carry the raw id even though the class is the sanitized token.
          .attr("nodeId", d => d[0])
          .attr("fill", "none")
          .style("stroke", d => colorScale(nodeClusterMap.get(d[0])))
          .attr("d", d => line(d[1]));

      svg.selectAll(".chart-title").data([field]).join("text")
        .attr("class", "chart-title")
        .attr("x", SIZE.width / 2)
        .attr("y", 25)
        .attr("text-anchor", "middle")
        .style("font-size", "20px")
        .style("font-weight", "bold")
        .text(d => d);

      // Y-Axis Unit Label
      svg.selectAll(".y-label").data([metadata?.units || "Value"]).join("text")
          .attr("class", "y-label")
          .attr("y", 20)
          .attr("x", 50)
          .attr("text-anchor", "middle")
          .style("font-size", "16px")
          .text(d => d);
      
      if (svg.select(".brush-group").empty()) {
        const brush = d3.brush()
            .extent([[MARGIN.left, MARGIN.top], [SIZE.width - MARGIN.right, SIZE.height - MARGIN.bottom]])
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
                                  .attr("clip-path", `url(#${clipId})`)
                                  .call(brush);
                                  
        brushGroupRef.current.brush = brush; 
      }

      registerChart({ chartEl: svg, xScale, yScale, lines: svg.selectAll(".line"), field, brushGroup: brushGroupRef.current });
      updateBox();
      }, [data, selectedTimeRange, nodeClusterMap, field, metadata, registerChart, updateBaseline, updateBox]);

    const currentBaseline = baselinesRef.current[field];
    useEffect(() => { updateBox(); }, [currentBaseline, updateBox]);

    useEffect(() => {
        if (!brushGroupRef.current) return;

        brushGroupRef.current
            .transition()
            .duration(200)
            .style("opacity", showBaselines ? 1 : 0)
            .style("pointer-events", showBaselines ? "all" : "none"); 
            
    }, [showBaselines]);
  
    return (
      <div>
        <div ref={svgContainerRef} style={{ width: 'auto', height: '190px' }}></div>
    </div>
  );

};

export default LineChart;