import os
from concurrent.futures import ThreadPoolExecutor
from timeit import default_timer as timer
import numpy as np
import pandas as pd
import sys

import config

# Resolve relative to this file so the server can be started from any directory.
sys.path.append(os.path.join(config.BASE_DIR, 'scripts', 'src'))
import mrdmd_zscore

ml = config.MRDMD_MAX_LEVELS
step = config.MRDMD_STEP
# `mrdmd_zscore.mrdmd` samples at 8x its cycle count and bails out with an empty
# node list when the window is shorter than that (`nyq = 8 * max_cycles`; both
# call sites pass `max_cycles=1`). An empty node list is not a degraded
# answer — `compute_zscore` then calls `min()` over it and raises — so the floor
# has to be enforced before the call, not recovered from after it.
MRDMD_MAX_CYCLES = 1
MIN_MRDMD_COLUMNS = 8 * MRDMD_MAX_CYCLES
std_baselines_dict = {}
NODE = config.NODE_COLUMN
TIME = config.TIME_COLUMN


class BaselineWindowError(ValueError):
    """A manually chosen baseline window mrDMD cannot decompose.

    Carries a 422 rather than a 500: the request was well formed, the window
    just does not hold enough samples, and the client can say so and put the
    previous window back.
    """

    status = 422


def _baseline_cache_path(dataset_key):
    config.ensure_dirs()
    return os.path.join(config.CACHE_DIR, f'mrdmd_baseline_{dataset_key}.parquet')


def preprocess(df, col):
    return df.pivot(index=NODE, columns=TIME, values=col) \
                .apply(pd.to_numeric, errors='coerce') \
                .ffill(axis='rows') \
                .bfill(axis='rows')

def compute_value_range(series, k=1.5, ext=0.1):
    """Finds the range capturing most of the data"""
    # computing IQR range for nonzero values
    q1, q3 = np.percentile(series, [25, 75])
    iqr = q3 - q1
    lower_bound = max(0, q1 - k * iqr)  # ensuring lower bound is not negative
    upper_bound = q3 + k * iqr
    lower = lower_bound - (lower_bound * ext)
    upper = upper_bound + (upper_bound * ext)
    return round(lower, 2), round(upper, 2)

def find_time_range(df, lower, upper):
    """
    Finds the longest contiguous time period where the values are within the
    baseline range (lower and upper). Returns its first and last timestamp.

    A column counts as in-range when at least ``MRDMD_BASELINE_COVERAGE`` of the
    nodes fall inside it, rather than every last one. Requiring unanimity does
    not survive a realistic node count: one outlier anywhere invalidates the
    whole timestamp, so on the 120-node sample the longest unanimous window for
    cpu_wio was five columns — too short for mrDMD to decompose, which made the
    metric disappear from the heatmap entirely. At 90% the same metric gets 20.

    A window shorter than ``MRDMD_MIN_BASELINE_COLUMNS`` is rejected in favour of
    the full range for the same reason: too few columns and the decomposition has
    no levels to produce.
    """
    coverage = config.MRDMD_BASELINE_COVERAGE
    minimum = config.MRDMD_MIN_BASELINE_COLUMNS

    in_range = ((df >= lower) & (df <= upper)).mean(axis=0) >= coverage

    longest_start, longest_end = None, None
    max_length = 0
    current_start = None

    for i, valid in enumerate(in_range.to_numpy()):
        if valid:
            if current_start is None:  # Start a new valid period
                current_start = i
        elif current_start is not None:
            length = i - current_start
            if length > max_length:  # Update longest period
                max_length = length
                longest_start, longest_end = current_start, i - 1
            current_start = None  # Reset for the next sequence

    # If the last sequence was the longest, update it
    if current_start is not None:
        length = len(df.columns) - current_start
        if length > max_length:
            max_length = length
            longest_start, longest_end = current_start, len(df.columns) - 1

    if longest_start is not None and max_length >= minimum:
        return df.columns[longest_start], df.columns[longest_end]

    print(
        f'Baseline window of {max_length} column(s) is below the {minimum} needed; '
        'falling back to the full time range.'
    )
    return pd.to_datetime(df.columns).min(), pd.to_datetime(df.columns).max()

# Running mrdmd on a single column with configured baseline (time and value range)
def process_baseline(df, col, bmin, bmax, sob, eob):
    # TODO: save new baseline to cache
    Z_final = []
    df_col = df.pivot(index=NODE, columns=TIME, values=col) \
                .apply(pd.to_numeric, errors='coerce') \
                .ffill(axis='rows') \
                .bfill(axis='rows')
    
    if sob is not None and eob is not None:
        df_col.columns = pd.to_datetime(df_col.columns)
        sob = pd.to_datetime(sob)
        eob = pd.to_datetime(eob)
        df_col = df_col.loc[:, (df_col.columns >= sob) & (df_col.columns <= eob)]

    # The automatic path never reaches this floor because `find_time_range`
    # rejects anything under MRDMD_MIN_BASELINE_COLUMNS. A hand-drawn window has
    # no such guarantee, and a brush drag across a chart opened on the default
    # 30-minute view holds only a handful of samples on a coarsely sampled
    # export. Unguarded, that surfaced as a 500 from deep inside compute_zscore.
    columns = df_col.shape[1]
    if columns < MIN_MRDMD_COLUMNS:
        raise BaselineWindowError(
            f'The baseline window holds {columns} sample'
            f'{"" if columns == 1 else "s"}; mrDMD needs at least '
            f'{MIN_MRDMD_COLUMNS} to decompose it. Widen the window.'
        )

    D = df_col.iloc[:,:].to_numpy()

    # run mrDMD
    mrDMDZSC = mrdmd_zscore.MrDMDZscore()
    nodes1 = mrDMDZSC.mrdmd(D, max_levels=ml, max_cycles=1, do_parallel=False)
    
    data = D.copy()
    data1 = data
    max_levels=ml
    splt = mrDMDZSC.get_splt(step, max_levels)
    nodes = nodes1
    baselines = []
    baseline_indx = []
    for i in range(data.shape[0]):
        t = data[i, :]
        if (min(t) >= bmin and max(t) <= bmax):
            baselines.append(t)
            baseline_indx.append(i)
    
    n_baseline_indx = [nb for nb in range(data.shape[0]) if nb not in baseline_indx]
   
   # compute z-score
    split_point = (data.shape[0] + 1) // 2
    baseline_indx = np.arange(0, split_point)
    n_baseline_indx = np.arange(split_point, data.shape[0])
    std_baselines = mrDMDZSC.compute_zscore(data1, \
                                            splt, \
                                            nodes, \
                                            baseline_indx, \
                                            n_baseline_indx, \
                                            for_baseline=True, \
                                            plot=False)

    std_baselines_df = pd.DataFrame({
        "feature": col,
        "b_start": sob,
        "b_end": eob,
        "v_min": bmin,
        "v_max": bmax,
        "z_score": std_baselines
    })
    
    Z_final.append(std_baselines_df)
    Z_final = pd.concat(Z_final, ignore_index=True)
    return Z_final

def process_columns_baseline(df):
    Z_final = []

    def process_single_column(col):
        # computing upper and lower baseline value range
        bmin, bmax = compute_value_range(df[col])
        if bmin == 0 and bmax == 0:
            mean = df[col].mean()
            std = df[col].std()
            bmin = 0 if (mean - std) < 0 else mean - std
            bmax = mean + std

        df_col = df.pivot(index=NODE, columns=TIME, values=col) \
                    .apply(pd.to_numeric, errors='coerce') \
                    .ffill(axis='rows') \
                    .bfill(axis='rows')
        
        # computing start and end of baseline and filter
        sob, eob = find_time_range(df_col, bmin, bmax)
            
        df_col.columns = pd.to_datetime(df_col.columns)
        sob = pd.to_datetime(sob)
        eob = pd.to_datetime(eob)
        df_col = df_col.loc[:, (df_col.columns >= sob) & (df_col.columns <= eob)]

        # extracting input, output matrices
        D = df_col.iloc[:,:].to_numpy()

        # run mrDMD
        mrDMDZSC = mrdmd_zscore.MrDMDZscore()
        nodes1 = mrDMDZSC.mrdmd(D, max_levels=ml, max_cycles=1, do_parallel=False)

        data = D.copy()
        data1 = data
        max_levels=ml
        splt = mrDMDZSC.get_splt(step, max_levels)
        nodes = nodes1
        baselines = []
        baseline_indx = []
        for i in range(data.shape[0]):
            t = data[i, :]
            if (min(t) >= bmin and max(t) <= bmax):
                baselines.append(t)
                baseline_indx.append(i)
        
        n_baseline_indx = [nb for nb in range(data.shape[0]) if nb not in baseline_indx]

        # compute z-score
        split_point = (data.shape[0] + 1) // 2
        baseline_indx = np.arange(0, split_point)
        n_baseline_indx = np.arange(split_point, data.shape[0])
        std_baselines = mrDMDZSC.compute_zscore(data1, \
                                                splt, \
                                                nodes, \
                                                baseline_indx, \
                                                n_baseline_indx, \
                                                for_baseline=True, \
                                                plot=False)

        if (len(std_baselines) == 0): std_baselines = [None]
        std_baselines_df = pd.DataFrame({
            "feature": col,
            "b_start": sob,
            "b_end": eob,
            "v_min": bmin,
            "v_max": bmax,
            "z_score": std_baselines
        })
        Z_final.append(std_baselines_df)

    cols_df = df.drop(columns=[NODE, TIME])
    with ThreadPoolExecutor(max_workers=config.MRDMD_MAX_WORKERS) as executor:
        futures = {
            executor.submit(process_single_column, col): col
            for col in cols_df.columns
        }
        for future in futures:
            try:
                future.result()
            except Exception as exc:
                # The results of executor.map() were never iterated, so anything
                # raised in a worker vanished without a trace and the metric just
                # went missing from the heatmap. Report it instead: one metric
                # failing to produce a baseline should not stop the others, but
                # it must not be silent either.
                print(f'[ERROR] Baseline failed for "{futures[future]}": '
                      f'{type(exc).__name__}: {exc}')


    Z_final = pd.concat(Z_final, ignore_index=True) if Z_final else pd.DataFrame(columns=["feature", "b_start", "b_end", "v_min", "v_max", "z_score"])
    return Z_final


def extract_baselines(df, nbase_df, baselines, col):
    if (baselines[baselines['feature'] == col].empty or (baselines[baselines['feature'] == col].z_score.values[0] is None)):
        print(f"[WARNING] No baseline found for column: {col}")
        return None 
    
    # extracting baseline, duplicating across time series
    b_start = pd.to_datetime(baselines.loc[baselines['feature'] == col, 'b_start'].values[0])
    b_end = pd.to_datetime(baselines.loc[baselines['feature'] == col, 'b_end'].values[0])
    b_diff = b_end - b_start

    t_start = pd.to_datetime(nbase_df.columns[0])
    t_end = pd.to_datetime(nbase_df.columns[-1])
    t_diff = t_end - t_start

    base_df = df[(pd.to_datetime(df[TIME]) >= b_start) \
               & (pd.to_datetime(df[TIME]) <= b_end)] \
                .pivot(index=NODE, columns=TIME, values=col) \
                .apply(pd.to_numeric, errors='coerce') \
                .ffill(axis='rows') \
                .bfill(axis='rows')

    base_ext = []
    for _ in range((len(nbase_df.columns) // base_df.shape[1]) + 2):
        base_ext.append(base_df)

    base_ext = pd.concat(base_ext,  axis=1)
    base_ext = base_ext.iloc[:, :len(nbase_df.columns)]
    base_ext.columns = nbase_df.columns

    D = nbase_df.to_numpy()
    return base_ext


def compute_zscores(df, baselines):
    Z_final = []
    
    def process_single_feature(col):
        # non-baselines
        nbase_df = preprocess(df, col)
        nodelist = nbase_df.index.tolist()

        if (len(baselines.columns) == 0):
             return pd.DataFrame()

        base_ext = extract_baselines(df, nbase_df, baselines[baselines['feature']==col], col)

        if (base_ext is None):
            return pd.DataFrame()
        
        D = nbase_df.to_numpy()
        D = np.vstack([D,base_ext])

        mrDMDZSC = mrdmd_zscore.MrDMDZscore()
        nodes1 = mrDMDZSC.mrdmd(D, max_levels=ml, max_cycles=1, do_parallel=False)

        # z-score analysis
        data = D.copy()
        data1 = data[:,:step]
        max_levels=ml
        splt = mrDMDZSC.get_splt(step, max_levels)
        nodes = nodes1
        n_baseline_indx = np.arange(0, data.shape[0] - base_ext.shape[0])
        baseline_indx = np.arange(len(n_baseline_indx), data.shape[0])

        std_baselines = baselines[baselines['feature'] == col].z_score.values[0]
        zsc = mrDMDZSC.compute_zscore(data1, \
                                    splt, \
                                    nodes1, \
                                    baseline_indx, \
                                    n_baseline_indx, \
                                    std_baselines, \
                                    for_baseline=False, \
                                    plot=False)
        
        values = zsc[0][:len(nodelist)]
        Z_df = pd.DataFrame({NODE: nodelist, col: values})
        return Z_df

    cols_df = df.drop(columns=[NODE, TIME])
    results = []
    with ThreadPoolExecutor(max_workers=config.MRDMD_MAX_WORKERS) as executor:
        futures = [executor.submit(process_single_feature, col) for col in cols_df.columns]
        for future in futures:
            res = future.result()
            if res is not None:
                results.append(res)

    if not results:
        print("Warning: No valid z-score results to concatenate.")
        return pd.DataFrame(columns=[NODE])

    Z_final = pd.concat(results, axis=1)
    cols = Z_final.columns
    if NODE in cols:
        Z_final = Z_final.loc[:, ~Z_final.columns.duplicated()]
    return Z_final

def read_cached_baselines(dataset_key):
    """Whatever baselines are already on disk, computing nothing.

    ``/api/coverage`` runs on every selection change and has a ~20ms budget, so
    it cannot afford to derive a baseline for a metric that has never been
    scored. A metric with no cached baseline is simply left out of the in-band
    test rather than being computed on the spot.
    """
    cache_path = _baseline_cache_path(dataset_key)
    if not os.path.exists(cache_path):
        return pd.DataFrame(columns=['feature', 'b_start', 'b_end', 'v_min', 'v_max'])
    return pd.read_parquet(cache_path)


def get_cached_or_compute_baselines(df, dataset_key, force_recompute):
    """Baseline z-scores, computed once per (dataset, metric) and reused.

    Only metrics missing from the cache are computed, so selecting an extra
    metric costs one baseline rather than a full recomputation.
    """
    cache_path = _baseline_cache_path(dataset_key)
    if os.path.exists(cache_path) and not force_recompute:
        print('Reading cached baseline z-scores from parquet')
        ZSC_d = pd.read_parquet(cache_path)
    else:
        ZSC_d = pd.DataFrame()  # Empty DataFrame if cache doesn't exist or a recompute was forced

    # Extract existing features in the cache
    cached_features = set(ZSC_d['feature']) if not ZSC_d.empty else set()

    # Extract features from df
    df_features = set(df.columns) - {NODE, TIME}

    # Find missing features that need computation
    missing_features = df_features - cached_features

    if missing_features:
        missing_df = df[[NODE, TIME] + list(missing_features)]
        bs_start = timer()
        new_baselines = process_columns_baseline(missing_df)
        bs_end = timer()
        print(f'baseline in {(bs_end - bs_start)}s')

        # Append new baselines to cached ones
        if not new_baselines.empty:
            if not ZSC_d.empty:
                ZSC_d = pd.concat([ZSC_d, new_baselines], ignore_index=True)
            else:
                ZSC_d = new_baselines

        ZSC_d.to_parquet(cache_path)
        print(f'Cached baselines for {len(missing_features)} new metric(s).')

    return ZSC_d

def get_mrdmd(df, dataset_key, force_recompute):
    # Step 1: Compute z-scores for baselines or get them from cache
    Z_b = get_cached_or_compute_baselines(df, dataset_key, force_recompute)

    # Step 2: Compute z-scores for the node selection compared to baseline z-scores
    mr_dmdstart = timer()
    zsc_d = compute_zscores(df, Z_b)
    mr_dmdend = timer()

    print(f'mrDMD in {(mr_dmdend - mr_dmdstart)}s')
    zsc_d = zsc_d.replace({np.nan: None, np.inf: None, -np.inf: None})
    Z_b = Z_b.replace({np.nan: None, np.inf: None, -np.inf: None})
    return zsc_d, Z_b

def get_mrdmd_with_new_base(df, col, bmin, bmax, sob, eob):
    # Step 1: compute z-score for given baseline 
    bs_start = timer()
    Z_b = process_baseline(df, col, bmin, bmax, sob, eob)
    bs_end = timer()

    # Step 2: Compute z-scores for the node selection compared to new baseline z-score
    mr_dmdstart = timer()
    zsc_d = compute_zscores(df, Z_b)
    mr_dmdend = timer()

    print(f'baseline in {(bs_end - bs_start)}s')
    print(f'mrDMD in {(mr_dmdend - mr_dmdstart)}s')
    zsc_d = zsc_d.replace({np.nan: None, np.inf: None, -np.inf: None})
    Z_b = Z_b.replace({np.nan: None, np.inf: None, -np.inf: None})
    return zsc_d, Z_b
