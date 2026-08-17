import * as d3 from 'd3';

export const COLORS = {
    default: '#cececeff',
    select: '#F6828C',
    highlight: '#a4c8ddff',
    unassigned: '#9e9e9e'
};

// Dark2 is the base palette; Set2 extends it with the same hue order at a lighter
// value, so clusters beyond the eighth stay distinguishable instead of all
// collapsing to grey. Cluster count is user-controlled (2..20), so the scale has
// to cover the whole range rather than a fixed set of four.
const PALETTE = [...d3.schemeDark2, ...d3.schemeSet2];

export const colorScheme = PALETTE;

export const colorScale = (clusterId) => {
    const index = Number(clusterId);
    if (!Number.isFinite(index) || index < 0) return COLORS.unassigned;
    return PALETTE[index % PALETTE.length];
};

// Z-score diverging scale, shared by the heatmap and its legend so the two can
// never drift apart.
export const Z_SCORE_DOMAIN = [5, 0, -5];

export const zScoreColor = d3.scaleDiverging()
    .interpolator(d3.interpolateRdBu)
    .domain(Z_SCORE_DOMAIN);

// SVG/CSS selectors reject ids that start with a digit or contain dots, which
// real node names routinely do. Escape before building a selector from one.
export const cssEscape = (value) => {
    const text = String(value);
    if (typeof window !== 'undefined' && window.CSS && window.CSS.escape) {
        return window.CSS.escape(text);
    }
    return text.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
};
