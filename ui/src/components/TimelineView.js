import { Card } from "antd";
import * as d3 from 'd3';
import { useCallback, useEffect, useRef, useState } from 'react';
import { colorScale, COLORS } from '../utils/colors.js';

// Fixed chart insets; these never varied at runtime.
const MARGIN = { top: 5, right: 10, bottom: 20, left: 50 };

const TimelineView = ({ data, bStart, bEnd, nodeDataStart, nodeDataEnd, nodeClusterMap }) => {
    const svgContainerRef = useRef();
    const [brushStart, setBrushStart] = useState(new Date(bStart));
    const [brushEnd, setBrushEnd] = useState(new Date(bEnd));

    const drawChart = useCallback((data) => {
      d3.select(svgContainerRef.current).selectAll("*").remove();

      const container = svgContainerRef.current;
      const width = container.clientWidth;
      const height = container.clientHeight || 120;
      
      const svg = d3.select(svgContainerRef.current)
                .append("svg")
                .attr('id', `context-window`)
                .attr('class', 'context')
                .attr("width", "100%")
                .attr("height", "100%")
                .attr("viewBox", `0 0 ${width} ${height}`)
                .attr("preserveAspectRatio", "xMidYMid meet");

      const xScale = d3
        .scaleTime()
        .domain([new Date(nodeDataStart), new Date(nodeDataEnd)])
        .range([MARGIN.left, width - MARGIN.right - MARGIN.left])
      
      const yScale = d3
        .scaleBand()
        .domain(data.map(d => d.cluster))
        .range([MARGIN.top, height- MARGIN.bottom])
        .padding(0.4);

      const xAxis = d3.axisBottom(xScale).tickFormat(d3.timeFormat("%H:%M"));
      const yAxis = d3.axisLeft(yScale);

      svg.append("g")
        .attr('class', 'x-axis')
        .attr("transform", `translate(0,${height - MARGIN.bottom})`)
        .call(xAxis)
        .selectAll("text")
          .style("font-size", "12px");
      
      const yAxisGroup = svg.append("g")
        .attr('class', 'y-axis')
        .attr("transform", `translate(${MARGIN.left}, 0)`)
        .call(yAxis.tickFormat(d => `c${d}`));

      yAxisGroup.selectAll("text")
        .style("fill", d => colorScale(+d))
        .style('font-weight', 'bold')
        .style("font-size", "12px");

      svg.append("text")
        .attr("transform", `rotate(-90)`)
        .attr("x", -height / 2)
        .attr("y", 10) 
        .attr("fill", "black")
        .attr("text-anchor", "middle")
        .style("font-size", "14px")
        .text("Cluster");

      data.forEach(d => {
        const rawWidth = xScale(d.end) - xScale(d.start);
        const minWidth = 1;
        const finalWidth = Math.max(rawWidth, minWidth);

        svg.append("rect")
          .attr("x", xScale(d.start))
          .attr("y", yScale(d.cluster))
          .attr("width", finalWidth)
          .attr("height", yScale.bandwidth())
          .attr("fill", COLORS.select)
          .attr("opacity", 0.7); 
      });

      // adding brush
      const defaultWindow = [
        xScale(brushStart),
        xScale(brushEnd)
      ]

      const earliestNodeDataTime = xScale(new Date(nodeDataStart)) || 0;

      const brush = d3.brushX(xScale)
        .extent([
          [Math.max(MARGIN.left, earliestNodeDataTime), MARGIN.top],
          [width - MARGIN.right - 20, height - MARGIN.bottom - 1]
        ])
        .on('end', (event) => {
            const selection = event.selection;
            if (selection) {
                const [start, end] = selection.map(xScale.invert);
                setBrushStart(start);
                setBrushEnd(end);
                window.dispatchEvent(
                  new CustomEvent('time-domain-updated', { detail: [start, end] })
                );
            }
        })
    
        svg.append('g')
          .attr('class', 'x-brush')
          //.attr('transform', `translate(0, ${-MARGIN.top})`)
          .call(brush)
          .call(brush.move, defaultWindow)
    }, [brushStart, brushEnd, nodeDataStart, nodeDataEnd]);
    
    useEffect(() => {
      if (!svgContainerRef.current || !data || !nodeDataStart || !nodeDataEnd ) return;
      drawChart(data);
    }, [data, nodeClusterMap, nodeDataStart, nodeDataEnd, drawChart]);

    return  (
        <Card title="TIME DOMAIN VIEW" size="small" style={{ height: 'auto', width: '100%' }}>
           <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'flex-end', 
              marginBottom: '8px', 
              marginRight: '10px' 
            }}>
              <div style={{
                width: '12px',
                height: '12px',
                backgroundColor: COLORS.select,   
                marginRight: '8px',
                border: '1px solid '+COLORS.select,
                borderRadius: '2px'
              }} />
              <span style={{ fontSize: '14px' }}>Downtime</span>
            </div>
            <div ref={svgContainerRef} style={{ width: '100%', height: '100px' }}></div>
        </Card>
    );
  };
    
    
export default TimelineView;
