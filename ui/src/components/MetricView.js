import * as d3 from 'd3';
import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { Switch, Space } from 'antd';
import LineChart from './LineChart.js';
import api from '../api.js';
import { colorScale, COLORS } from '../utils/colors.js';
import { CHART_FONT } from '../config.js';
import { toNaiveISO } from '../utils/time.js';
import { byContribution } from '../utils/contributions.js';

// Room for the scroller's own scrollbar. The baseline boxes are the rightmost
// thing in this panel, so without it an overlay scrollbar — one that takes no
// layout width — prints straight over the End and Max fields.
const SCROLLBAR_GUTTER = 14;

const MetricView = ({ data, timeRange, selectedDims, selectedPoints, fcs, zScores, setzScores, setBaselines, baselines, baselinesRef, onBaselineChange, onError, scopeRef, nodeClusterMap, headerMap, hiddenClusters }) => {
    const chartsRef = useRef([]);
    const selectedTimeRange = timeRange;
    const [showBaselines, setShowBaselines] = useState(true);

    // The timeline brush applies its range by mutating each chart's scale in
    // place, so nothing but the live d3 object knew about it — and the next
    // redraw rebuilt the scale from `timeRange` and threw the zoom away. The
    // charts read this first, so a redraw keeps the window the user brushed.
    const timeDomainRef = useRef(null);
    // A new dataset (or a new derived window) retires the brushed one.
    useEffect(() => { timeDomainRef.current = null; }, [timeRange]);

    // `updateBaseline` is a prop of every LineChart and their draw effect
    // depends on it, so its identity must survive a baseline commit. Reading
    // the list from a ref is what keeps it stable; taking `baselines` as a
    // dependency redrew every chart on every commit, which is exactly how the
    // brushed domain was being lost.
    const baselinesListRef = useRef(baselines);
    useEffect(() => { baselinesListRef.current = baselines; }, [baselines]);
    
    useEffect(() => {
      const handleTimeDomainUpdate = (event) => {
        const newDomain = event.detail;
        timeDomainRef.current = newDomain;

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
      // Kept so a rejected window can be put back. The boxes and the brush
      // rectangle both read from these, so leaving a rejected window on screen
      // would show a baseline the z-scores were never computed against.
      const previousEntry = baselinesRef.current[field];
      const previousList = baselinesListRef.current;

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

      // Built from the prop rather than inside a functional update because the
      // timeline needs the same array: which nodes count as "within baseline"
      // is decided by this window, so its middle row has to be refetched
      // against it, and `baselines` state has not committed yet at this point.
      // Two edits cannot land in one tick — a commit needs a blur or an
      // Enter — so reading the prop is not a stale-closure risk here.
      const next = previousList.some(b => b.feature === field)
        ? previousList.map(b => (
            b.feature === field ? { ...b, b_start, b_end, v_min, v_max } : b
          ))
        : [...previousList, { feature: field, b_start, b_end, v_min, v_max }];

      setBaselines(next);
      onBaselineChange?.(next);
      api.mrdmd({
        nodes: selectedPoints,
        metrics: [field],
        vMin: v_min,
        vMax: v_max,
        bStart: b_start,
        bEnd: b_end,
        // Scored over the same rows as everything else when Time Scope is on;
        // a baseline drawn outside that window then has nothing to decompose
        // and comes back as a 422, which is the honest answer.
        ...(scopeRef?.current || {}),
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
        .then(() => onError?.(null))
        .catch(error => {
          console.error('Could not update baseline:', error);
          // A window too short for mrDMD to decompose comes back as a 422 with
          // a specific message; anything else still leaves the baseline
          // unchanged on the server, so the client has to agree.
          if (previousEntry) baselinesRef.current[field] = previousEntry;
          else delete baselinesRef.current[field];
          setBaselines(previousList);
          onBaselineChange?.(previousList);
          onError?.(`Could not update the ${field} baseline: ${error.message}`);
        });
    }, [baselinesRef, onBaselineChange, onError, scopeRef, selectedPoints, setBaselines, setzScores]);

    // Back to the window the server derived. The automatic baseline is exactly
    // what the parquet cache holds — `process_baseline` never writes a manual
    // one back — so asking for the metric with no explicit bounds returns it,
    // along with the z-scores scored against it.
    const resetBaseline = useCallback((field) => {
      api.mrdmd({ nodes: selectedPoints, metrics: [field], ...(scopeRef?.current || {}) })
        .then(payload => {
          const restored = payload.baselines?.find(b => b.feature === field);
          if (!restored) throw new Error('the server returned no baseline for it');

          baselinesRef.current[field] = {
            baselineX: [new Date(restored.b_start), new Date(restored.b_end)],
            baselineY: [restored.v_min, restored.v_max],
          };

          const list = baselinesListRef.current;
          const next = list.some(b => b.feature === field)
            ? list.map(b => (b.feature === field ? { ...b, ...restored } : b))
            : [...list, restored];
          setBaselines(next);
          onBaselineChange?.(next);

          if (payload.zscores) {
            setzScores(prevZScores => {
              const updates = new Map(payload.zscores.map(d => [d.nodeId, d[field]]));
              return prevZScores.map(d => {
                if (!updates.has(d.nodeId)) return d;
                const value = updates.get(d.nodeId);
                const isValid = value !== null && value !== undefined && value !== "";
                return { ...d, [field]: isValid ? parseFloat(value) : d[field] };
              });
            });
          }
          onError?.(null);
        })
        .catch(error => {
          console.error('Could not reset baseline:', error);
          onError?.(`Could not reset the ${field} baseline: ${error.message}`);
        });
    }, [baselinesRef, onBaselineChange, onError, scopeRef, selectedPoints, setBaselines, setzScores]);

    // Newly loaded metrics are prepended, so the first match is the live one.
    const baselineFor = (field) => baselines?.find(b => b.feature === field);

    // The charts run in the metric list's order, not in whatever order metrics
    // were switched on. Reading a chart means finding its metric in the list
    // first, and two different orders make that a search rather than a glance.
    // `selectedDims` is the *selection*, which is arrival-ordered — the list is
    // the ordering, and both go through `byContribution` to get it.
    const orderedDims = useMemo(() => byContribution(fcs, selectedDims), [fcs, selectedDims]);

    if (!data || !baselines) return null;

    // height:100% fills the card; the max-height is a floor under it so a height
    // chain that fails to resolve scrolls rather than running the charts off the
    // bottom of the page.
    return (
      <div style={{
        overflow: 'auto',
        height: '100%',
        maxHeight: 'calc(100vh - 190px)',
        minHeight: 0,
        // Everything in here — the charts, the baseline boxes, the legend —
        // ends flush with this edge, which is where the scrollbar sits. The
        // padding keeps the boxes clear of an overlay scrollbar, which takes no
        // layout width and so simply prints over whatever is under it;
        // `scrollbar-gutter` reserves the space up front for a classic one, so
        // the charts don't reflow the moment the list grows past the panel.
        paddingRight: `${SCROLLBAR_GUTTER}px`,
        scrollbarGutter: 'stable',
      }}>
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          flexWrap: 'wrap',
          justifyContent: 'flex-end', 
          marginBottom: '8px',
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
        {nodeClusterMap.size > 0 && orderedDims.map((field, index) => {
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
                    resetBaseline={resetBaseline}
                    timeDomainRef={timeDomainRef}
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