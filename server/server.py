"""HTTP API for the cluster-based visual analytics dashboard.

Routes take query parameters rather than path segments so that metric names
containing spaces, slashes, or other awkward characters survive the round trip
without the caller having to escape them by hand.

Every response is derived from whichever dataset is currently loaded; see
``datasource.py`` for what counts as a valid source.
"""
import os
from timeit import default_timer as timer

import numpy as np
import pandas as pd
from flask import Flask, jsonify, request
from flask_cors import CORS

import config
import datasource
from datasource import DataSourceError
from mrdmd import get_mrdmd, get_mrdmd_with_new_base
from scripts import pipeline
from state import store

NODE = config.NODE_COLUMN
TIME = config.TIME_COLUMN

app = Flask(__name__)
CORS(app, origins=config.CORS_ORIGINS)


# --- helpers ---------------------------------------------------------------

@app.errorhandler(DataSourceError)
def handle_source_error(error):
    return jsonify({'error': str(error)}), error.status


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

    frame = dataset.frame[[NODE, TIME] + metrics].merge(assignments, on=NODE, how='inner')
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


# --- data coverage ---------------------------------------------------------

@app.route('/api/coverage', methods=['GET'])
def coverage():
    """Per-cluster reporting coverage and blank readings over the time range.

    Query: optional ``nodes`` (restrict to a selection), ``bins``, ``metrics``.

    Two things per cluster and bucket. ``active`` is how many of its nodes
    reported at all — a node that stops reporting simply has no rows, so absence
    cannot be read off the metric values. ``blank``/``readings`` is how many of
    the readings it should have produced were null, NaN, or exactly 0.0, which
    is what a NaN looks like once the upstream export has filled it in.
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
    })
    work = work[work['slot'] >= 0]
    present = work.loc[work['reports'], [NODE, 'slot']].drop_duplicates()

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
    blanks = work.groupby(['Cluster', 'slot'])[['blank', 'readings']].sum()

    clusters_out = []
    for cluster, size in sizes.items():
        active = np.zeros(len(edges), dtype=int)
        if cluster in counts.index.get_level_values(0):
            chunk = counts.loc[cluster]
            active[chunk.index.to_numpy()] = chunk.to_numpy()

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
    dataset = store.dataset
    df, used = pipeline.get_dr_time(
        dataset.frame, dataset.key(), n_neighbors, min_dist, num_clusters,
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

    dataset = store.dataset
    df, used = pipeline.recompute_clusters(
        dataset.key(), len(dataset.nodes), num_clusters, n_neighbors, min_dist
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
    dataset = store.dataset
    metrics = _known_metrics(_csv_param('metrics'))
    nodes = _csv_param('nodes')

    if not metrics:
        return jsonify({'zscores': [], 'baselines': []})

    frame = dataset.frame
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
            pd.to_datetime(b_start),
            pd.to_datetime(b_end),
        )
    else:
        zscores, baselines = get_mrdmd(
            frame, dataset.key(), _bool_param('recomputeBase', False)
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
