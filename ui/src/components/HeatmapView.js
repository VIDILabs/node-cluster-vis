import { useCallback, useState, useEffect, useRef } from 'react';
import { Card } from "antd";
import * as d3 from 'd3';
import { colorScale, zScoreColor } from '../utils/colors.js';
import { lineClass, nodeClass, pointId } from '../utils/nodes.js';
import Tooltip from '../utils/tooltip.js';

// Fixed axis gutters; these were state that was never set.
const MARGIN = { top: 0, right: 50, bottom: 100, left: 100 };

const HeatmapView = ({ data, nodeClusterMap }) => {
    const heatmapRef = useRef();
    const legendRef = useRef();
    const [tooltip, setTooltip] = useState({
            visible: false,
            content: '',
            x: 0,
            y: 0
        });

    const drawHeatmap = useCallback((matrix, featureNames, nodeIds) => {
        const cellWidth = 20;
        const cellHeight = 30;
        const mapWidth = nodeIds.length * cellWidth;
        const mapHeight = featureNames.length * cellHeight;

        const containerNode = heatmapRef.current;
        const visibleHeight = containerNode ? containerNode.clientHeight : 400;

        const yScale = d3.scaleBand().domain(featureNames).range([0, mapHeight]).padding(0.05);
        const xScale = d3.scaleBand().domain(nodeIds).range([0, mapWidth]).padding(0.05);
        const myColor = zScoreColor;

        const container = d3.select(heatmapRef.current);
        let parent = container.select("#heatmap-parent");

        if (parent.empty()) {
            parent = container.append("div").attr("id", "heatmap-parent")
                .style("position", "relative")
                .style("width", "100%")
                .style("height", "100%");

            const scrollDiv = parent.append("div")
                .attr("id", "heatmap-scroll")
                .style("position", "absolute")
                .style("left", `${MARGIN.left}px`)
                .style("top", `${MARGIN.top}px`)
                .style("width", `calc(100% - ${MARGIN.left}px)`)
                .style("height", `${visibleHeight - MARGIN.top - MARGIN.bottom}px`) 
                .style("overflow", "auto")
                .style("scrollbar-width", "none")
                .style("z-index", 1);

            const svg = scrollDiv.append("svg").attr("id", "heatmap-svg");
            svg.append("g").attr("class", "heatmap-group");

            const axisSvg = parent.append("svg")
                .attr("id", "axis-svg")
                .style("position", "absolute")
                .style("top", 0).style("left", 0)
                .style("pointer-events", "none")
                .style("z-index", 10);

            axisSvg.append("rect").attr("id", "y-axis-bg").style("fill", "white");
            axisSvg.append("rect").attr("id", "x-axis-bg").style("fill", "white");

            axisSvg.append("g").attr("class", "y-axis");
            axisSvg.append("g").attr("class", "x-axis");
        }

        const stickyXPosition = visibleHeight - MARGIN.bottom;

        const scrollDiv = container.select("#heatmap-scroll")
            .style("height", `${stickyXPosition - MARGIN.top}px`); // Clip rows before they hit the X-axis

        const svg = container.select("#heatmap-svg")
            .attr("width", mapWidth)
            .attr("height", mapHeight);

        const axisSvg = container.select("#axis-svg")
            .attr("width", containerNode.clientWidth)
            .attr("height", visibleHeight);

        axisSvg.select("#y-axis-bg").attr("width", MARGIN.left).attr("height", visibleHeight);
        
        axisSvg.select("#x-axis-bg")
            .attr("x", MARGIN.left)
            .attr("y", stickyXPosition) 
            .attr("width", containerNode.clientWidth - MARGIN.left)
            .attr("height", MARGIN.bottom);

        container.select(".y-axis").call(d3.axisLeft(yScale));
        container.select(".x-axis")
            .call(d3.axisBottom(xScale))
            .selectAll("text")
            .attr("transform", "rotate(-65)")
            .attr("dx", "-.8em").attr("dy", ".15em")
            .style("text-anchor", "end")
            .style("fill", d => colorScale(nodeClusterMap.get(d)))
            .style("font-weight", "bold");

        function syncAxesToScroll() {
            const node = scrollDiv.node();
            const scrollLeft = node.scrollLeft;
            const scrollTop = node.scrollTop;

            container.select(".y-axis")
                .attr("transform", `translate(${MARGIN.left}, ${MARGIN.top - scrollTop})`);

            container.select(".x-axis")
                .attr("transform", `translate(${MARGIN.left - scrollLeft}, ${stickyXPosition})`);
        }

        scrollDiv.on("scroll", syncAxesToScroll);
        syncAxesToScroll();

        // --- Render Cells ---
        const cells = svg.select('.heatmap-group').selectAll('.heatmap-cell')
            .data(matrix, d => d.nodeId + ':' + d.feature);

        cells.enter()
            .append("rect")
            .attr("class", d => `heatmap-cell ${nodeClass(d.nodeId)}`)
            .merge(cells)
            .attr("x", d => xScale(d.nodeId))
            .attr("y", d => yScale(d.feature))
            .attr("width", xScale.bandwidth())
            .attr("height", yScale.bandwidth())
            .attr("rx", 4).attr("ry", 4)
            .style("fill", d => myColor(d.value))
             .on("mouseover", function(event, d) {
                const line = lineClass(d.nodeId);
                d3.select(this).style("stroke", "black").style("stroke-width", "2px").style("opacity", 1);
                d3.select(`#${pointId(d.nodeId)}`).transition().duration(150).attr("r", 8).style("opacity", 1);
                d3.selectAll("path.line").transition().duration(150)
                .style("opacity", function() { return d3.select(this).classed(line) ? 1 : 0.1; })
                .style("stroke-width", function() { return d3.select(this).classed(line) ? "3px" : "1.5px"; });
                 setTooltip({
                    visible: true,
                    content: `${d.nodeId}, ${Number.isFinite(d.value) ? d.value.toFixed(3) : 'N/A'}`,
                    x: event.clientX,
                    y: event.clientY,
                });

                })
                .on("mouseout", function(event, d) {
                    d3.select(this).style("stroke", "none").style("opacity", 0.8);
                    // Restore the scatterplot's resting radius, which is 4.
                    d3.select(`#${pointId(d.nodeId)}`).transition().duration(150).attr("r", 4);
                    d3.selectAll("path.line").interrupt().transition().duration(150)
                    .style("opacity", 0.8).style("stroke-width", "1.5px");
                    setTooltip(prev => ({ ...prev, visible: false }));
                });
        
        cells.exit().remove();

        // ----- Legend rendering -----
        let lSvg = d3.select(legendRef.current).select('svg');

        if (lSvg.empty()) {
            lSvg = d3.select(legendRef.current)
                .append('svg')
                .attr('width', 200)
                .attr('height', 50);

            const legendWidth = 120;
            const legendHeight = 10;

            const defs = lSvg.append("defs");
            const linearGradient = defs.append("linearGradient")
                .attr("id", "legend-gradient")
                .attr("x1", "0%").attr("x2", "100%")
                .attr("y1", "0%").attr("y2", "0%");

            // Gradient endpoints match the legend axis domain below, so the ramp
            // and its tick labels describe the same range.
            linearGradient.selectAll("stop")
                .data([
                    { offset: "0%", color: myColor(-5) },
                    { offset: "50%", color: myColor(0) },
                    { offset: "100%", color: myColor(5) }
                ])
                .enter().append("stop")
                .attr("offset", d => d.offset)
                .attr("stop-color", d => d.color);

            const legendGroup = lSvg.append("g")
                .attr("transform", `translate(20, 20)`);

            legendGroup.append("rect")
                .attr("width", legendWidth)
                .attr("height", legendHeight)
                .style("fill", "url(#legend-gradient)");

            const legendScale = d3.scaleLinear()
                .domain([-5, 5])
                .range([0, legendWidth]);

            const legendAxis = d3.axisBottom(legendScale)
                .tickValues([-5, -2.5, 0, 2.5, 5])
                .tickFormat(d3.format(".1f"))
                .tickSize(5);

            legendGroup.append("g")
                .attr("transform", `translate(0, ${legendHeight})`)
                .call(legendAxis)
                .style('font-size', 12)
                .select(".domain").remove();

            legendGroup.append('text')
                .attr('x', legendWidth / 2)
                .attr('y', -5)
                .style('text-anchor', 'middle')
                .style('font-size', '12px')
                .style('font-weight', 'bold')
                .text('Z-Scores');
        }
    }, [nodeClusterMap]);

    useEffect(() => {
        if (!heatmapRef.current || !nodeClusterMap || !legendRef.current || !data || data.length === 0) return;

        // Natural sort: orders node-2 before node-10 where names carry numbers,
        // and falls back to plain collation for names that don't — the previous
        // parseInt-after-last-hyphen rule produced NaN for anything else.
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        const nodeIds = data.map(d => d.nodeId).sort(collator.compare);

        const features = Object.keys(data[0]).filter(key => key !== "nodeId");
        const matrix = [];
        features.forEach((feature, rowIndex) => {
            data.forEach((d, colIndex) => {
                matrix.push({
                    feature,
                    nodeId: d.nodeId,
                    value: d[feature],
                    row: rowIndex,
                    col: colIndex
                });
            });
        });
        drawHeatmap(matrix, features, nodeIds);
    }, [data, nodeClusterMap, drawHeatmap]);


return (
    <Card title="NODE BEHAVIOR VIEW" size="small" style={{ height: "calc(50vh - 20px)", width: '100%' }}>
        <div style={{ display:'flex', position:'relative' }}>
            <div ref={heatmapRef} style={{
                    width: "100%",
                    height: "calc(50vh - 150px)",
                    overflow: "hidden",
                    position: "relative"
                }}
            />
        </div>

        <div ref={legendRef} style={{ overflow:'hidden' }}  />
        <Tooltip
            visible={tooltip.visible}
            content={tooltip.content}
            x={tooltip.x}
            y={tooltip.y}
            tooltipId={`zscores-tooltip`}
          />
    </Card>
    );
};

export default HeatmapView;