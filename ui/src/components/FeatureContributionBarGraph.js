import * as d3 from 'd3';
import { useEffect, useRef } from 'react';
import { colorScale } from '../utils/colors.js';

const SIZE = { width: 400, height: 400 };

export default function FeatureContributionBarGraph({ feature, fcData, graphId }) {
    const featureSvgRef = useRef();
    const AXIS_TICK_FONT_SIZE = 50;
    useEffect(() => {
        if (!featureSvgRef.current || !fcData ) return;
        // Clear graph for updates due to fcData (cluster ID) changes
        d3.select(featureSvgRef.current).selectAll('*').remove()

        // console.log(feature, graphId, fcData);
        const margin = { top: 20, right: 0, bottom: 20, left: 0 };
        const xDomain = [-1, 1];
        const xScale = d3.scaleLinear()
            .domain(xDomain)
            .range([margin.left, SIZE.width - margin.right]);
        const y = d3.scaleBand()
            .domain(fcData.map(d => d.cluster))
            .range([margin.top, SIZE.height - margin.bottom])
            .paddingInner(0.2);

        const svg = d3.select(featureSvgRef.current)
            .append("svg")
            .attr('id', `matrix-svg`)
            .attr("width", "100%")
            .attr("height", "100%")
            .attr("viewBox", `0 0 ${SIZE.width} ${SIZE.height}`)
            .attr("preserveAspectRatio", "xMidYMid meet");
        
        /* Uncomment and adjust margin.top to display x axis */
        // svg.append('g')
        //     .attr('transform', `translate(0, ${margin.top})`)
        //     .call(d3.axisTop(xScale).tickValues([-1, -0.5, 0, 0.5, 1]))
        //     .selectAll('text')
        //     .style("font-size", `${AXIS_TICK_FONT_SIZE}px`)
        //     .style("vertical-align", "middle");

        // Plot bars
        svg.append('g')
        .selectAll()
        .data(fcData)
        .join('rect')
            .attr('x', d => d.value >= 0 ? xScale(0) : xScale(d.value))
            .attr('y', (d,i) => y(d.cluster))
            .attr('width', d => Math.abs(xScale(d.value) - xScale(0)))
            .attr('height', (d,i) => y.bandwidth())
            .attr('fill', d => colorScale(d.cluster))
            .attr('opacity', 0.85)
            .append('title').text((d,i) => `Contribution to cluster ${d.cluster}: ${d.value.toFixed(4)}`)

        /* Uncomment below for */
        // // Cluster labels on left
        // const clusterLabels = svg.append('g')
        //     .attr('transform', `translate(0, 0)`)
        //     .call(d3.axisRight(y).tickSizeOuter(0).tickSizeInner(0).tickPadding(20));
        // clusterLabels.select(".domain") // Select the domain line
        //     .remove();
        // clusterLabels.selectAll('text')
        //     .style("font-size", `${AXIS_TICK_FONT_SIZE}px`)
        //     .style("font-weight", "bold")
        //     .style("vertical-align", "middle");
        
        // // Axis in middle
        // svg.append('g')
        //     .attr('transform', `translate(${(SIZE.width - margin.left - margin.right) / 2 + margin.left}, 0)`)
        //     .call(d3.axisRight(y).tickSizeOuter(0).tickValues([]))
        //     .selectAll('text')
        //     .style("font-size", `${AXIS_TICK_FONT_SIZE}px`)
        //     .style("font-weight", "bold")
        //     .style("vertical-align", "middle");
        
        // Plot cluster y axis
        svg.append('g')
            .attr('transform', `translate(${(SIZE.width - margin.left - margin.right) / 2 + margin.left}, 0)`)
            .call(d3.axisRight(y).tickSizeOuter(0).tickSizeInner(0).tickPadding(20).tickFormat(d => `c${d}`))
            .selectAll('text')
            .style("font-size", `${AXIS_TICK_FONT_SIZE}px`)
            .style("font-weight", "bold")
            .style("vertical-align", "middle");

        // Add drop shadow to labels for visibility
        const defs = svg.append("defs");

        const filter = defs.append("filter")
            .attr("id", "white-shadow")
            .attr("x", "-50%")
            .attr("y", "-50%")
            .attr("width", "150%")
            .attr("height", "150%");

        filter.append("feDropShadow")
            .attr("dx", 0)
            .attr("dy", 0)
            .attr("stdDeviation", 4)
            .attr("flood-color", "white")
            .attr("flood-opacity", 0.75);

        svg.selectAll(".tick text")
            .attr("filter", "url(#white-shadow)")
            .style("fill", "black");

        svg.selectAll(".tick text")
            .attr("filter", "url(#white-shadow)")
            .style("fill", "black");
        
        svg.selectAll(".cluster-title")
            .attr("filter", "url(#white-shadow)")
            .style("fill", "black");
      }, [fcData]);
    
      return (
        <svg id={graphId} ref={featureSvgRef} style={{width: '60%', height: 100}}></svg>
        );

};