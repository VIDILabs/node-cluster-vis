"""Pluggable data ingestion.

A "source" is anything that resolves to a table with a node column, a timestamp
column, and at least one numeric metric column:

    * a bare filename inside ``config.DATA_DIR``   -> ``sample_metrics.csv``
    * an absolute or relative path on disk         -> ``/srv/telemetry/day1.csv``
    * an ``http(s)`` URL                           -> ``https://host/export.csv``

Everything else in the server talks to :class:`Dataset`, so adding a new backing
store only means teaching :func:`load_dataset` how to reach the bytes.
"""
import hashlib
import os
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
import pandas as pd

import config

READABLE_SUFFIXES = ('.csv', '.parquet', '.pq')


class DataSourceError(Exception):
    """Raised when a source cannot be reached, parsed, or validated."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class Dataset:
    """A loaded, schema-normalized table plus the metadata the UI needs."""

    def __init__(self, name, source, frame, path=None):
        self.name = name
        self.source = source
        self.path = path
        self.frame = frame
        self.metrics = [
            c for c in frame.columns
            if c not in (config.NODE_COLUMN, config.TIME_COLUMN)
        ]
        self.nodes = sorted(frame[config.NODE_COLUMN].astype(str).unique().tolist())
        times = pd.to_datetime(frame[config.TIME_COLUMN], errors='coerce')
        self.start = times.min()
        self.end = times.max()

    def key(self):
        """Cache key: changes whenever the underlying rows change."""
        digest = hashlib.sha1()
        digest.update(str(self.source).encode('utf-8'))
        digest.update(str(self.frame.shape).encode('utf-8'))
        digest.update(str(self.start).encode('utf-8'))
        digest.update(str(self.end).encode('utf-8'))
        return digest.hexdigest()[:16]

    def suggested_config(self):
        """Sensible starting selections so a new dataset renders without hand-tuning.

        Picks the metrics that vary the most across nodes (the ones a clustering
        view is actually informative about) and a baseline window over the first
        fifth of the time range.
        """
        variances = {}
        for metric in self.metrics:
            series = pd.to_numeric(self.frame[metric], errors='coerce')
            spread = float(series.std(skipna=True) or 0.0)
            scale = float(abs(series.mean(skipna=True)) or 0.0) + 1e-9
            variances[metric] = spread / scale
        ranked = sorted(self.metrics, key=lambda m: variances.get(m, 0.0), reverse=True)
        selected_dims = ranked[:config.DEFAULT_MAX_METRICS]

        selected_points = self.nodes[:config.DEFAULT_MAX_NODES]

        b_start, b_end = self.start, self.end
        if pd.notna(b_start) and pd.notna(b_end) and b_end > b_start:
            b_end = b_start + (b_end - b_start) / 5

        return {
            'selectedDims': selected_dims,
            'selectedPoints': selected_points,
            'bStart': _iso(b_start),
            'bEnd': _iso(b_end),
            'nNeighbors': config.DEFAULT_N_NEIGHBORS,
            'minDist': config.DEFAULT_MIN_DIST,
            'numClusters': config.DEFAULT_NUM_CLUSTERS,
        }

    def describe(self):
        return {
            'name': self.name,
            'source': str(self.source),
            'rows': int(len(self.frame)),
            'nodes': self.nodes,
            'nodeCount': len(self.nodes),
            'metrics': self.metrics,
            'metricCount': len(self.metrics),
            'start': _iso(self.start),
            'end': _iso(self.end),
            'defaults': self.suggested_config(),
        }


def _iso(value):
    if value is None or pd.isna(value):
        return None
    return pd.Timestamp(value).isoformat()


# --- discovery -------------------------------------------------------------

def list_datasets():
    """Filenames available in the configured data directory."""
    if not os.path.isdir(config.DATA_DIR):
        return []
    names = []
    for entry in sorted(os.listdir(config.DATA_DIR)):
        full = os.path.join(config.DATA_DIR, entry)
        if os.path.isfile(full) and entry.lower().endswith(READABLE_SUFFIXES):
            names.append(entry)
    return names


SAMPLE_DATASET = 'sample_metrics.csv'


def default_dataset_name():
    """Which dataset to load at startup.

    Prefers an explicit NCV_DEFAULT_DATASET, then the bundled sample, then the
    smallest file present. Picking the smallest rather than the alphabetically
    first matters: a data directory holding a multi-gigabyte export would
    otherwise stall startup for minutes on a file nobody asked for.
    """
    if config.DEFAULT_DATASET:
        return config.DEFAULT_DATASET

    available = list_datasets()
    if not available:
        raise DataSourceError(
            f'No datasets found in {config.DATA_DIR}. Set NCV_DEFAULT_DATASET or add a CSV.',
            status=503,
        )
    if SAMPLE_DATASET in available:
        return SAMPLE_DATASET
    return min(available, key=lambda n: os.path.getsize(os.path.join(config.DATA_DIR, n)))


# --- fetching --------------------------------------------------------------

def _is_url(source):
    return str(source).lower().startswith(('http://', 'https://'))


def _check_remote_allowed(url):
    if '*' in config.ALLOWED_REMOTE_HOSTS:
        return
    host = urllib.parse.urlparse(url).hostname or ''
    if host not in config.ALLOWED_REMOTE_HOSTS:
        raise DataSourceError(
            f"Refusing to fetch from '{host}': not in NCV_ALLOWED_REMOTE_HOSTS.",
            status=403,
        )


def _fetch_remote(url):
    """Download to a cache file, refusing anything over the configured size cap."""
    _check_remote_allowed(url)
    config.ensure_dirs()
    name = hashlib.sha1(url.encode('utf-8')).hexdigest()[:16]
    suffix = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
    if suffix not in READABLE_SUFFIXES:
        suffix = '.csv'
    target = os.path.join(config.DOWNLOAD_DIR, name + suffix)

    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'node-cluster-vis'})
        with urllib.request.urlopen(request, timeout=config.REMOTE_TIMEOUT_SECONDS) as response:
            declared = response.headers.get('Content-Length')
            if declared and int(declared) > config.MAX_REMOTE_BYTES:
                raise DataSourceError(
                    f'Remote file is {declared} bytes, over the {config.MAX_REMOTE_BYTES} limit.',
                    status=413,
                )
            written = 0
            with open(target, 'wb') as handle:
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > config.MAX_REMOTE_BYTES:
                        handle.close()
                        os.remove(target)
                        raise DataSourceError(
                            f'Remote file exceeded the {config.MAX_REMOTE_BYTES} byte limit.',
                            status=413,
                        )
                    handle.write(chunk)
    except urllib.error.HTTPError as exc:
        raise DataSourceError(f'Source returned HTTP {exc.code} for {url}', status=502) from exc
    except urllib.error.URLError as exc:
        raise DataSourceError(f'Could not reach {url}: {exc.reason}', status=502) from exc

    return target


def resolve_path(source):
    """Turn any accepted source reference into a readable local path."""
    source = str(source).strip()
    if not source:
        raise DataSourceError('No source given.')
    if _is_url(source):
        return _fetch_remote(source)

    candidates = [source] if os.path.isabs(source) else [
        os.path.join(config.DATA_DIR, source),
        os.path.join(config.BASE_DIR, source),
        source,
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    raise DataSourceError(f"Source '{source}' was not found.", status=404)


# --- parsing + validation --------------------------------------------------

def _read_frame(path):
    suffix = os.path.splitext(path)[1].lower()
    try:
        if suffix in ('.parquet', '.pq'):
            return pd.read_parquet(path)
        return pd.read_csv(path)
    except Exception as exc:
        raise DataSourceError(f'Could not parse {os.path.basename(path)}: {exc}') from exc


def normalize(frame):
    """Rename aliases onto the canonical schema and coerce metric columns numeric.

    Returns the normalized frame. Raises :class:`DataSourceError` when the
    required columns or metrics are missing, which is the contract a deployment
    can rely on: any table with nodeId, timestamp and one metric will load.
    """
    frame = frame.copy()

    def adopt(canonical, aliases):
        if canonical in frame.columns:
            return
        for alias in aliases:
            if alias in frame.columns:
                frame.rename(columns={alias: canonical}, inplace=True)
                return

    adopt(config.NODE_COLUMN, config.NODE_COLUMN_ALIASES)
    adopt(config.TIME_COLUMN, config.TIME_COLUMN_ALIASES)

    missing = [c for c in (config.NODE_COLUMN, config.TIME_COLUMN) if c not in frame.columns]
    if missing:
        raise DataSourceError(
            f"Missing required column(s): {', '.join(missing)}. "
            f'Expected {config.NODE_COLUMN} and {config.TIME_COLUMN} '
            f'(or aliases) plus at least one metric column.',
            status=422,
        )

    discard = list(config.DROP_COLUMNS) + list(config.DERIVED_COLUMNS)
    frame.drop(columns=[c for c in discard if c in frame.columns], inplace=True)

    frame[config.NODE_COLUMN] = frame[config.NODE_COLUMN].astype(str)
    parsed_time = pd.to_datetime(frame[config.TIME_COLUMN], errors='coerce')
    if parsed_time.isna().all():
        raise DataSourceError(
            f"Column '{config.TIME_COLUMN}' could not be parsed as timestamps.", status=422
        )
    frame[config.TIME_COLUMN] = parsed_time

    metric_columns = [c for c in frame.columns if c not in (config.NODE_COLUMN, config.TIME_COLUMN)]
    for column in metric_columns:
        frame[column] = pd.to_numeric(frame[column], errors='coerce')

    # Drop columns that carry no signal; they only slow the DR pass down.
    keep = [c for c in metric_columns if frame[c].notna().any()]
    dropped = sorted(set(metric_columns) - set(keep))
    if dropped:
        print(f'Ignoring {len(dropped)} non-numeric/empty column(s): {", ".join(dropped[:8])}')
    frame = frame[[config.NODE_COLUMN, config.TIME_COLUMN] + keep]

    if not keep:
        raise DataSourceError(
            'No numeric metric columns found; at least one is required.', status=422
        )

    frame[keep] = frame[keep].fillna(0.0)
    frame = frame.dropna(subset=[config.TIME_COLUMN])
    # mrDMD and the DR pivots both require a unique (node, time) index.
    frame = frame.drop_duplicates(subset=[config.NODE_COLUMN, config.TIME_COLUMN], keep='last')
    return frame.sort_values([config.TIME_COLUMN, config.NODE_COLUMN]).reset_index(drop=True)


def load_dataset(source, name=None):
    """Fetch, parse, and validate a source into a :class:`Dataset`."""
    path = resolve_path(source)
    frame = normalize(_read_frame(path))
    return Dataset(name or os.path.basename(str(source)), source, frame, path=path)


def _read_header_file(path):
    import json
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError) as exc:
        print(f'Skipping header {os.path.basename(path)}: {exc}')
        return None


def load_headers(dataset_path=None):
    """Per-metric display metadata, keyed by metric name.

    Reads the shared headers directory, then overlays a ``<dataset>.headers.json``
    sidecar if one sits next to the data file. Missing metadata is never an
    error: the UI falls back to the raw metric name.
    """
    headers = {}

    if os.path.isdir(config.HEADERS_DIR):
        for entry in sorted(os.listdir(config.HEADERS_DIR)):
            if not entry.endswith('.json'):
                continue
            payload = _read_header_file(os.path.join(config.HEADERS_DIR, entry))
            if not isinstance(payload, dict):
                continue
            # A file may describe one metric (named after the file) or many.
            if 'title' in payload or 'desc' in payload or 'units' in payload:
                headers[entry[:-len('.json')]] = payload
            else:
                headers.update(payload)

    if dataset_path:
        sidecar = os.path.splitext(dataset_path)[0] + '.headers.json'
        if os.path.isfile(sidecar):
            payload = _read_header_file(sidecar)
            if isinstance(payload, dict):
                headers.update(payload)

    return headers


def downsample(frame, max_points=None):
    """Thin each node's series to at most ``max_points`` samples.

    Sending every raw sample to the browser is what makes the dashboard slow to
    load; stride-sampling per node keeps the shape of each line intact.
    """
    max_points = max_points or config.SERIES_MAX_POINTS
    node_count = max(frame[config.NODE_COLUMN].nunique(), 1)
    per_node = max(len(frame) // node_count, 1)
    if per_node <= max_points:
        return frame
    stride = int(np.ceil(per_node / max_points))
    # Vectorized stride per node — much cheaper than a groupby-apply on wide frames.
    position = frame.groupby(config.NODE_COLUMN, sort=False).cumcount()
    return frame[position % stride == 0].reset_index(drop=True)
