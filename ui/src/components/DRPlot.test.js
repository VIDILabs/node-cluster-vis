/**
 * That the embedding is actually painted.
 *
 * Points used to enter at opacity 0 and fade in over 800ms on an unnamed
 * transition. The update branch ran its own unnamed transition for position and
 * fill, so any redraw inside that window cancelled the fade and left every point
 * stuck at opacity 0 — present in the DOM, hit-testable by the lasso, and
 * completely invisible. Opacity is now set outright on every draw.
 */
import { render } from '@testing-library/react';
import DRView from './DRPlot.js';

function makeData(count) {
  return Array.from({ length: count }, (_, i) => ({
    nodeId: `node-${String(i).padStart(3, '0')}`,
    E1: Math.cos(i) * 10,
    E2: Math.sin(i) * 10,
    Cluster: i % 3,
  }));
}

const clusterMap = (count) => new Map(
  Array.from({ length: count }, (_, i) => [`node-${String(i).padStart(3, '0')}`, i % 3])
);

function draw(data, selectedPoints = [], hiddenClusters = undefined) {
  return render(
    <DRView
      data={data}
      type="time"
      selectedPoints={selectedPoints}
      nodeClusterMap={clusterMap(data.length)}
      handleRecompute={() => {}}
      updateSelectedNodes={() => {}}
      nNeighbors={11}
      minDist={0.1}
      numClusters={3}
      clusters={[0, 1, 2]}
      hiddenClusters={hiddenClusters || new Set()}
      onToggleCluster={() => {}}
    />
  );
}

const opacities = (container) =>
  Array.from(container.querySelectorAll('.dr-circle')).map(c => Number(c.style.opacity));

describe('DRPlot', () => {
  test('every point is painted on first draw', () => {
    const { container } = draw(makeData(20));
    const values = opacities(container);

    expect(values).toHaveLength(20);
    values.forEach(o => expect(o).toBe(1));
  });

  test('a redraw leaves the points visible rather than stuck mid-fade', () => {
    const { container, rerender } = draw(makeData(20));

    // Same nodes, new positions — the update branch. This is the redraw that
    // used to cancel the enter fade.
    const moved = makeData(20).map(d => ({ ...d, E1: d.E1 + 1 }));
    rerender(
      <DRView
        data={moved}
        type="time"
        selectedPoints={[]}
        nodeClusterMap={clusterMap(20)}
        handleRecompute={() => {}}
        updateSelectedNodes={() => {}}
        nNeighbors={11}
        minDist={0.1}
        numClusters={3}
      />
    );

    const values = opacities(container);
    expect(values).toHaveLength(20);
    values.forEach(o => expect(o).toBeGreaterThan(0));
  });

  test('selection dims the rest instead of hiding it', () => {
    const { container } = draw(makeData(20), ['node-000', 'node-001']);
    const values = opacities(container);

    expect(values).toHaveLength(20);
    expect(values.filter(o => o === 1)).toHaveLength(2);
    // Everything else is still on screen, just faded.
    values.forEach(o => expect(o).toBeGreaterThan(0));

    // Whatever dims a point temporarily restores from this.
    Array.from(container.querySelectorAll('.dr-circle'))
      .forEach(c => expect(c.getAttribute('data-rest-opacity')).toBeTruthy());
  });
});

describe('DRPlot cluster visibility', () => {
  const centres = (container) => Array.from(container.querySelectorAll('.dr-circle'))
    .map(c => `${c.getAttribute('cx')},${c.getAttribute('cy')}`);

  test('hiding a cluster drops its points and leaves the rest where they were', () => {
    const data = makeData(30);   // three clusters of ten
    const all = draw(data);
    const before = new Map(
      Array.from(all.container.querySelectorAll('.dr-circle')).map(c => [c.id, `${c.getAttribute('cx')},${c.getAttribute('cy')}`])
    );
    expect(before.size).toBe(30);

    const some = draw(data, [], new Set([1]));
    expect(some.container.querySelectorAll('.dr-circle')).toHaveLength(20);

    // The scales are built from the whole embedding, so hiding a cluster must
    // not re-fit the axes and shift every remaining point.
    Array.from(some.container.querySelectorAll('.dr-circle')).forEach((circle) => {
      expect(`${circle.getAttribute('cx')},${circle.getAttribute('cy')}`).toBe(before.get(circle.id));
    });

    // Gone from the DOM, not merely faded: the lasso hit-tests these, so a
    // dimmed point would still be selectable.
    expect(centres(some.container)).toHaveLength(20);
  });
});
