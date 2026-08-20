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
import DRView, { MIN_SIDE, STACK_GAP } from './DRPlot.js';

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

describe('DRPlot layout', () => {
  // jsdom does no layout, so the boxes the component measures are stubbed.
  // Imported rather than restated: a local copy of MIN_SIDE or the stack gap
  // goes stale the moment the design changes.
  function stubLayout({ width, height, controls }) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return this.classList?.contains('dr-stack') ? width : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() { return this.classList?.contains('dr-stack') ? height : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      // The controls are the div wrapping the parameter form.
      get() { return this.firstElementChild?.id === 'form-container' ? controls : 0; },
    });
  }

  afterEach(() => {
    delete HTMLElement.prototype.clientWidth;
    delete HTMLElement.prototype.clientHeight;
    delete HTMLElement.prototype.offsetHeight;
  });

  const side = (container) =>
    Number(container.querySelector('svg[id^="dr-chart-svg"]').getAttribute('width'));

  test('the plot is sized from the stack minus the controls, not from its own slot', () => {
    // Tall and narrow: the width binds, and the leftover height falls below the
    // controls rather than opening a gap above them.
    stubLayout({ width: 400, height: 900, controls: 260 });
    expect(side(draw(makeData(20)).container)).toBe(400);

    // Short: the controls' own height comes off the top of what the plot may
    // take. Measuring the slot instead — which absorbed the card's slack — gave
    // the plot the whole column and pushed the controls to the bottom of it.
    stubLayout({ width: 400, height: 500, controls: 260 });
    expect(side(draw(makeData(20)).container)).toBe(500 - 260 - STACK_GAP);

    // Past the floor the card scrolls; the plot does not keep shrinking.
    stubLayout({ width: 400, height: 300, controls: 260 });
    expect(side(draw(makeData(20)).container)).toBe(MIN_SIDE);
  });

  test('the plot is square and the controls sit below it', () => {
    const { container } = draw(makeData(20));

    // E1 and E2 are two axes of one embedding with no units of their own, so a
    // rectangular box stretches one of them and the distances the clustering is
    // read from stop being comparable between the two directions.
    const svg = container.querySelector('svg[id^="dr-chart-svg"]');
    expect(svg.getAttribute('width')).toBe(svg.getAttribute('height'));
    expect(svg.getAttribute('viewBox').split(' ').slice(2)).toEqual([
      svg.getAttribute('width'), svg.getAttribute('height'),
    ]);

    // Stacked, not side by side: the form used to set the panel's width and the
    // scatter got what was left, which is backwards.
    const stack = container.querySelector('.dr-stack');
    const slot = container.querySelector('.dr-plot-slot');
    expect(stack).toBeTruthy();
    expect(slot.parentElement).toBe(stack);
    const children = Array.from(stack.children);
    expect(children.indexOf(slot)).toBe(0);
    // The controls are the rest of the stack, under the plot.
    expect(children.length).toBeGreaterThan(1);
    expect(children[1].querySelector('#form-container')).toBeTruthy();
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
