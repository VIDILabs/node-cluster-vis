"""HTTP API for the cluster-based visual analytics dashboard.

Routes take query parameters rather than path segments so that metric names
containing spaces, slashes, or other awkward characters survive the round trip
without the caller having to escape them by hand.

Every response is derived from whichever dataset is currently loaded; see
``datasource.py`` for what counts as a valid source.
"""
import json
import os
from timeit import default_timer as timer

import numpy as np
import pandas as pd
from flask import Flask, jsonify, request
from flask_compress import Compress
from flask_cors import CORS

import config
import datasource
from datasource import DataSourceError
from mrdmd import (
    BaselineWindowError, get_mrdmd, get_mrdmd_with_new_base, read_cached_baselines,
)
from scripts import pipeline
from state import store

NODE = config.NODE_COLUMN
TIME = config.TIME_COLUMN

app = Flask(__name__)
CORS(app, origins=config.CORS_ORIGINS)
# The series payload is long, highly repetitive JSON — the same node ids and
# timestamp prefixes over and over — and compresses about 7:1. At the sample's
# 1-minute cadence that is 30MB down to 4MB on the wire, which decides whether
# a first load over a network is tolerable. Off by default in Flask, so it has
# to be asked for.
Compress(app)


# --- helpers ---------------------------------------------------------------

@app.errorhandler(DataSourceError)
def handle_source_error(error):
    return jsonify({'error': str(error)}), error.status


@app.errorhandler(BaselineWindowError)
def handle_baseline_window_error(error):
    return jsonify({'error': str(error)}), error.status


class TimeWindowError(ValueError):
    """A time-scoped window that holds too little to analyse."""

    status = 422


@app.errorhandler(TimeWindowError)
def handle_time_window_error(error):
    return jsonify({'error': str(error)}), error.status


def _scoped_frame():
    """The dataset frame, narrowed to ``start``/``end`` when both are given.

    Returns ``(frame, cache_key)``. The key carries the window, because every
    cached artifact downstream — DR1, DR2, baselines — describes the rows it was
    computed from; reusing the full-range embedding for a window would show the
    wrong thing rather than fail.

    Absent bounds mean the whole range, which is what every caller got before
    time scoping existed.
    """
    dataset = store.dataset
    start, end = request.args.get('start'), request.args.get('end')
    if not start or not end:
        return dataset.frame, dataset.key()

    start, end = _naive_timestamp(start), _naive_timestamp(end)
    if start > end:
        start, end = end, start

    frame = dataset.frame
    frame = frame[(frame[TIME] >= start) & (frame[TIME] <= end)]

    stamps = frame[TIME].nunique()
    nodes = frame[NODE].nunique()
    # Both floors, named separately: which one you hit tells you whether to
    # widen the window or move it. Nodes ramp in over a run, so an early window
    # can be long and still nearly empty.
    if stamps < config.MRDMD_MIN_BASELINE_COLUMNS or nodes < config.WINDOW_MIN_NODES:
        raise TimeWindowError(
            f'That time range holds {nodes} node{"" if nodes == 1 else "s"} over '
            f'{stamps} timestamp{"" if stamps == 1 else "s"}; the analysis needs at '
            f'least {config.WINDOW_MIN_NODES} nodes over '
            f'{config.MRDMD_MIN_BASELINE_COLUMNS} timestamps. Widen the selection.'
        )

    # Integer nanoseconds: stable across processes and safe in a filename.
    return frame, f'{dataset.key()}_w{start.value}_{end.value}'


def _csv_param(name, default=None):
    """Read a repeated-or-comma-joined query parameter into a list."""
    values = request.args.getlist(name)
    if len(values) == 1:
        values = values[0].split(',')
    cleaned = [v.strip() for v in values if v and v.strip()]
    return cleaned if cleaned else (default if default is not None else [])


def _int_param(name, default):
    try:
        return int(request.args.get(name, default))
    except (TypeError, ValueError):
        return default


def _naive_timestamp(value):
    """Parse a timestamp and drop any zone, matching the frame's naive index.

    Datasets carry wall-clock timestamps with no offset, so the index is
    ``datetime64[ns]`` and tz-naive. A client that sends an offset -- a browser
    calling ``Date.toISOString()`` is the obvious way -- yields a tz-aware
    Timestamp, and comparing the two raises ``TypeError: Invalid comparison
    between dtype=datetime64[ns] and Timestamp``: a 500 rather than a wrong
    answer. An offset is converted to UTC and then dropped, so a caller that
    insists on sending one still gets a defined result.
    """
    stamp = pd.to_datetime(value)
    if stamp.tzinfo is not None:
        stamp = stamp.tz_convert('UTC').tz_localize(None)
    return stamp


def _float_param(name, default):
    try:
        return float(request.args.get(name, default))
    except (TypeError, ValueError):
        return default


def _bool_param(name, default=False):
    raw = request.args.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ('1', 'true', 'yes', 'on')


def _known_metrics(requested):
    """Keep only metrics that exist, preserving the caller's order."""
    available = set(store.dataset.metrics)
    return [m for m in requested if m in available]


def _records(frame):
    """JSON-safe records: NaN/inf become null and timestamps become ISO strings."""
    out = frame.copy()
    for column in out.columns:
        if pd.api.types.is_datetime64_any_dtype(out[column]):
            out[column] = out[column].dt.strftime('%Y-%m-%dT%H:%M:%S')
    out = out.replace({np.nan: None, np.inf: None, -np.inf: None})
    return out.to_dict(orient='records')


def _with_downtime(frame, metrics):
    """Flag rows where every selected metric reads zero.

    Derived here rather than trusted from the source file so the flag means the
    same thing for every dataset.
    """
    frame = frame.copy()
    if metrics:
        frame['downtime'] = (frame[metrics] == 0).all(axis=1).astype(int)
    else:
        frame['downtime'] = 0
    return frame


# --- dataset management ----------------------------------------------------

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'datasetLoaded': store.is_loaded(),
        'dataset': store.dataset.name if store.is_loaded() else None,
    })


@app.route('/api/datasets', methods=['GET'])
def list_datasets():
    """Datasets discoverable on disk, plus a description of the active one."""
    return jsonify({
        'available': datasource.list_datasets(),
        'active': store.dataset.describe() if store.is_loaded() else None,
        'acceptsRemote': True,
        'schema': {
            'nodeColumn': NODE,
            'timeColumn': TIME,
            'nodeAliases': config.NODE_COLUMN_ALIASES,
            'timeAliases': config.TIME_COLUMN_ALIASES,
        },
    })


@app.route('/api/datasets/load', methods=['POST'])
def load_dataset_route():
    """Ingest from any source: a filename in the data dir, a path, or a URL.

    Body: ``{"source": "sample_metrics.csv"}`` or
    ``{"source": "https://example.org/telemetry.csv", "name": "prod"}``.
    """
    payload = request.get_json(silent=True) or {}
    source = payload.get('source') or request.args.get('source')
    if not source:
        raise DataSourceError('Provide a "source" (filename, path, or http(s) URL).')
    dataset = store.load(source, name=payload.get('name'))
    return jsonify(dataset.describe())


@app.route('/api/metadata', methods=['GET'])
def metadata():
    """Per-metric display metadata for the metrics actually present."""
    headers = store.headers
    metrics = store.dataset.metrics
    resolved = {}
    for metric in metrics:
        info = headers.get(metric, {})
        resolved[metric] = {
            'title': info.get('title', metric),
            'units': info.get('units', ''),
            'desc': info.get('desc', ''),
            'groups': info.get('groups', []),
        }
    return jsonify(resolved)


# --- raw series ------------------------------------------------------------

@app.route('/api/series', methods=['GET'])
def series():
    """Downsampled per-node series for the requested metrics.

    Query: ``metrics``, optional ``nodes``, optional ``maxPoints``.
    Sending only the requested columns, thinned to ``maxPoints`` samples per
    node, is what keeps this response small on multi-hundred-megabyte inputs.
    """
    dataset = store.dataset
    metrics = _known_metrics(_csv_param('metrics', dataset.metrics))
    nodes = _csv_param('nodes')

    frame = dataset.frame
    if nodes:
        frame = frame[frame[NODE].isin(nodes)]

    frame = frame[[NODE, TIME] + metrics]
    frame = _with_downtime(frame, metrics)
    frame = datasource.downsample(frame, _int_param('maxPoints', config.SERIES_MAX_POINTS))

    return jsonify({
        'data': _records(frame),
        'metrics': metrics,
        'allMetrics': dataset.metrics,
        'nodes': sorted(frame[NODE].unique().tolist()),
        'start': datasource._iso(dataset.start),
        'end': datasource._iso(dataset.end),
    })


@app.route('/api/cluster-averages', methods=['GET'])
def cluster_averages():
    """Mean of each metric per cluster over time, for the sparkline column.

    Computed here because doing it in the browser means shipping every raw row
    to the client and re-reducing it on each render.
    """
    dataset = store.dataset
    metrics = _known_metrics(_csv_param('metrics', dataset.metrics))
    bin_seconds = _int_param('binSeconds', 60)
    max_points = _int_param('maxPoints', 60)

    assignments = store.cluster_assignments
    if assignments is None or assignments.empty:
        return jsonify({})

    # Scoped like the embedding: the sparklines sit beside the contribution bars
    # and would otherwise describe a different span than the bars do.
    scoped, _ = _scoped_frame()
    frame = scoped[[NODE, TIME] + metrics].merge(assignments, on=NODE, how='inner')
    if frame.empty:
        return jsonify({})

    bucket = frame[TIME].dt.floor(f'{max(bin_seconds, 1)}s')
    grouped = frame.groupby(['Cluster', bucket], sort=True)[metrics].mean().reset_index()
    grouped = grouped.rename(columns={grouped.columns[1]: TIME})

    result = {metric: {} for metric in metrics}
    for cluster, chunk in grouped.groupby('Cluster', sort=True):
        chunk = chunk.sort_values(TIME)
        if len(chunk) > max_points:
            stride = int(np.ceil(len(chunk) / max_points))
            chunk = chunk.iloc[::stride]
        stamps = chunk[TIME].dt.strftime('%Y-%m-%dT%H:%M:%S').tolist()
        for metric in metrics:
            values = chunk[metric].replace({np.nan: None, np.inf: None, -np.inf: None})
            result[metric][int(cluster)] = [
                {'timestamp': t, 'value': v}
                for t, v in zip(stamps, values.tolist())
            ]
    return jsonify(result)


def _baseline_bands(metrics, cache_key):
    """``metric -> (v_min, v_max)`` for the baseline currently in effect.

    The client sends the baselines it is actually displaying, because the window
    is editable: a drag or a typed bound has to move the timeline's in-baseline
    row too, and the server's cache still holds the automatically derived one.
    Anything the client does not send falls back to that cache, and a metric
    with neither is left out of the test entirely rather than being treated as
    unbounded.
    """
    bands = {}

    cached = read_cached_baselines(cache_key)
    if not cached.empty:
        for row in cached.itertuples(index=False):
            bands[row.feature] = (float(row.v_min), float(row.v_max))

    raw = request.args.get('baselines')
    if raw:
        try:
            for entry in json.loads(raw):
                feature = entry.get('feature')
                v_min, v_max = float(entry['v_min']), float(entry['v_max'])
                if feature and v_min <= v_max:
                    bands[feature] = (v_min, v_max)
        except (TypeError, ValueError, KeyError):
            # A malformed override is not worth a 400: the cached bands are a
            # correct, if stale, answer, and the strip stays on screen.
            pass

    return {m: bands[m] for m in metrics if m in bands}


# --- data coverage ---------------------------------------------------------

@app.route('/api/coverage', methods=['GET'])
def coverage():
    """Per-cluster reporting coverage and blank readings over the time range.

    Query: optional ``nodes`` (restrict to a selection), ``bins``, ``metrics``,
    and ``baselines`` (a JSON array of the windows currently in effect).

    Three things per cluster and bucket. ``active`` is how many of its nodes
    reported at all — a node that stops reporting simply has no rows, so absence
    cannot be read off the metric values. ``blank``/``readings`` is how many of
    the readings it should have produced were null, NaN, or exactly 0.0, which
    is what a NaN looks like once the upstream export has filled it in.
    ``inBaseline`` is how many of the *reporting* nodes had every real reading
    inside its metric's baseline value band.
    """
    dataset = store.dataset
    nodes = _csv_param('nodes')
    assignments = store.cluster_assignments

    # Which metrics decide whether a row carries a reading. Defaults to all of
    # them; the UI passes the metrics it is currently showing.
    scoped = [m for m in _csv_param('metrics') if m in dataset.metrics]
    if not scoped:
        scoped = list(dataset.metrics)

    frame = dataset.frame[[NODE, TIME] + scoped]
    if nodes:
        frame = frame[frame[NODE].isin(nodes)]
    if frame.empty or pd.isna(dataset.start) or pd.isna(dataset.end):
        return jsonify({
            'times': [], 'binSeconds': 0, 'clusters': [],
            'nodeCount': 0, 'metrics': scoped,
        })

    # Blankness is counted per *reading* — one (node, metric, timestamp) cell —
    # not per row. Requiring a node's whole row to be blank meant it had to be
    # zero across every selected metric simultaneously, which essentially never
    # happens: in the bundled sample no row is all-zero, yet `mem_free`,
    # `bytes_out` and `proc_run` each have a timestamp where every node reads 0,
    # and `cpu_wio` has three where more than half do. Those are the drops that
    # are plainly visible in the line charts, and the row rule found none of them.
    #
    # NaN counts as blank too, and stays in the denominator: it is a reading
    # that was expected and did not arrive.
    values = frame[scoped]
    blank_cells = values.isna() | (values == 0)
    blanks_per_row = blank_cells.sum(axis=1).to_numpy()
    # A node is "reporting" in a bucket when at least one of its readings there
    # is a real value. A wholly blank row does not count as presence.
    row_reports = blanks_per_row < len(scoped)

    # "Within baseline behaviour" is a *node* verdict, not a per-reading one: a
    # node counts only when every real reading it produced lies inside that
    # metric's baseline value band. The strict rule is affordable here — on the
    # bundled sample it spans the full 0..1 range with a standard deviation of
    # 0.37 across (cluster, bucket) cells, so the row has real contrast rather
    # than sitting at one shade. (A node with no banded reading at all is not a
    # pass by default; it is simply not counted.)
    bands = _baseline_bands(scoped, store.key)
    banded = [m for m in scoped if m in bands]
    if banded:
        real = (~blank_cells[banded]).to_numpy()
        readings = values[banded].to_numpy(dtype=float)
        low = np.array([bands[m][0] for m in banded], dtype=float)
        high = np.array([bands[m][1] for m in banded], dtype=float)
        outside = real & ((readings < low) | (readings > high))
        row_in_baseline = row_reports & real.any(axis=1) & ~outside.any(axis=1)
    else:
        row_in_baseline = np.zeros(len(frame), dtype=bool)

    bins = max(_int_param('bins', config.COVERAGE_BINS), 1)
    span = (dataset.end - dataset.start).total_seconds()
    bin_seconds = max(int(np.ceil(span / bins)), 1) if span > 0 else 1

    edges = pd.date_range(
        start=dataset.start.floor(f'{bin_seconds}s'), end=dataset.end, freq=f'{bin_seconds}s'
    )
    if len(edges) == 0:
        edges = pd.DatetimeIndex([dataset.start])

    slot = pd.Index(edges).get_indexer(frame[TIME].dt.floor(f'{bin_seconds}s'))

    work = pd.DataFrame({
        NODE: frame[NODE].to_numpy(),
        'slot': slot,
        'blank': blanks_per_row,
        'readings': len(scoped),
        'reports': row_reports,
        'inBaseline': row_in_baseline,
    })
    work = work[work['slot'] >= 0]
    # One entry per (node, bucket), as before — but carrying the verdict, so a
    # node with several rows in a bucket counts as in-baseline only if all of
    # them were. `min` over booleans is that AND.
    present = (work.loc[work['reports'], [NODE, 'slot', 'inBaseline']]
                   .groupby([NODE, 'slot'], as_index=False)['inBaseline'].min())

    if assignments is not None and not assignments.empty:
        work = work.merge(assignments, on=NODE, how='left')
        present = present.merge(assignments, on=NODE, how='left')
        # Sized from every node in scope, not only the reporting ones, so a
        # cluster that is entirely blank still gets a row instead of vanishing.
        membership = assignments[assignments[NODE].isin(work[NODE].unique())]
        sizes = membership.groupby('Cluster')[NODE].nunique()
    else:
        work['Cluster'] = 0
        present['Cluster'] = 0
        sizes = pd.Series({0: int(work[NODE].nunique())})

    work = work.dropna(subset=['Cluster'])
    present = present.dropna(subset=['Cluster'])

    counts = present.groupby(['Cluster', 'slot']).size()
    in_base_counts = present[present['inBaseline']].groupby(['Cluster', 'slot']).size()
    blanks = work.groupby(['Cluster', 'slot'])[['blank', 'readings']].sum()

    clusters_out = []
    for cluster, size in sizes.items():
        active = np.zeros(len(edges), dtype=int)
        if cluster in counts.index.get_level_values(0):
            chunk = counts.loc[cluster]
            active[chunk.index.to_numpy()] = chunk.to_numpy()

        in_baseline = np.zeros(len(edges), dtype=int)
        if cluster in in_base_counts.index.get_level_values(0):
            chunk = in_base_counts.loc[cluster]
            in_baseline[chunk.index.to_numpy()] = chunk.to_numpy()

        blank = np.zeros(len(edges), dtype=int)
        readings = np.zeros(len(edges), dtype=int)
        if cluster in blanks.index.get_level_values(0):
            chunk = blanks.loc[cluster]
            blank[chunk.index.to_numpy()] = chunk['blank'].to_numpy()
            readings[chunk.index.to_numpy()] = chunk['readings'].to_numpy()

        clusters_out.append({
            'cluster': int(cluster),
            'nodeCount': int(size),
            'active': active.tolist(),
            # Denominator for the in-baseline row is `active`, not `nodeCount`:
            # a node that is not reporting is not misbehaving, and scoring it
            # against the cluster's full membership would darken every outage.
            'inBaseline': in_baseline.tolist(),
            # Per-cluster gap row: blank readings out of the readings the
            # cluster should have produced in that bucket.
            'blank': blank.tolist(),
            'readings': readings.tolist(),
        })

    return jsonify({
        'times': edges.strftime('%Y-%m-%dT%H:%M:%S').tolist(),
        'binSeconds': bin_seconds,
        'clusters': sorted(clusters_out, key=lambda c: c['cluster']),
        'nodeCount': int(present[NODE].nunique()),
        'metrics': scoped,
    })


# --- dimensionality reduction ---------------------------------------------

def _dr_payload(n_neighbors, min_dist, num_clusters, force_recompute):
    frame, cache_key = _scoped_frame()
    df, used = pipeline.get_dr_time(
        frame, cache_key, n_neighbors, min_dist, num_clusters,
        force_recompute=force_recompute,
    )
    df = store.align_clusters(df)

    fc_start = timer()
    contributions = pipeline.get_feat_contributions(df)
    print(f'ccpca in {timer() - fc_start:.3f}s')

    return {
        'dr_features': _records(df.reset_index(drop=True)),
        'node_cluster_map': _records(df[[NODE, 'Cluster']].reset_index(drop=True)),
        'feat_contributions': contributions,
        # What the auto-tuner actually settled on, so the controls can show it.
        'params': used,
    }


# 0 (or absent) means "choose from the data"; see params.py.
def _requested_params():
    return (
        _int_param('n_neighbors', 0),
        _float_param('min_dist', -1.0),
        _int_param('num_clusters', 0),
    )


@app.route('/api/dr', methods=['GET'])
def dr():
    """Two-step DR embedding, cluster labels, and ccPCA feature contributions."""
    n_neighbors, min_dist, num_clusters = _requested_params()
    return jsonify(_dr_payload(n_neighbors, min_dist, num_clusters, _bool_param('force', False)))


@app.route('/api/clusters', methods=['GET'])
def clusters():
    """Re-label the cached embedding for a new k without re-running DR."""
    n_neighbors, min_dist, num_clusters = _requested_params()

    if _bool_param('force', False):
        return jsonify(_dr_payload(n_neighbors, min_dist, num_clusters, True))

    frame, cache_key = _scoped_frame()
    df, used = pipeline.recompute_clusters(
        cache_key, frame[NODE].nunique(), num_clusters, n_neighbors, min_dist
    )
    if df is None:
        # Nothing cached for these parameters yet, so fall back to a full pass
        # instead of failing the request.
        return jsonify(_dr_payload(n_neighbors, min_dist, num_clusters, False))

    df = store.align_clusters(df)
    return jsonify({
        'dr_features': _records(df.reset_index(drop=True)),
        'node_cluster_map': _records(df[[NODE, 'Cluster']].reset_index(drop=True)),
        'feat_contributions': pipeline.get_feat_contributions(df),
        'params': used,
    })


# --- mrDMD ----------------------------------------------------------------

@app.route('/api/mrdmd', methods=['GET'])
def mrdmd_route():
    """Per-node deviation from a metric baseline.

    Query: ``nodes``, ``metrics``, optional ``recomputeBase``. Supplying
    ``vMin``/``vMax``/``bStart``/``bEnd`` scores against that explicit baseline
    instead of the automatically derived one.
    """
    metrics = _known_metrics(_csv_param('metrics'))
    nodes = _csv_param('nodes')

    if not metrics:
        return jsonify({'zscores': [], 'baselines': []})

    # Scoped the same way as the embedding, and keyed the same way: a baseline
    # cached over the full range describes behaviour the window never saw.
    frame, cache_key = _scoped_frame()
    if nodes:
        frame = frame[frame[NODE].isin(nodes)]
    frame = frame[[NODE, TIME] + metrics]

    if frame.empty:
        return jsonify({'zscores': [], 'baselines': []})

    b_start = request.args.get('bStart')
    b_end = request.args.get('bEnd')
    has_explicit_base = all(
        request.args.get(k) is not None for k in ('vMin', 'vMax')
    ) and b_start and b_end

    if has_explicit_base:
        zscores, baselines = get_mrdmd_with_new_base(
            frame,
            metrics[0],
            _float_param('vMin', 0.0),
            _float_param('vMax', 0.0),
            _naive_timestamp(b_start),
            _naive_timestamp(b_end),
        )
    else:
        zscores, baselines = get_mrdmd(
            frame, cache_key, _bool_param('recomputeBase', False)
        )

    return jsonify({
        'zscores': _records(zscores) if not zscores.empty else [],
        'baselines': _records(baselines) if not baselines.empty else [],
    })


# --- streaming -------------------------------------------------------------

@app.route('/api/stream/next', methods=['POST'])
def stream_next():
    """Append the next batch file and return refreshed DR + mrDMD results.

    Batches are read in order from ``config.BATCH_DIR``; a 404 means the
    sequence is exhausted.
    """
    payload = request.get_json(silent=True) or {}
    metrics = _known_metrics(payload.get('metrics') or [])
    nodes = payload.get('nodes') or []

    index = store.stream_index
    filename = f'batch_{index:03d}.csv'
    path = os.path.join(config.BATCH_DIR, filename)
    if not os.path.isfile(path):
        return jsonify({
            'status': 'exhausted',
            'message': f'No batch file at {filename}.',
        }), 404

    store.append(pd.read_csv(path))
    dataset = store.dataset

    # Same auto sentinels as the GET routes: 0/-1 means "derive from the data".
    n_neighbors = int(payload.get('n_neighbors') or 0)
    min_dist = float(payload.get('min_dist', -1.0))
    num_clusters = int(payload.get('num_clusters') or 0)

    dr_results = _dr_payload(n_neighbors, min_dist, num_clusters, False)

    frame = dataset.frame
    if nodes:
        frame = frame[frame[NODE].isin(nodes)]
    if metrics and not frame.empty:
        zscores, baselines = get_mrdmd(frame[[NODE, TIME] + metrics], dataset.key(), True)
        mrdmd_results = {
            'zscores': _records(zscores) if not zscores.empty else [],
            'baselines': _records(baselines) if not baselines.empty else [],
        }
    else:
        mrdmd_results = {'zscores': [], 'baselines': []}

    series_frame = dataset.frame[[NODE, TIME] + metrics] if metrics else dataset.frame[[NODE, TIME]]
    series_frame = datasource.downsample(_with_downtime(series_frame, metrics))

    return jsonify({
        'status': 'success',
        'batch': filename,
        'nextBatch': store.stream_index,
        'data': _records(series_frame),
        'dr_results': dr_results,
        'mrdmd_results': mrdmd_results,
    })


@app.route('/api/stream/status', methods=['GET'])
def stream_status():
    index = store.stream_index
    available = 0
    if os.path.isdir(config.BATCH_DIR):
        available = len([f for f in os.listdir(config.BATCH_DIR) if f.endswith('.csv')])
    return jsonify({
        'nextBatch': index,
        'available': available,
        'exhausted': index >= available,
    })


def bootstrap():
    """Load the startup dataset. A failure here is logged, not fatal.

    Leaving the server up lets an operator ingest a working source through the
    API instead of having to fix configuration and restart.
    """
    config.ensure_dirs()
    pipeline.clear_cache()
    try:
        store.load(datasource.default_dataset_name())
    except DataSourceError as exc:
        print(f'Startup dataset not loaded: {exc}')


bootstrap()

if __name__ == '__main__':
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG)
