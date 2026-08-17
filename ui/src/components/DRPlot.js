import { Card, Col, Form, Row, Select, Button, InputNumber } from "antd";
import * as d3 from 'd3';
import { useCallback, useEffect, useRef, useState } from 'react';
import { colorScale } from '../utils/colors.js';
import { lineClass, nodeClass, pointId } from '../utils/nodes.js';
import { PARAM_LIMITS } from '../config.js';
import LassoSelection from '../utils/lasso.js';
import Tooltip from '../utils/tooltip.js';

const { Option } = Select;

// Resting and hovered radii for a point. Kept as constants because the hover-out
// handler has to restore exactly the resting value; a mismatch made every
// hovered point grow permanently.
const POINT_RADIUS = 4;
const POINT_RADIUS_HOVER = 8;

// Fixed plot geometry and the opacities used to fade unselected points. These
// were state that was never set.
const SIZE = { width: 300, height: 300 };
const MARGIN = { top: 10, right: 20, bottom: 20, left: 20 };
const OPACITY_SELECTED = 1;
const OPACITY_MUTED = 0.4;

const DRView = ({ data, type, selectedPoints, nodeClusterMap, handleRecompute, updateSelectedNodes, nNeighbors, minDist, numClusters }) => {
    const svgContainerRef = useRef();
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

    // Mirror parent-owned parameters into the form. Without this the inputs keep
    // showing the previous dataset's values after a swap or a defaults reset.
    useEffect(() => { setLocalNNeighbors(nNeighbors); }, [nNeighbors]);
    useEffect(() => { setLocalMinDist(minDist); }, [minDist]);
    useEffect(() => { setLocalNumClusters(numClusters); }, [numClusters]);

    // Create the SVG shell once. Points themselves are drawn by the join below.
    useEffect(() => {
        if (!svgContainerRef.current) return undefined;

        const svg = d3.select(svgContainerRef.current)
          .append("svg")
          .attr('id', `dr-chart-svg-${type}`)
          .attr("width", "100%")
          .attr("height", "100%")
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
            .range([MARGIN.left, SIZE.width - MARGIN.right]);

        const yScale = d3.scaleLinear()
            .domain([yMin - yPad, yMax + yPad])
            .range([SIZE.height - MARGIN.bottom, MARGIN.top]);

        svg.node().xScale = xScale;
        svg.node().yScale = yScale;

        const isSelected = (d) => (
            selectedPoints.length === 0 || selectedPoints.includes(getIdVal(d))
        );

        zoomLayer.selectAll(".dr-circle")
            .data(data, getIdVal)
            .join(
                enter => enter.append("circle")
                    .attr("class", d => `dr-circle ${nodeClass(d.nodeId)}`)
                    .attr('id', d => pointId(getIdVal(d)))
                    .attr("cx", d => xScale(+d[xKey]))
                    .attr("cy", d => yScale(+d[yKey]))
                    .attr('stroke', 'black')
                    .attr('stroke-width', '1px')
                    .attr("r", POINT_RADIUS)
                    .style('fill', d => colorScale(nodeClusterMap.get(d.nodeId)))
                    .style("opacity", 0)
                    .call(sel => sel.transition().duration(800)
                        .style("opacity", d => (isSelected(d) ? OPACITY_SELECTED : OPACITY_MUTED))),
                update => update
                    .call(sel => sel.transition().duration(800)
                        .attr("cx", d => xScale(+d[xKey]))
                        .attr("cy", d => yScale(+d[yKey]))
                        .style('fill', d => colorScale(nodeClusterMap.get(d.nodeId)))),
                exit => exit.call(sel => sel.transition().duration(300)
                    .style("opacity", 0).remove())
            )
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
                    .style("opacity", OPACITY_SELECTED);

                setTooltip(prev => ({ ...prev, visible: false }));
            });
    }, [data, nodeClusterMap, selectedPoints, getIdVal]);

    useEffect(() => {
        d3.select(svgContainerRef.current)
            .selectAll(".dr-circle")
            .transition()
            .duration(300)
            .style("opacity", d => {
                const idVal = getIdVal(d);
                if (selectedPoints.includes(idVal) || selectedPoints.length === 0) {
                    return OPACITY_SELECTED;
                }
                return OPACITY_MUTED;
            });
    }, [selectedPoints, getIdVal]);

    // Lasso selection
    const handleSelection = (selected) => {
        const chart = d3.select(svgContainerRef.current).select("svg");
                
        chart.selectAll('.dr-circle')
            .style("opacity", d => {
                const idVal = getIdVal(d);
                if (selected.includes(idVal) || selected.length === 0) {
                    return OPACITY_SELECTED; 
                } else {
                    return OPACITY_MUTED;
                }
        });

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
                style={{ height: 'auto' }}
            >
            <Row gutter={12} align="top">
                {/* Scatterplot */}
                <Col span={16}>
                    <div ref={svgContainerRef} style={{ height: '300px' }}></div>
                    <LassoSelection
                        svgRef={svgContainerRef}
                        targetItems={'.dr-circle'}
                        onSelect={handleSelection}
                    />
                </Col>

                {/* Config forms stacked vertically */}
                <Col span={7}>
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