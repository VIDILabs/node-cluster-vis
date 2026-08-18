import { useCallback, useEffect, useState } from 'react';
import { Input, InputNumber } from 'antd';
import { CHART_FONT } from '../config.js';
import { formatStamp, parseStamp } from '../utils/time.js';

// Each box is sized to what it actually holds, in `ch` of its own type, rather
// than to a shared column width: a timestamp is `2024-01-01 08:30:00` and a
// bound is at most a value like `19556052.64`, so giving both the timestamp's
// width wasted a third of the gutter on every numeric field. The padding term
// is antd's small-input inset plus its border.
const FIELD_PAD = '18px';
const NUMBER_WIDTH = `calc(12ch + ${FIELD_PAD})`;
const STAMP_WIDTH = `calc(19ch + ${FIELD_PAD})`;

const draftFrom = (baseline) => ({
    vMin: baseline ? baseline.v_min : null,
    vMax: baseline ? baseline.v_max : null,
    start: baseline ? formatStamp(baseline.b_start) : '',
    end: baseline ? formatStamp(baseline.b_end) : '',
});

// Label beside the box, not above it. The four fields are one stack, so a
// single left-aligned column of labels reads as a list; labels on top doubled
// the height and made each pair look like a section of its own.
const Field = ({ label, children }) => (
    <>
        <label style={{
            fontSize: '11px', color: '#666', textAlign: 'right', whiteSpace: 'nowrap'
        }}>
            {label}
        </label>
        {children}
    </>
);

/**
 * The baseline window for one metric, as four editable fields.
 *
 * The same window the brush rectangle draws, from the other direction: dragging
 * is quick but imprecise, and the numbers it produces were previously only
 * legible by eye against the axis. Both write through the same `updateBaseline`,
 * so a drag refills these boxes and a commit here moves the rectangle.
 *
 * Committing costs an mrDMD round trip for the metric, so edits land on blur or
 * Enter rather than on each keystroke, and only when the value actually differs
 * from what is already in effect. An edit that doesn't parse, or that inverts
 * either range, reverts rather than being sent.
 */
const BaselineControls = ({ field, baseline, onCommit, disabled }) => {
    const [draft, setDraft] = useState(() => draftFrom(baseline));
    const [invalid, setInvalid] = useState({});

    // Dragging the rectangle is the other way into the same state, so the boxes
    // have to follow it. `baseline` is the entry from App's array, and only the
    // edited metric's entry is rebuilt, so this does not fire across the board.
    useEffect(() => {
        setDraft(draftFrom(baseline));
        setInvalid({});
    }, [baseline]);

    const commit = useCallback((next) => {
        if (!baseline) return;

        const start = parseStamp(next.start, new Date(baseline.b_start));
        const end = parseStamp(next.end, new Date(baseline.b_end));
        // An emptied InputNumber reports null, and `Number(null)` is 0 — which
        // is a perfectly finite number and would have committed a silent 0.
        const toNumber = (value) => (
            value === null || value === undefined || value === '' ? NaN : Number(value)
        );
        const vMin = toNumber(next.vMin);
        const vMax = toNumber(next.vMax);

        const bad = {
            start: !start,
            end: !end,
            vMin: !Number.isFinite(vMin),
            vMax: !Number.isFinite(vMax),
        };
        // A window has to have width in both directions, or mrDMD gets an empty
        // slice and the rectangle has nothing to draw.
        if (start && end && +start >= +end) { bad.start = true; bad.end = true; }
        if (Number.isFinite(vMin) && Number.isFinite(vMax) && vMin >= vMax) {
            bad.vMin = true; bad.vMax = true;
        }

        if (Object.values(bad).some(Boolean)) {
            setInvalid(bad);
            return;
        }
        setInvalid({});

        // Nothing moved — don't spend a round trip saying so.
        const unchanged = +start === +new Date(baseline.b_start)
            && +end === +new Date(baseline.b_end)
            && vMin === baseline.v_min
            && vMax === baseline.v_max;
        if (unchanged) {
            setDraft(draftFrom(baseline));
            return;
        }

        onCommit(field, { baselineX: [start, end], baselineY: [vMin, vMax] });
    }, [baseline, field, onCommit]);

    const numberProps = {
        size: 'small',
        // A metric in the millions steps by 1 with the arrows, which is not a
        // useful gesture; the keyboard is the only sensible way in.
        controls: false,
        disabled: disabled || !baseline,
        style: { width: NUMBER_WIDTH, fontSize: `${CHART_FONT.axis}px` },
    };
    const textProps = {
        size: 'small',
        disabled: disabled || !baseline,
        style: { width: STAMP_WIDTH, fontSize: `${CHART_FONT.axis}px` },
    };

    return (
        <div style={{
            flex: '0 0 auto',
            display: 'grid',
            // Both columns size to their content, so the labels sit in one
            // narrow column and the boxes keep their individual widths.
            gridTemplateColumns: 'auto auto',
            justifyContent: 'start',
            alignItems: 'center',
            columnGap: '6px',
            rowGap: '4px',
            paddingTop: '14px',   // sets the heading roughly level with the chart title
        }}>
            <div style={{
                gridColumn: '1 / -1',
                fontSize: '12px', fontWeight: 'bold', color: '#333', marginBottom: '2px',
            }}>
                Baseline Controls
            </div>

            <Field label="Min">
                <InputNumber
                    {...numberProps}
                    aria-label={`${field} baseline minimum`}
                    status={invalid.vMin ? 'error' : ''}
                    value={draft.vMin}
                    onChange={(value) => setDraft((d) => ({ ...d, vMin: value }))}
                    onBlur={() => commit(draft)}
                    onPressEnter={() => commit(draft)}
                />
            </Field>

            <Field label="Max">
                <InputNumber
                    {...numberProps}
                    aria-label={`${field} baseline maximum`}
                    status={invalid.vMax ? 'error' : ''}
                    value={draft.vMax}
                    onChange={(value) => setDraft((d) => ({ ...d, vMax: value }))}
                    onBlur={() => commit(draft)}
                    onPressEnter={() => commit(draft)}
                />
            </Field>

            <Field label="Start">
                <Input
                    {...textProps}
                    aria-label={`${field} baseline start`}
                    status={invalid.start ? 'error' : ''}
                    value={draft.start}
                    onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))}
                    onBlur={() => commit(draft)}
                    onPressEnter={() => commit(draft)}
                />
            </Field>

            <Field label="End">
                <Input
                    {...textProps}
                    aria-label={`${field} baseline end`}
                    status={invalid.end ? 'error' : ''}
                    value={draft.end}
                    onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))}
                    onBlur={() => commit(draft)}
                    onPressEnter={() => commit(draft)}
                />
            </Field>
        </div>
    );
};

export default BaselineControls;
