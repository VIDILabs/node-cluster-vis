import { useCallback, useState, useEffect, useRef } from 'react';
import { Card, Segmented } from "antd";
import * as d3 from 'd3';
import { colorScale, zScoreColor } from '../utils/colors.js';
import { lineClass, nodeClass, pointId } from '../utils/nodes.js';
import { CHART_FONT, OPACITY } from '../config.js';
import Tooltip from '../utils/tooltip.js';

// Nodes run down the rows and metrics across the top. The node axis is the long
// one — hundreds of nodes against a dozen metrics — and a column of names reads
// straight off, where the same list across the bottom had to be rotated 65
// degrees and read at an angle. Rotating the map also puts its long axis along
// the page's long axis, which is what lets the panel be narrow.
//
// Fixed axis gutters. The top has to hold a rotated metric name at
// CHART_FONT.label; the left, a node id at CHART_FONT.axis.
//
// The top is arithmetic, not a guess, and it has to be re-checked if either the
// type size or METRIC_LABEL_ANGLE moves. A label's vertical reach is its length
// times sin(angle), plus the 9px the axis holds it off its own line and about
// 8px of dx/dy nudge. `Missed Buffers_P1` — the longest name in the bundled
// sample — is roughly 115px at 14px sans, so 115 * sin(55) + 17 comes to 111.
// A name much longer than that is clipped by the top of the overlay rather
// than pushing the map down, which is the right trade at a dozen metrics.
export const MARGIN = { top: 120, right: 20, bottom: 0, left: 100 };
// A cell is the same size whatever the node count. Sizing it to fit the panel
// meant the cells you were shown depended on how many clusters happened to be
// visible — readable with one cluster on, slivers with four — so the same
// z-score looked different from one moment to the next. The rows scroll
// vertically instead; the panel is what gives, not the encoding.
export const CELL = { width: 20, height: 20 };
// Metric names are rotated so they can sit above 20px-wide columns. At this
// angle adjacent labels need about type-height / sin(angle) of horizontal room:
// 55 degrees leaves real clearance at CHART_FONT.label where 45 would leave
// none. Below that width labels are thinned rather than left to overprint.
const METRIC_LABEL_ANGLE = 55;
const LABEL_MIN_WIDTH = Math.ceil(CHART_FONT.label / Math.sin((METRIC_LABEL_ANGLE * Math.PI) / 180));
// Node labels are horizontal now, so what they need is vertical room: one line
// of type plus a hair of leading. CELL.height clears it, so nothing is thinned
// in practice — the guard is here so a smaller cell degrades legibly.
const LABEL_MIN_HEIGHT = CHART_FONT.axis + 2;
// Fallback ceiling on the rows area, used before the panel has been measured
// and in jsdom, which does no layout. In the browser the rows take the card's
// slack and scroll past it.
export const MAX_ROWS_HEIGHT = 360;

// The card's own chrome around the map: 12px of body padding each side at
// size="small", plus a 1px border each side, plus 4px of slack. The slack is
// deliberate — being a couple of pixels short would put a horizontal scrollbar
// under a map that visibly fits, which is far worse than a hairline of gutter.
export const CARD_CHROME = 30;
// Floor, so the card's own title and sort control stay legible. A three-metric
// selection would otherwise ask for a panel narrower than its own header.
export const MIN_PANEL_WIDTH = 260;

/**
 * The width this panel actually needs, in pixels.
 *
 * The map is a fixed 20px per metric plus two gutters, so unlike every other
 * panel it has an exact natural width and no use for anything beyond it — a
 * dozen columns is a dozen columns however many nodes there are. App sizes the
 * column from this rather than from a 24ths span, and gives what is left to the
 * reading column.
 */
export const panelWidth = (featureCount) => Math.max(
    MARGIN.left + featureCount * CELL.width + MARGIN.right + CARD_CHROME,
    MIN_PANEL_WIDTH
);

// Row order. Cluster order groups a k-means cluster into one contiguous block,
// which is what makes a whole-cluster excursion visible as a band.
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
        const visibleHeight = containerNode?.clientHeight || (MAX_ROWS_HEIGHT + MARGIN.top);
        const cellWidth = CELL.width;
        const cellHeight = CELL.height;
        // Metrics across, nodes down.
        const mapWidth = featureNames.length * cellWidth;
        const mapHeight = nodeIds.length * cellHeight;

        const xScale = d3.scaleBand().domain(featureNames).range([0, mapWidth]).padding(0.05);
        const yScale = d3.scaleBand().domain(nodeIds).range([0, mapHeight]).padding(0.05);
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

            // Document order is paint order, and with the map rotated it is the
            // *x*-axis that has to win it. The node labels are the ones that
            // move: they scroll vertically with the rows, so scrolling down
            // slides them up into the metric-name gutter. The outer SVG clips
            // anything above its own top edge, but between there and
            // MARGIN.top there is nothing to hide them — so the metric axis is
            // appended last and its white ground, then the names, paint over
            // them. Its background spans the full width, including the node
            // gutter, because that is where the collision happens; no metric
            // label reaches back into it, so covering it costs nothing.
            axisSvg.append("rect").attr("id", "y-axis-bg").style("fill", "white");
            axisSvg.append("g").attr("class", "y-axis");

            axisSvg.append("rect").attr("id", "x-axis-bg").style("fill", "white");
            axisSvg.append("g").attr("class", "x-axis");
        }

        // The rows area takes whatever the panel has left under the metric
        // axis, and only scrolls once the nodes genuinely outgrow it. Sizing it
        // to the full container instead left a gap the height of the unused
        // space whenever there were fewer nodes than the panel could hold.
        const availableHeight = Math.max(visibleHeight - MARGIN.top - MARGIN.bottom, cellHeight);
        const contentHeight = Math.min(mapHeight, availableHeight);
        const availableWidth = Math.max(
            (containerNode?.clientWidth || mapWidth + MARGIN.left + MARGIN.right) - MARGIN.left - MARGIN.right,
            cellWidth
        );

        const scrollDiv = container.select("#heatmap-scroll")
            .style("height", `${contentHeight}px`)
            .style("overflow-y", mapHeight > contentHeight ? "auto" : "hidden")
            .style("overflow-x", mapWidth > availableWidth ? "auto" : "hidden");

        const svg = container.select("#heatmap-svg")
            .attr("width", mapWidth)
            .attr("height", mapHeight);

        const axisSvg = container.select("#axis-svg")
            .attr("width", containerNode?.clientWidth || 0)
            .attr("height", visibleHeight);

        // The node gutter runs the height of the rows; the metric gutter runs
        // the full width, over the top of it, for the reason given above.
        axisSvg.select("#y-axis-bg")
            .attr("x", 0)
            .attr("y", MARGIN.top)
            .attr("width", MARGIN.left)
            .attr("height", contentHeight);

        axisSvg.select("#x-axis-bg")
            .attr("x", 0)
            .attr("y", 0)
            .attr("width", containerNode?.clientWidth || 0)
            .attr("height", MARGIN.top);

        // Thin the node labels if a cell ever gets shorter than a line of type.
        // At CELL.height this is a stride of 1, so every node keeps its name.
        const nodeStride = Math.max(Math.ceil(LABEL_MIN_HEIGHT / cellHeight), 1);
        const yAxis = d3.axisLeft(yScale)
            .tickValues(nodeIds.filter((_, i) => i % nodeStride === 0));

        container.select(".y-axis")
            .call(yAxis)
            .selectAll("text")
            .style("fill", d => colorScale(nodeClusterMap.get(d)))
            .style("opacity", d => cellOpacity(d))
            .style("font-size", `${CHART_FONT.axis}px`)
            .style("font-weight", "bold");

        // Same guard on the metric axis, against a narrow cell rather than a
        // short one — rotated labels need horizontal room proportional to their
        // type size.
        const metricStride = Math.max(Math.ceil(LABEL_MIN_WIDTH / cellWidth), 1);
        const xAxis = d3.axisTop(xScale)
            .tickValues(featureNames.filter((_, i) => i % metricStride === 0));

        container.select(".x-axis")
            .call(xAxis)
            .selectAll("text")
            // Anchored at the start and rotated up: the name rises to the right
            // of the column it belongs to, so it never reaches back over the
            // node gutter.
            .attr("transform", `rotate(-${METRIC_LABEL_ANGLE})`)
            .attr("dx", ".6em").attr("dy", "-.2em")
            .style("text-anchor", "start")
            .style("font-size", `${CHART_FONT.label}px`);

        function syncAxesToScroll() {
            const node = scrollDiv.node();
            const scrollLeft = node.scrollLeft;
            const scrollTop = node.scrollTop;

            container.select(".y-axis")
                .attr("transform", `translate(${MARGIN.left}, ${MARGIN.top - scrollTop})`);

            container.select(".x-axis")
                .attr("transform", `translate(${MARGIN.left - scrollLeft}, ${MARGIN.top})`);
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
            .attr("x", d => xScale(d.feature))
            .attr("y", d => yScale(d.nodeId))
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
        // Hiding a cluster drops its rows outright rather than dimming them.
        // Unlike a lasso selection — which is drawn, not filtered, so the
        // selection keeps its context — this is an explicit request for the
        // space back, and the remaining rows close up to use it.
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

        // Columns come from the full data, so hiding every cluster empties the
        // rows without also collapsing the metric list off the top axis.
        const features = Object.keys(data[0]).filter(key => key !== "nodeId");
        const matrix = [];
        shown.forEach((d, rowIndex) => {
            features.forEach((feature, colIndex) => {
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


    // Rows are nodes, so the map is tall rather than wide and there are far more
    // rows than a panel can hold. It takes the card's slack and scrolls past it;
    // this is only the floor — enough for the nodes it has, up to the cap — so a
    // short viewport still shows a usable strip rather than a sliver.
    const nodeCount = data?.length ?? 0;
    const minRowsHeight = Math.min(nodeCount * CELL.height, MAX_ROWS_HEIGHT);

return (
    <Card
        title="NODE BEHAVIOR VIEW"
        size="small"
        // Takes the slack in its column, the same way the DR card does in
        // its own, so the three columns end level at any viewport height.
        className="panel-fill"
        style={{ width: '100%' }}
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
        <div ref={heatmapRef} style={{
                width: "100%",
                // Flex, not a percentage: an auto-height parent anywhere in a
                // percentage chain resolves the whole thing to zero. The
                // min-height is the floor described above, and what the
                // component measures itself against before layout runs.
                flex: "1 1 auto",
                minHeight: `${minRowsHeight + MARGIN.top}px`,
                overflow: "hidden",
                position: "relative"
            }}
        />

        <div ref={legendRef} style={{ overflow:'hidden', flexShrink: 0 }}  />
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