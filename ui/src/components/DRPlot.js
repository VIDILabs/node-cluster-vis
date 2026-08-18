import { Card, Col, Form, Row, Select, Button, InputNumber } from "antd";
import * as d3 from 'd3';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colorScale } from '../utils/colors.js';
import { lineClass, nodeClass, pointId } from '../utils/nodes.js';
import { PARAM_LIMITS } from '../config.js';
import LassoSelection from '../utils/lasso.js';
import ClusterToggles from './ClusterToggles.js';
import Tooltip from '../utils/tooltip.js';

const { Option } = Select;

// Resting and hovered radii for a point. Kept as constants because the hover-out
// handler has to restore exactly the resting value; a mismatch made every
// hovered point grow permanently.
const POINT_RADIUS = 4;
const POINT_RADIUS_HOVER = 8;

// Fallback plot geometry, used before the container has been measured and in
// jsdom, which does no layout. The real box comes from the panel: the card
// stretches to fill its column, and the scatter is drawn at that size 1:1 so
// the embedding uses the space instead of being letterboxed inside it.
const SIZE = { width: 300, height: 300 };
const MIN_SIZE = { width: 220, height: 240 };
const MARGIN = { top: 10, right: 20, bottom: 20, left: 20 };
const OPACITY_SELECTED = 1;
const OPACITY_MUTED = 0.4;

const DRView = ({ data, type, selectedPoints, nodeClusterMap, handleRecompute, updateSelectedNodes, nNeighbors, minDist, numClusters, clusters, hiddenClusters, onToggleCluster }) => {
    const svgContainerRef = useRef();
    const [size, setSize] = useState(SIZE);
    const [localNNeighbors, setLocalNNeighbors] = useState(nNeighbors);
    const [localMinDist, setLocalMinDist] = useState(minDist);
    const [localNumClusters, setLocalNumClusters] = useState(numClusters);
    const [tooltip, setTooltip] = useState({
              visible: false,
              content: '',
              x: 0,
              y: 0
          });

    const getIdVal = useCallback(
        (d) => (type === 'feature' ? d.Measurement : d.nodeId),
        [type]
    );

    // Hiding a cluster drops its points, the same as it drops the heatmap's
    // columns and the line charts' polylines. The scales below are still built
    // from the full embedding, so the remaining points stay exactly where they
    // were — a hidden cluster must not rescale the view it was part of.
    const visible = useMemo(() => (
        hiddenClusters?.size
            ? data?.filter(d => !hiddenClusters.has(nodeClusterMap?.get(d.nodeId)))
            : data
    ), [data, hiddenClusters, nodeClusterMap]);

    // Mirror parent-owned parameters into the form. Without this the inputs keep
    // showing the previous dataset's values after a swap or a defaults reset.
    useEffect(() => { setLocalNNeighbors(nNeighbors); }, [nNeighbors]);
    useEffect(() => { setLocalMinDist(minDist); }, [minDist]);
    useEffect(() => { setLocalNumClusters(numClusters); }, [numClusters]);

    // Track the panel the card gives us. Returning the previous object when
    // nothing changed keeps a ResizeObserver callback from re-rendering forever.
    useEffect(() => {
        const node = svgContainerRef.current;
        if (!node) return undefined;
        const measure = () => setSize((prev) => {
            const width = Math.max(node.clientWidth || SIZE.width, MIN_SIZE.width);
            const height = Math.max(node.clientHeight || SIZE.height, MIN_SIZE.height);
            return prev.width === width && prev.height === height ? prev : { width, height };
        });
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    // Create the SVG shell once. Points themselves are drawn by the join below.
    useEffect(() => {
        if (!svgContainerRef.current) return undefined;

        const svg = d3.select(svgContainerRef.current)
          .append("svg")
          .attr('id', `dr-chart-svg-${type}`)
          // Sized in pixels from the measurement below, never in percent: an
          // SVG at height:100% inside an auto-height div computes to zero, so
          // one broken link in the percentage chain made the plot vanish
          // rather than merely misfit.
          .attr("width", SIZE.width)
          .attr("height", SIZE.height)
          .attr("viewBox", `0 0 ${SIZE.width} ${SIZE.height}`)
          .attr("preserveAspectRatio", "xMidYMid meet")
          .style("border", "1px solid #dddddd")
          .style("border-radius", "6px");

        const zoomLayer = svg.append("g").attr("class", "zoom-layer");

        const zoom = d3.zoom()
            .scaleExtent([0.5, 10])
            .filter(event => event.type === "wheel")
            .on("zoom", (event) => zoomLayer.attr("transform", event.transform));

        svg.call(zoom);

        return () => { svg.remove(); };
    }, [type]);

    // Kept out of the draw effect below, which bails early when there is no
    // embedding yet — the empty frame still has to be the right shape.
    useEffect(() => {
        d3.select(svgContainerRef.current).select("svg")
            .attr("width", size.width)
            .attr("height", size.height)
            .attr("viewBox", `0 0 ${size.width} ${size.height}`);
    }, [size]);

    // Draw/update points. A keyed join (rather than the previous update-only
    // pass) means nodes appearing or disappearing — on a dataset swap or a
    // streamed batch — are added and removed instead of leaving stale marks.
    useEffect(() => {
        if (!svgContainerRef.current || !data?.length) return;

        const svg = d3.select(svgContainerRef.current).select("svg");
        const zoomLayer = svg.select(".zoom-layer");
        if (zoomLayer.empty()) return;

        const xKey = 'E1';
        const yKey = 'E2';

        // Pad the extent so points never sit flush against the border.
        const [xMin, xMax] = d3.extent(data, d => +d[xKey]);
        const [yMin, yMax] = d3.extent(data, d => +d[yKey]);
        const xPad = ((xMax - xMin) || 1) * 0.05;
        const yPad = ((yMax - yMin) || 1) * 0.05;

        const xScale = d3.scaleLinear()
            .domain([xMin - xPad, xMax + xPad])
            .range([MARGIN.left, size.width - MARGIN.right]);

        const yScale = d3.scaleLinear()
            .domain([yMin - yPad, yMax + yPad])
            .range([size.height - MARGIN.bottom, MARGIN.top]);

        svg.node().xScale = xScale;
        svg.node().yScale = yScale;

        const isSelected = (d) => (
            selectedPoints.length === 0 || selectedPoints.includes(getIdVal(d))
        );
        const resting = (d) => (isSelected(d) ? OPACITY_SELECTED : OPACITY_MUTED);

        zoomLayer.selectAll(".dr-circle")
            .data(visible, getIdVal)
            .join(
                enter => enter.append("circle")
                    .attr("class", d => `dr-circle ${nodeClass(d.nodeId)}`)
                    .attr('id', d => pointId(getIdVal(d)))
                    .attr("cx", d => xScale(+d[xKey]))
                    .attr("cy", d => yScale(+d[yKey]))
                    .attr('stroke', 'black')
                    .attr('stroke-width', '1px')
                    .attr("r", POINT_RADIUS)
                    .style('fill', d => colorScale(nodeClusterMap.get(d.nodeId))),
                // Named, so it cannot cancel an opacity transition. Points used
                // to fade in from opacity 0 on an unnamed transition; any redraw
                // inside those 800ms cancelled the fade and left the whole
                // embedding stuck at opacity 0 — drawn, hit-testable by the
                // lasso, and completely invisible.
                update => update
                    .call(sel => sel.transition("move").duration(800)
                        .attr("cx", d => xScale(+d[xKey]))
                        .attr("cy", d => yScale(+d[yKey]))
                        .style('fill', d => colorScale(nodeClusterMap.get(d.nodeId)))),
                exit => exit.call(sel => sel.transition("exit").duration(300)
                    .style("opacity", 0).remove())
            )
            // A point that exits and comes back inside those 300ms is matched
            // as an update while still carrying its pending removal; cancelling
            // it here keeps the node from vanishing a moment later.
            .interrupt("exit")
            // Set outright on every draw, for entering and updating points
            // alike, so no interrupted animation can leave one unpainted.
            // Same contract as the line charts: whatever dims a point
            // temporarily restores from this rather than guessing.
            .attr("data-rest-opacity", resting)
            .style("opacity", resting)
            .on("mouseover", function (event, d) {
                const line = lineClass(d.nodeId);

                d3.select(this)
                    .transition().duration(150)
                    .attr("r", POINT_RADIUS_HOVER)
                    .style("opacity", OPACITY_SELECTED);

                // highlighting the matching heatmap cell
                d3.selectAll(`.${nodeClass(d.nodeId)}`)
                    .transition().duration(150)
                    .style("stroke", "black")
                    .style("stroke-width", 2);

                // highlighting the matching time series
                d3.selectAll("path.line")
                    .transition().duration(150)
                    .style("opacity", function () {
                        return d3.select(this).classed(line) ? 1 : 0.1;
                    });

                setTooltip({
                    visible: true,
                    content: d.nodeId,
                    x: event.clientX,
                    y: event.clientY,
                });
            })
            .on("mouseout", function (event, d) {
                d3.select(this)
                    .transition().duration(150)
                    .attr("r", POINT_RADIUS)
                    .style("opacity", isSelected(d) ? OPACITY_SELECTED : OPACITY_MUTED);

                d3.selectAll(`.${nodeClass(d.nodeId)}`)
                    .transition().duration(150)
                    .style("stroke", "none")
                    .style("stroke-width", 0);

                d3.selectAll("path.line")
                    .transition().duration(150)
                    .style("stroke-width", 1)
                    // Back to each line's own resting opacity — restoring a
                    // single value here un-dimmed unselected lines on hover-out.
                    .style("opacity", function () {
                        return d3.select(this).attr("data-rest-opacity") ?? OPACITY_SELECTED;
                    });

                setTooltip(prev => ({ ...prev, visible: false }));
            });
    }, [data, visible, nodeClusterMap, selectedPoints, getIdVal, size]);

    useEffect(() => {
        const resting = (d) => {
            const idVal = getIdVal(d);
            return selectedPoints.includes(idVal) || selectedPoints.length === 0
                ? OPACITY_SELECTED
                : OPACITY_MUTED;
        };

        d3.select(svgContainerRef.current)
            .selectAll(".dr-circle")
            .attr("data-rest-opacity", resting)
            .transition()
            .duration(300)
            .style("opacity", resting);
    }, [selectedPoints, getIdVal]);

    // Lasso selection
    const handleSelection = (selected) => {
        const chart = d3.select(svgContainerRef.current).select("svg");
                
        const resting = (d) => {
            const idVal = getIdVal(d);
            return selected.includes(idVal) || selected.length === 0
                ? OPACITY_SELECTED
                : OPACITY_MUTED;
        };

        chart.selectAll('.dr-circle')
            .attr("data-rest-opacity", resting)
            .style("opacity", resting);

        updateSelectedNodes(selected);
    };

    const { numClusters: clusterLimits, nNeighbors: neighborLimits, minDist: distLimits } = PARAM_LIMITS;
    const clusterOptions = Array.from(
        { length: clusterLimits.max - clusterLimits.min + 1 },
        (_, i) => i + clusterLimits.min
    );

    return (
        <>
            <Card
                title="NODE SIMILARITY VIEW"
                size="small"
                // Takes the slack in its column, so the right-hand panel ends
                // level with the left-hand one at any viewport height.
                className="panel-fill"
            >
            <Row gutter={12}>
                {/* Scatterplot */}
                <Col span={16} style={{ height: '100%', minHeight: 0 }}>
                    <div
                        ref={svgContainerRef}
                        // The min-height is what guarantees the plot is on
                        // screen at all; height:100% only decides how much of
                        // the column's slack it takes beyond that.
                        style={{ height: '100%', minHeight: `${MIN_SIZE.height}px` }}
                    ></div>
                    <LassoSelection
                        svgRef={svgContainerRef}
                        targetItems={'.dr-circle'}
                        onSelect={handleSelection}
                    />
                </Col>

                {/* Config forms stacked vertically */}
                <Col span={7} style={{ alignSelf: 'flex-start' }}>
                    <div
                        id="form-container"
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '8px', // less space between sections
                            alignItems: 'stretch',
                        }}
                        >
                        {/* UMAP Parameters */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <p style={{ margin: 0, fontWeight: 'bold' }}>UMAP Parameters:</p>
                            <Form
                                layout="horizontal"
                                colon={false}
                                style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}
                            >
                            <Form.Item
                                label="n_neighbors"
                                labelCol={{ span: 16 }}
                                wrapperCol={{ span: 10 }}
                                style={{ marginBottom: '4px' }}
                            >
                                <InputNumber
                                    min={neighborLimits.min}
                                    max={neighborLimits.max}
                                    step={neighborLimits.step}
                                    value={localNNeighbors}
                                    onChange={(val) => setLocalNNeighbors(val)}
                                    style={{ width: '100%' }}
                                />
                            </Form.Item>

                            <Form.Item
                                label="min_dist"
                                labelCol={{ span: 16 }}
                                wrapperCol={{ span: 10 }}
                                style={{ marginBottom: '4px' }}
                            >
                                <InputNumber
                                    min={distLimits.min}
                                    max={distLimits.max}
                                    step={distLimits.step}
                                    value={localMinDist}
                                    onChange={(val) => setLocalMinDist(val)}
                                    style={{ width: '100%' }}
                                />
                            </Form.Item>
                            {/* K-Means */}
                            <p style={{ margin: 0, fontWeight: 'bold' }}>K-Means:</p>
                            {/* Not bound to the Form by name: antd would then own the
                                value and ignore the controlled `value` below, which
                                left the dropdown stale after a reset. */}
                            <Form.Item
                                label="Num clusters"
                                labelCol={{ span: 15 }}
                                wrapperCol={{ span: 14 }}
                                style={{ marginBottom: 0 }}
                            >
                                <Select
                                    style={{ width: '100%' }}
                                    value={localNumClusters}
                                    onChange={(val) => setLocalNumClusters(val)}
                                >
                                {clusterOptions.map((num) => (
                                    <Option key={num} value={num}>
                                    {num}
                                    </Option>
                                ))}
                                </Select>
                            </Form.Item>
                            </Form>      
                        </div>               
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column", // stack vertically
                                gap: "6px",
                                marginTop: "8px",
                                alignItems: "stretch",
                            }}
                            >
                            <Button
                                size="small"
                                onClick={() =>
                                    handleRecompute(localNumClusters, localNNeighbors, localMinDist, true, false)
                                }
                                type="primary"
                            >
                            Recompute
                            </Button>
                            <Button
                                size="small"
                                onClick={() => {
                                    // The parent owns the dataset's defaults; ask it to
                                    // restore them and mirror whatever it settles on
                                    // rather than guessing fixed numbers here.
                                    handleRecompute?.(localNumClusters, localNNeighbors, localMinDist, true, true);
                                }}
                            >
                            Reset Defaults
                            </Button>
                        </div>
                        {/* The one place cluster visibility is set. It lives
                            here, next to the controls that decide how many
                            clusters there are, rather than in each view that
                            honours it — the same buttons in two panels read as
                            two independent filters. */}
                        <ClusterToggles
                            clusters={clusters}
                            hidden={hiddenClusters}
                            onToggle={onToggleCluster}
                            label="Show clusters:"
                        />
                    </div>
                </Col>
            </Row>
        </Card>

        <Tooltip
            visible={tooltip.visible}
            content={tooltip.content}
            x={tooltip.x}
            y={tooltip.y}
            tooltipId={'dr-tooltip'}
        />
        </>
        );


}

export default DRView;