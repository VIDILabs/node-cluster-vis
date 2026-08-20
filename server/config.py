"""Environment-driven configuration.

Every path and tunable the server needs lives here so that nothing downstream has
to hardcode a filename, port, or directory. All values can be overridden with
environment variables, which is what makes the app deployable without code edits.
"""
import os

def _env(name, default):
    value = os.environ.get(name)
    return default if value is None or value == '' else value

def _env_int(name, default):
    try:
        return int(_env(name, default))
    except (TypeError, ValueError):
        return default

def _env_float(name, default):
    try:
        return float(_env(name, default))
    except (TypeError, ValueError):
        return default

def _env_bool(name, default):
    return str(_env(name, str(default))).strip().lower() in ('1', 'true', 'yes', 'on')

def _env_list(name, default):
    raw = _env(name, default)
    return [item.strip() for item in str(raw).split(',') if item.strip()]

# Anchor relative paths to this file, not the process CWD, so the server can be
# started from anywhere (systemd, gunicorn, container) instead of only ./server.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def _resolve(path):
    return path if os.path.isabs(path) else os.path.normpath(os.path.join(BASE_DIR, path))

# --- Filesystem ------------------------------------------------------------
DATA_DIR = _resolve(_env('NCV_DATA_DIR', 'data'))
HEADERS_DIR = _resolve(_env('NCV_HEADERS_DIR', os.path.join(DATA_DIR, 'headers')))
BATCH_DIR = _resolve(_env('NCV_BATCH_DIR', os.path.join(DATA_DIR, 'batch')))
CACHE_DIR = _resolve(_env('NCV_CACHE_DIR', os.path.join('scripts', 'cache')))
DOWNLOAD_DIR = _resolve(_env('NCV_DOWNLOAD_DIR', os.path.join(CACHE_DIR, 'remote')))

# --- HTTP ------------------------------------------------------------------
HOST = _env('NCV_HOST', '127.0.0.1')
PORT = _env_int('NCV_PORT', 5010)
DEBUG = _env_bool('NCV_DEBUG', True)
CORS_ORIGINS = _env_list('NCV_CORS_ORIGINS', '*')

# --- Data source -----------------------------------------------------------
# Dataset loaded at startup. May be a bare filename inside DATA_DIR, an absolute
# path, or an http(s) URL. Empty means "pick the first dataset discovered".
DEFAULT_DATASET = _env('NCV_DEFAULT_DATASET', '')
# Remote fetches are refused unless the host matches one of these. '*' disables
# the check; keep it narrow in production so the endpoint can't be used as a proxy.
ALLOWED_REMOTE_HOSTS = _env_list('NCV_ALLOWED_REMOTE_HOSTS', '*')
REMOTE_TIMEOUT_SECONDS = _env_int('NCV_REMOTE_TIMEOUT', 30)
MAX_REMOTE_BYTES = _env_int('NCV_MAX_REMOTE_BYTES', 512 * 1024 * 1024)

# --- Schema ----------------------------------------------------------------
# Required columns, plus the aliases we transparently rename onto them so that
# differently-shaped exports (env logs, ganglia) load without bespoke branches.
NODE_COLUMN = _env('NCV_NODE_COLUMN', 'nodeId')
TIME_COLUMN = _env('NCV_TIME_COLUMN', 'timestamp')
NODE_COLUMN_ALIASES = _env_list('NCV_NODE_ALIASES', 'cname_processed,node,node_id,hostname')
TIME_COLUMN_ALIASES = _env_list('NCV_TIME_ALIASES', 'time_secs,time,ts,datetime')
# Columns that are identifiers rather than measurements.
DROP_COLUMNS = _env_list('NCV_DROP_COLUMNS', 'cname_id')
# Columns the server derives itself. Dropped on ingest so a dataset that already
# carries one can't disagree with what we compute, and so they never pollute the
# metric list or the DR pass.
DERIVED_COLUMNS = _env_list('NCV_DERIVED_COLUMNS', 'downtime')

# --- Analysis defaults -----------------------------------------------------
# These are only the floor the auto-tuner falls back to. With AUTO_PARAMS on
# (the default) the UMAP neighbourhood and k are derived from the data itself —
# see pipeline.suggest_umap_params / pipeline.suggest_k — because a fixed
# n_neighbors=15 is meaningless on a 30-node dataset and far too tight on 5000.
AUTO_PARAMS = _env_bool('NCV_AUTO_PARAMS', True)
DEFAULT_N_NEIGHBORS = _env_int('NCV_N_NEIGHBORS', 15)
DEFAULT_MIN_DIST = _env_float('NCV_MIN_DIST', 0.1)
DEFAULT_NUM_CLUSTERS = _env_int('NCV_NUM_CLUSTERS', 4)
# Widest k the silhouette sweep will consider; also bounded by node count.
MAX_AUTO_CLUSTERS = _env_int('NCV_MAX_AUTO_CLUSTERS', 10)
# How much silhouette score the sweep will give up to pick a smaller k. 0 makes
# it a plain arg-max, which over-splits on UMAP embeddings — see params.suggest_k.
K_TOLERANCE = _env_float('NCV_K_TOLERANCE', 0.05)
# 0 means "select every metric/node". Small deployments want the whole picture
# up front; the caps exist for datasets wide enough that everything-on is unusable.
DEFAULT_MAX_METRICS = _env_int('NCV_MAX_METRICS', 12)
DEFAULT_MAX_NODES = _env_int('NCV_MAX_NODES', 0)
DR1_METHOD = _env('NCV_DR1_METHOD', 'PCA')
DR2_METHOD = _env('NCV_DR2_METHOD', 'UMAP')
RANDOM_SEED = _env_int('NCV_RANDOM_SEED', 42)

# Time buckets used by /api/coverage when the caller doesn't ask for a width.
COVERAGE_BINS = _env_int('NCV_COVERAGE_BINS', 240)

# --- mrDMD -----------------------------------------------------------------
MRDMD_MAX_LEVELS = _env_int('NCV_MRDMD_MAX_LEVELS', 9)
MRDMD_STEP = _env_int('NCV_MRDMD_STEP', 10000)
MRDMD_MAX_WORKERS = _env_int('NCV_MRDMD_MAX_WORKERS', 15)
# Share of nodes that must sit inside the IQR band for a timestamp to count as
# part of the baseline window. 1.0 restores the old unanimity rule, which starves
# heavy-tailed metrics of a usable window — see mrdmd.find_time_range.
MRDMD_BASELINE_COVERAGE = _env_float('NCV_MRDMD_BASELINE_COVERAGE', 0.9)
# Shortest baseline window mrDMD can decompose; below this we use the full range.
MRDMD_MIN_BASELINE_COLUMNS = _env_int('NCV_MRDMD_MIN_BASELINE_COLUMNS', 16)
# Floor for a time-scoped analysis window. Nodes come and go over a run — in the
# bundled sample only 7 of 120 are reporting in the first hour — so a narrow
# window legitimately holds very few, and UMAP on a handful of points describes
# nothing. The column floor is MRDMD_MIN_BASELINE_COLUMNS, since the baseline
# search has to fit inside the window too.
WINDOW_MIN_NODES = _env_int('NCV_WINDOW_MIN_NODES', 5)

# Number of points per series sent to the browser. Downsampling here is what
# keeps the payload small for multi-hundred-thousand-row datasets.
SERIES_MAX_POINTS = _env_int('NCV_SERIES_MAX_POINTS', 1500)

def ensure_dirs():
    for path in (CACHE_DIR, DOWNLOAD_DIR):
        os.makedirs(path, exist_ok=True)
