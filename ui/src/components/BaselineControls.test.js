/**
 * The baseline window as four editable fields.
 *
 * Every commit costs an mrDMD round trip for the metric, so what is pinned here
 * is mostly about *not* committing: no request for a value that didn't change,
 * none for a window that doesn't parse, and none for a range typed backwards.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import BaselineControls from './BaselineControls.js';
import { formatStamp, parseStamp } from '../utils/time.js';

const START = new Date(2024, 0, 1, 8, 30, 0);
const END = new Date(2024, 0, 1, 9, 45, 0);

const baseline = {
  feature: 'mem_free',
  b_start: START.toISOString(),
  b_end: END.toISOString(),
  v_min: 0.25,
  v_max: 12.5,
};

const box = (name) => screen.getByLabelText(`mem_free baseline ${name}`);

function draw(overrides = {}) {
  const onCommit = jest.fn();
  const onReset = jest.fn();
  const utils = render(
    <BaselineControls
      field="mem_free"
      baseline={baseline}
      onCommit={onCommit}
      onReset={onReset}
      {...overrides}
    />
  );
  return { onCommit, onReset, ...utils };
}

// Type into a field and leave it, which is what commits.
function edit(name, value) {
  const input = box(name);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('timestamp round-trip', () => {
  test('a formatted stamp parses back to the instant it came from', () => {
    expect(formatStamp(START)).toBe('2024-01-01 08:30:00');
    expect(+parseStamp(formatStamp(START))).toBe(+START);
    // Local, not UTC: the x-axis beside these boxes is local too, and an
    // offset between the two would have nothing on screen to explain it.
    expect(formatStamp(START)).toContain(String(START.getHours()).padStart(2, '0'));
  });

  test('a bare time keeps the day the field already had', () => {
    const parsed = parseStamp('10:15', START);
    expect(parsed.getFullYear()).toBe(2024);
    expect(parsed.getDate()).toBe(1);
    expect(parsed.getHours()).toBe(10);
    expect(parsed.getMinutes()).toBe(15);
    expect(parsed.getSeconds()).toBe(0);
  });

  test('junk is null rather than an Invalid Date', () => {
    expect(parseStamp('not a time')).toBeNull();
    expect(parseStamp('')).toBeNull();
    expect(parseStamp(undefined)).toBeNull();
  });
});

describe('BaselineControls', () => {
  test('the automatically computed window is what the fields open on', () => {
    draw();
    expect(screen.getByText('Baseline Configuration')).toBeInTheDocument();
    expect(box('minimum')).toHaveValue('0.25');
    expect(box('maximum')).toHaveValue('12.5');
    expect(box('start')).toHaveValue('2024-01-01 08:30:00');
    expect(box('end')).toHaveValue('2024-01-01 09:45:00');
  });

  test('an edited bound commits the whole window once', () => {
    const { onCommit } = draw();
    edit('maximum', '20');

    expect(onCommit).toHaveBeenCalledTimes(1);
    const [field, next] = onCommit.mock.calls[0];
    expect(field).toBe('mem_free');
    // The fields that were not touched travel with the one that was — the
    // server takes a window, not a delta.
    expect(next.baselineY).toEqual([0.25, 20]);
    expect(+next.baselineX[0]).toBe(+START);
    expect(+next.baselineX[1]).toBe(+END);
  });

  test('a time typed into the start field moves only that edge', () => {
    const { onCommit } = draw();
    edit('start', '08:00');

    expect(onCommit).toHaveBeenCalledTimes(1);
    const [, next] = onCommit.mock.calls[0];
    expect(next.baselineX[0].getHours()).toBe(8);
    expect(next.baselineX[0].getMinutes()).toBe(0);
    expect(+next.baselineX[1]).toBe(+END);
  });

  test('leaving a field untouched costs no round trip', () => {
    const { onCommit } = draw();
    fireEvent.blur(box('minimum'));
    fireEvent.blur(box('start'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('a backwards range is refused rather than sent', () => {
    const { onCommit } = draw();

    edit('maximum', '0.1');            // below the minimum
    expect(onCommit).not.toHaveBeenCalled();

    edit('end', '07:00');              // before the start
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('unparseable text is refused rather than sent', () => {
    const { onCommit } = draw();
    edit('start', 'yesterday-ish');
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('clearing a number field does not commit a silent zero', () => {
    // `Number(null)` is 0, and 0 is finite — so an emptied box used to read as
    // a deliberate zero bound.
    const { onCommit } = draw();
    edit('minimum', '');
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('dragging the rectangle refills the boxes', () => {
    const { rerender } = draw();

    // What updateBaseline puts back after a brush drag: a new entry object for
    // this metric only.
    const dragged = {
      ...baseline,
      b_start: new Date(2024, 0, 1, 10, 0, 0).toISOString(),
      v_max: 99,
    };
    rerender(<BaselineControls field="mem_free" baseline={dragged} onCommit={() => {}} />);

    expect(box('start')).toHaveValue('2024-01-01 10:00:00');
    expect(box('maximum')).toHaveValue('99');
  });
});

describe('resetting to the derived window', () => {
  test('the button names the metric it acts on', () => {
    const { onReset } = draw();
    fireEvent.click(screen.getByRole('button', { name: /reset default/i }));
    // One metric per chart, so the handler has to be told which one.
    expect(onReset).toHaveBeenCalledWith('mem_free');
  });

  test('it does not go through the commit path', () => {
    // Reset asks the server for the automatic window; it does not send the
    // values sitting in the boxes, so an edited-but-uncommitted draft must not
    // ride along with it.
    const { onCommit, onReset } = draw();
    fireEvent.change(screen.getByLabelText('mem_free baseline maximum'), {
      target: { value: '999' },
    });
    fireEvent.click(screen.getByRole('button', { name: /reset default/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('with nothing to reset to, the button is disabled', () => {
    const { container } = render(
      <BaselineControls field="mem_free" baseline={undefined} onCommit={() => {}} />
    );
    expect(container.querySelector('button')).toBeDisabled();
  });
});
