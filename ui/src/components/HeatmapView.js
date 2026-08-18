import { useCallback, useState, useEffect, useRef } from 'react';
import { Card, Segmented } from "antd";
import * as d3 from 'd3';
import { colorScale, zScoreColor } from '../utils/colors.js';
import { lineClass, nodeClass, pointId } from '../utils/nodes.js';
import { CHART_FONT, OPACITY } from '../config.js';
import Tooltip from '../utils/tooltip.js';

// Fixed axis gutters; these were state that was never set. The left gutter has
// to hold a metric name at CHART_FONT.label.
export const MARGIN = { top: 0, right: 50, bottom: 110, left: 140 };
// A cell is the same size whatever the node count. Sizing it to fit the panel
// meant the cells you were shown depended on how many clusters happened to be
// visible — readable with one cluster on, slivers with four — so the same
// z-score looked different from one moment to the next. The rows scroll
// horizontally instead; the panel is what gives, not the encoding.
export const CELL = { width: 20, height: 20 };
// Below this a rotated node label can't be read, so labels are thinned instead.
// Rotated -65deg, adjacent labels need about type-height / sin(65deg) of
// horizontal room, so this tracks CHART_FONT.axis rather than being guessed.
const LABEL_MIN_WIDTH = Math.ceil(CHART_FONT.axis / Math.sin((65 * Math.PI) / 180));
// Ceiling on the rows area before it starts scrolling instead of growing.
export const MAX_ROWS_HEIGHT = 360;

// Column order. Cluster order groups a k-means cluster into one contiguous
// block, which is what makes a whole-cluster excursion visible as a band.
const SORT_OPTIONS = [
    { label: 'ID', value: 'name' },
    { label: 'Cluster', value: 'cluster' },
];

const HeatmapView = ({ data, nodeClusterMap, selectedPoints, hiddenClusters }) => {
    const heatmapRef = useRef();
    const legendRef = useRef();
    const [sortBy, setSortBy] = useState('name');
    const [tooltip, setTooltip] = useState({
            visible: false,
            content: '',
            x: 0,
            y: 0
        });

    // An empty selection means "nothing singled out", so everything reads at
    // full strength rather than everything being dimmed.
    const cellOpacity = useCallback((nodeId) => (
        !selectedPoints?.length || selectedPoints.includes(nodeId)
            ? OPACITY.selected
            : OPACITY.muted
    ), [selectedPoints]);

    const drawHeatmap = useCallback((matrix, featureNames, nodeIds) => {
        const containerNode = heatmapRef.current;
        const visibleHeight = containerNode ? containerNode.clientHeight : 400;
        const cellWidth = CELL.width;
        const cellHeight = CELL.height;
        const mapWidth = nodeIds.length * cellWidth;
        const mapHeight = featureNames.length * cellHeight;

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
                // Thin, not hidden: with the cells sized down to fit there is
                // usually nothing to scroll, but when there is, the user needs
                // to be able to tell.
                .style("scrollbar-width", "thin")
                .style("z-index", 1);

            const svg = scrollDiv.append("svg").attr("id", "heatmap-svg");
            svg.append("g").attr("class", "heatmap-group");

            const axisSvg = parent.append("svg")
                .attr("id", "axis-svg")
                .style("position", "absolute")
                .style("top", 0).style("left", 0)
                .style("pointer-events", "none")
                .style("z-index", 10);

            // Document order is paint order, and the y-axis has to win it.
            // Node labels are rotated, so each one's tail runs left of the
            // column it belongs to, and scrolling the columns right slides more
            // of them into the metric-name gutter. Painting the x-axis first
            // means the y gutter's white ground — and then the metric names —
            // cover that tail: labels slide behind the axis instead of
            // overprinting it.
            axisSvg.append("rect").attr("id", "x-axis-bg").style("fill", "white");
            axisSvg.append("g").attr("class", "x-axis");

            axisSvg.append("rect").attr("id", "y-axis-bg").style("fill", "white");
            axisSvg.append("g").attr("class", "y-axis");
        }

        // Tether the x-axis to the bottom of the rows, not to the bottom of the
        // container. Pinning it to the container left a gap the height of the
        // unused space whenever the metric list was shorter than the panel —
        // which, with everything selected by default, is the normal case. The
        // rows only start scrolling once they genuinely outgrow the panel.
        const availableHeight = Math.max(visibleHeight - MARGIN.top - MARGIN.bottom, cellHeight);
        const contentHeight = Math.min(mapHeight, availableHeight);
        const stickyXPosition = MARGIN.top + contentHeight;

        const scrollDiv = container.select("#heatmap-scroll")
            .style("height", `${contentHeight}px`)
            .style("overflow-y", mapHeight > contentHeight ? "auto" : "hidden");

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

        container.select(".y-axis")
            .call(d3.axisLeft(yScale))
            .selectAll("text")
            .style("font-size", `${CHART_FONT.label}px`);

        // Thin the tick labels once cells are too narrow to carry one each,
        // rather than letting a hundred rotated labels overprint each other.
        const labelStride = Math.max(Math.ceil(LABEL_MIN_WIDTH / cellWidth), 1);
        const xAxis = d3.axisBottom(xScale)
            .tickValues(nodeIds.filter((_, i) => i % labelStride === 0));

        container.select(".x-axis")
            .call(xAxis)
            .selectAll("text")
            .attr("transform", "rotate(-65)")
            .attr("dx", "-.8em").attr("dy", ".15em")
            .style("text-anchor", "end")
            .style("fill", d => colorScale(nodeClusterMap.get(d)))
            .style("opacity", d => cellOpacity(d))
            .style("font-size", `${CHART_FONT.axis}px`)
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
            .style("opacity", d => cellOpacity(d.nodeId))
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
                    // Restore the cell's selection opacity, not a fixed 0.8 —
                    // otherwise hovering a dimmed cell permanently un-dims it.
                    d3.select(this).style("stroke", "none").style("opacity", cellOpacity(d.nodeId));
                    // Restore the scatterplot's resting radius, which is 4.
                    d3.select(`#${pointId(d.nodeId)}`).transition().duration(150).attr("r", 4);
                    d3.selectAll("path.line").interrupt().transition().duration(150)
                    .style("opacity", function() {
                        return d3.select(this).attr("data-rest-opacity") ?? 1;
                    })
                    .style("stroke-width", "1.5px");
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
    }, [nodeClusterMap, cellOpacity]);

    // Cell width is derived from the panel width, so a resize has to redraw or
    // the heatmap keeps the geometry it was first laid out with.
    const [resizeTick, setResizeTick] = useState(0);
    useEffect(() => {
        const node = heatmapRef.current;
        if (!node || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(() => setResizeTick(t => t + 1));
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!heatmapRef.current || !nodeClusterMap || !legendRef.current || !data || data.length === 0) return;

        // Natural sort: orders node-2 before node-10 where names carry numbers,
        // and falls back to plain collation for names that don't — the previous
        // parseInt-after-last-hyphen rule produced NaN for anything else. Under
        // 'cluster' the same collation breaks ties inside each cluster, so the
        // order is still stable and predictable.
        // Hiding a cluster drops its columns outright rather than dimming them.
        // Unlike a lasso selection — which is drawn, not filtered, so the
        // selection keeps its context — this is an explicit request for the
        // space back, and the remaining cells widen to use it.
        const shown = data.filter(d => !hiddenClusters?.has(nodeClusterMap.get(d.nodeId)));

        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        const clusterOf = (nodeId) => {
            const cluster = nodeClusterMap.get(nodeId);
            // Unassigned nodes sort last rather than colliding with cluster 0.
            return Number.isFinite(cluster) ? cluster : Number.MAX_SAFE_INTEGER;
        };
        const nodeIds = shown.map(d => d.nodeId).sort((a, b) => {
            if (sortBy === 'cluster') {
                const byCluster = clusterOf(a) - clusterOf(b);
                if (byCluster !== 0) return byCluster;
            }
            return collator.compare(a, b);
        });

        // Rows come from the full data, so hiding every cluster empties the
        // columns without also collapsing the metric list.
        const features = Object.keys(data[0]).filter(key => key !== "nodeId");
        const matrix = [];
        features.forEach((feature, rowIndex) => {
            shown.forEach((d, colIndex) => {
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
    }, [data, nodeClusterMap, drawHeatmap, resizeTick, sortBy, hiddenClusters]);


    // Size the panel to the rows it has, up to a cap. Below the cap the x-axis
    // sits directly under the last row; above it the rows scroll and the axis
    // stays pinned at the cap. A fixed panel height left a gap the size of the
    // unused space between the last metric and the axis.
    const featureCount = data?.length ? Object.keys(data[0]).filter(k => k !== 'nodeId').length : 0;
    const rowsHeight = Math.min(featureCount * CELL.height, MAX_ROWS_HEIGHT);

return (
    <Card
        title="NODE BEHAVIOR VIEW"
        size="small"
        style={{ height: 'auto', width: '100%' }}
        extra={
            // Ordering only. Cluster visibility is set once, in the Node
            // Similarity panel, and every view honours it from there.
            <Segmented
                size="small"
                options={SORT_OPTIONS}
                value={sortBy}
                onChange={setSortBy}
            />
        }
    >
        <div style={{ display:'flex', position:'relative' }}>
            <div ref={heatmapRef} style={{
                    width: "100%",
                    height: `${rowsHeight + MARGIN.bottom}px`,
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