import { Button } from "antd";
import { colorScale } from '../utils/colors.js';

/**
 * One on/off button per cluster, coloured with the cluster's own colour so a
 * button and the marks it governs read as the same thing.
 *
 * Rendered exactly once, in the Node Similarity panel under the recompute
 * controls. The state lives in `App` because every other view honours it — the
 * heatmap drops those columns, the line charts drop those polylines, the
 * embedding drops those points, the timeline drops those rows, and the metric
 * list drops those bars and sparklines. Showing the same buttons in two panels
 * read as two independent filters that happened to move together.
 *
 * A single cluster gets no buttons — the only thing they could do is blank the
 * panel entirely.
 */
const ClusterToggles = ({ clusters, hidden, onToggle, label }) => {
    if (!clusters || clusters.length < 2) return null;

    return (
        <span style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'center',
            gap: '4px', marginTop: '8px'
        }}>
            {label ? (
                <span style={{
                    // Its own line: the buttons sit in a narrow column, so a
                    // leading label would leave one button stranded below.
                    flex: '0 0 100%', fontSize: '12px', color: '#666'
                }}>
                    {label}
                </span>
            ) : null}
            {clusters.map((cluster) => {
                const off = hidden.has(cluster);
                return (
                    <Button
                        key={cluster}
                        size="small"
                        aria-pressed={!off}
                        onClick={() => onToggle(cluster)}
                        style={{
                            padding: '0 8px',
                            height: '22px',
                            fontSize: '12px',
                            fontWeight: 'bold',
                            color: off ? '#999' : '#fff',
                            backgroundColor: off ? '#fff' : colorScale(cluster),
                            borderColor: off ? '#d9d9d9' : colorScale(cluster),
                        }}
                    >
                        c{cluster}
                    </Button>
                );
            })}
        </span>
    );
};

export default ClusterToggles;
