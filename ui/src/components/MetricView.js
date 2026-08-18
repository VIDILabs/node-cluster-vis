import * as d3 from 'd3';
import { useCallback, useState, useEffect, useRef } from 'react';
import { Switch, Space } from 'antd';
import LineChart from './LineChart.js';
import api from '../api.js';
import { colorScale, COLORS } from '../utils/colors.js';
import { CHART_FONT } from '../config.js';
import { toNaiveISO } from '../utils/time.js';

const MetricView = ({ data, timeRange, selectedDims, selectedPoints, zScores, setzScores, setBaselines, baselines, baselinesRef, nodeClusterMap, headerMap, hiddenClusters }) => {
    const chartsRef = useRef([]);
    const selectedTimeRange = timeRange;
    const [showBaselines, setShowBaselines] = useState(true);
    
    useEffect(() => {
      const handleTimeDomainUpdate = (event) => {
        const newDomain = event.detail;

        chartsRef.current.forEach(({ chartEl, xScale, yScale, lines, field, brushGroup }) => {
          if (!chartEl || !lines) return;

          xScale.domain(newDomain);
          
          chartEl.select('.x-axis')
            .call(d3.axisBottom(xScale)
            .ticks(6)
            .tickFormat(d3.timeFormat("%H:%M")))
            .selectAll("text").style("font-size", `${CHART_FONT.axis}px`);

          const lineGenerator = d3.line()
            .x(p => xScale(new Date(p.timestamp)))
            .y(p => yScale(p.value));

          // Every point, not just the ones inside the window. The chart has a
          // clip path over the plot area, so anything outside is hidden
          // anyway — and dropping those points made each line begin at the
          // first sample *inside* the range instead of crossing the boundary,
          // which left a visible gap between the y-axis and the start of the
          // data.
          lines.attr('d', d => (d && d[1] ? lineGenerator(d[1]) : null));

          const baseline = baselinesRef.current[field];
          if (baseline && brushGroup) {
              const x0 = xScale(new Date(baseline.baselineX[0]));
              const x1 = xScale(new Date(baseline.baselineX[1]));
              const yTop = yScale(baseline.baselineY[1]);
              const yBottom = yScale(baseline.baselineY[0]);

              // Only move if it's visible in the new range
              const [rMin, rMax] = xScale.range();
              if (x1 >= rMin && x0 <= rMax) {
                  brushGroup.call(d3.brush().move, [[x0, yTop], [x1, yBottom]]);
              } else {
                  brushGroup.call(d3.brush().move, null);
              }
          }
        });
      };

      window.addEventListener('time-domain-updated', handleTimeDomainUpdate);
      return () => window.removeEventListener('time-domain-updated', handleTimeDomainUpdate);
    }, [baselinesRef]);

    // Updating line chart colors on cluster config
    useEffect(() => {
      if (!nodeClusterMap || chartsRef.current.length === 0) return;

      chartsRef.current.forEach(({ chartEl }) => {
        chartEl.selectAll('.line')
          .transition()
          .duration(300)
          .attr('stroke', function() {
            const nodeId = d3.select(this).attr('nodeId');
            const clusterId = nodeClusterMap.get(nodeId);
            return colorScale(clusterId); 
          });
      });
    }, [nodeClusterMap]);

    // Stable identity: LineChart depends on this in an effect, so recreating it
    // every render would redraw each chart on every parent update.
    const registerChart = useCallback((chartObj) => {
      // Replace the entry for this field rather than appending: LineChart
      // re-registers on every redraw, so pushing grew the list without bound and
      // made the shared time-domain handler work on stale chart handles.
      const existing = chartsRef.current.findIndex(c => c.field === chartObj.field);
      if (existing === -1) chartsRef.current.push(chartObj);
      else chartsRef.current[existing] = chartObj;
    }, []);

    const updateBaseline = useCallback((field, newBaseline) => {
      baselinesRef.current[field] = newBaseline;
      const [start, end] = newBaseline.baselineX;
      const [v_min, v_max] = newBaseline.baselineY;

      // Naive wall clock, *not* toISOString(). The server's timestamps carry no
      // zone and its frame index is naive, so a `Z`-suffixed string parses to a
      // tz-aware Timestamp that pandas refuses to compare against it — every
      // manual baseline change 500'd with "Invalid comparison between
      // dtype=datetime64[ns] and Timestamp". This hands back the same wall
      // clock the server sent.
      const b_start = toNaiveISO(start);
      const b_end = toNaiveISO(end);

      // updating baselines
      setBaselines(prevBaselines => {
        const exists = prevBaselines.some(b => b.feature === field);
      
        if (exists) {
          return prevBaselines.map(b =>
            b.feature === field
              ? { ...b, b_start, b_end, v_min, v_max }
              : b
          );
        } else {
          return [
            ...prevBaselines,
            { feature: field, b_start, b_end, v_min, v_max }
          ];
        }
      });
      api.mrdmd({
        nodes: selectedPoints,
        metrics: [field],
        vMin: v_min,
        vMax: v_max,
        bStart: b_start,
        bEnd: b_end,
      })
        .then(payload => {
          if (!payload.zscores) return;
          setzScores(prevZScores => {
            const updates = new Map(payload.zscores.map(d => [d.nodeId, d[field]]));
            return prevZScores.map(d => {
              if (!updates.has(d.nodeId)) return d;
              const value = updates.get(d.nodeId);
              const isValid = value !== null && value !== undefined && value !== "";
              return { ...d, [field]: isValid ? parseFloat(value) : d[field] };
            });
          });
        })
        .catch(error => console.error('Could not update baseline:', error));
    }, [baselinesRef, selectedPoints, setBaselines, setzScores]);

    // Newly loaded metrics are prepended, so the first match is the live one.
    const baselineFor = (field) => baselines?.find(b => b.feature === field);

    if (!data || !baselines) return null;

    // height:100% fills the card; the max-height is a floor under it so a height
    // chain that fails to resolve scrolls rather than running the charts off the
    // bottom of the page.
    return (
      <div style={{ overflow: 'auto', height: '100%', maxHeight: 'calc(100vh - 190px)', minHeight: 0 }}>
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          flexWrap: 'wrap',
          justifyContent: 'flex-end', 
          marginBottom: '8px', 
          marginRight: '10px',
          position: 'sticky',
          top: 0,
          zIndex: 10,
          backgroundColor: 'white',
        }}>
          {/* Legend */}
          <div style={{
            width: '12px',
            height: '12px',
            backgroundColor: COLORS.default,
            marginRight: '8px',
            border: '1px solid '+COLORS.default,
            borderRadius: '2px'
          }} />
          <span style={{ fontSize: '14px', paddingRight: '10px' }}>Baseline Region</span>
          <Space>
            <Switch 
                size="small" 
                checked={showBaselines} 
                onChange={(checked) => setShowBaselines(checked)} 
            />
          </Space>
        </div>
        {nodeClusterMap.size > 0 && selectedDims.map((field, index) => {
            return (
                <LineChart 
                    key={`chart-${field}`}
                    data={data[field]}
                    field={field} 
                    // The entry, not the whole array: LineChart is memoized, and
                    // `updateBaseline` rebuilds only the edited metric's entry,
                    // so the other charts keep the identity they had and do not
                    // redraw. Passing the array would redraw all of them on
                    // every drag. It is also what makes the number boxes follow
                    // a drag at all — a ref mutation alone re-renders nothing.
                    baseline={baselineFor(field)}
                    baselinesRef={baselinesRef}
                    selectedTimeRange={selectedTimeRange}
                    updateBaseline={updateBaseline}
                    nodeClusterMap={nodeClusterMap}
                    metadata={headerMap[field]}
                    registerChart={registerChart}
                    showBaselines={showBaselines}
                    selectedPoints={selectedPoints}
                    hiddenClusters={hiddenClusters}
                />
            );
        })}
      </div>
    );
};

export default MetricView;