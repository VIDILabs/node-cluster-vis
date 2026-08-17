"""2-stage dimension reduction across the time domain then the feature domain.

DR1 collapses each metric's node x time matrix to one score per node. DR2 embeds
the resulting node x metric matrix in 2D, and k-means labels the embedding.
Caches are keyed by dataset content *and* the parameters that produced them, so a
cache hit is only ever returned for an identical computation.
"""
import os
from concurrent.futures import ThreadPoolExecutor
from timeit import default_timer as timer

import numpy as np
import pandas as pd
from ccpca import CCPCA
from fc_view import MatReorder
from fc_view import OptSignFlip
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE
from sklearn.preprocessing import StandardScaler
from umap import UMAP

import config

NODE = config.NODE_COLUMN
TIME = config.TIME_COLUMN


def _cache_path(kind, token):
    config.ensure_dirs()
    return os.path.join(config.CACHE_DIR, f'{kind}_{token}.parquet')


def clear_cache():
    """Drop every cached artifact. Used on startup and when a dataset is swapped."""
    if not os.path.isdir(config.CACHE_DIR):
        return
    for entry in os.listdir(config.CACHE_DIR):
        if entry.endswith('.parquet'):
            try:
                os.remove(os.path.join(config.CACHE_DIR, entry))
            except OSError as exc:
                print(f'Could not remove cache file {entry}: {exc}')


def preprocess(df, value_column):
    return df.loc[:, [TIME, NODE, value_column]] \
             .pivot_table(index=TIME, columns=NODE, values=value_column) \
             .apply(lambda row: row.fillna(0.0), axis=0).T


def apply_first_dr(df, col_name, method='PCA', clamp_time_window=False):
    try:
        # pivot: rows -> nodes, columns -> timestamps
        X = preprocess(df, col_name)
        X.columns = pd.to_datetime(X.columns)

        start_index = int(len(X.columns) * 0.3)
        end_index = int(len(X.columns) * 0.45)
        X_filtered = X.iloc[:, start_index:end_index]

        baseline = X_filtered.values if clamp_time_window else X.values

        # normalizing the data (demean)
        mean_hat = baseline.mean(axis=0)
        demeaned = baseline - mean_hat

        # standardize
        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(demeaned)

        if (X_scaled.shape[0] < 2 or np.all(np.isnan(X_scaled)) or np.all(X_scaled == 0)):
            return None

        if (method == 'PCA'):
            pca = PCA(n_components=1)
            scores = pca.fit_transform(X_scaled)

        elif (method == 'UMAP'):
            umap = UMAP(n_components=1, n_neighbors=15, min_dist=0.1,
                        random_state=config.RANDOM_SEED, n_jobs=1)
            scores = umap.fit_transform(X_scaled)

        elif (method == "TSNE"):
            tsne = TSNE(n_components=1, random_state=config.RANDOM_SEED,
                        perplexity=min(30, X_scaled.shape[0] - 1))
            scores = tsne.fit_transform(X_scaled)

        else:
            raise ValueError(f"Invalid DR1 method: {method}")

        return pd.DataFrame({
            "Col": col_name,
            "Measurement": X.index,
            "DR1": scores[:, 0]
        })

    except Exception as e:
        print(f"Error processing {col_name}: {e}")
        return None


def get_numeric_columns(df):
    return df.drop(columns=[TIME, NODE]).columns


def apply_dr_parallel(df, method="PCA"):
    print(f"Applying DR1 using {method}")
    numeric_cols = list(get_numeric_columns(df))

    if method in ("UMAP", "TSNE"):
        # Both are stateful/seeded; running them serially keeps results reproducible.
        results = [apply_first_dr(df, col, method=method) for col in numeric_cols]
    else:
        with ThreadPoolExecutor() as executor:
            results = list(executor.map(
                lambda col: apply_first_dr(df, col, method=method), numeric_cols
            ))

    # Collecting in submission order (rather than appending from workers) keeps
    # DR1 output deterministic across runs.
    frames = [frame for frame in results if frame is not None]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def apply_second_dr(df, method, n_neighbors=15, min_dist=0.1):
    print('Applying DR2 using:', method)
    df_pivot = df.pivot(index="Measurement", columns="Col", values="DR1")
    X = df_pivot.values

    if (method == "PCA"):
        pca = PCA(n_components=2, random_state=config.RANDOM_SEED)
        emb = pca.fit_transform(X)

    elif (method == "UMAP"):
        # n_neighbors must stay below the sample count or UMAP errors out; small
        # node sets are common in a deployed instance.
        neighbors = int(max(2, min(n_neighbors, X.shape[0] - 1)))
        umap = UMAP(
            n_components=2,
            n_neighbors=neighbors,
            min_dist=min_dist,
            random_state=config.RANDOM_SEED
        )
        emb = umap.fit_transform(X)

    elif (method == "TSNE"):
        tsne = TSNE(
            n_components=2,
            random_state=config.RANDOM_SEED,
            perplexity=min(30, X.shape[0] - 1)
        )
        emb = tsne.fit_transform(X)

    else:
        raise ValueError(f"Invalid DR2 method: {method}")

    return df_pivot.assign(E1=emb[:, 0], E2=emb[:, 1])


def id_clusters_w_kmeans(df_pivot, k):
    """Label the 2D embedding. k is clamped so a small node set can't crash k-means."""
    k = int(max(1, min(k, len(df_pivot))))
    X = df_pivot[['E1', 'E2']]
    kmeans = KMeans(n_clusters=k, random_state=config.RANDOM_SEED, n_init=10)
    df_pivot['Cluster'] = kmeans.fit_predict(X)
    df_pivot[NODE] = df_pivot.index
    return df_pivot


def feature_columns(df):
    """Metric columns of a DR2 frame, in the order their rows appear in the FC matrix."""
    excluded = {"E1", "E2", NODE, "Cluster"}
    return [
        c for c in df.columns
        if c not in excluded and pd.api.types.is_numeric_dtype(df[c])
    ]


def get_feat_contributions(df):
    """Per-cluster ccPCA feature contributions.

    Returns the aggregated matrix along with the *names* of the features each row
    corresponds to; without those the client cannot line rows up with metrics.
    """
    features = feature_columns(df)
    X = df[features].to_numpy(dtype=float)
    y = np.int_(df['Cluster'])

    unique_labels = np.unique(y)
    _, n_feats = X.shape
    n_labels = len(unique_labels)
    first_cpc_mat = np.zeros((n_feats, n_labels))
    feat_contrib_mat = np.zeros((n_feats, n_labels))

    # 1. scaled feature contributions + first cPC per label. Each label is an
    #    independent ccPCA fit, so they run concurrently.
    def fit_label(index_and_label):
        i, target_label = index_and_label
        ccpca = CCPCA(n_components=1)
        ccpca.fit(
            X[y == target_label],
            X[y != target_label],
            var_thres_ratio=0.5,
            n_alphas=40,
            max_log_alpha=0.5)
        return i, ccpca.get_first_component(), ccpca.get_scaled_feat_contribs()

    with ThreadPoolExecutor(max_workers=min(len(unique_labels), 8)) as executor:
        for i, first_cpc, contribs in executor.map(fit_label, enumerate(unique_labels)):
            first_cpc_mat[:, i] = first_cpc
            feat_contrib_mat[:, i] = contribs

    # 2. optimal sign flipping
    OptSignFlip().opt_sign_flip(first_cpc_mat, feat_contrib_mat)

    # 3. hierarchical clustering with optimal-leaf-ordering
    mr = MatReorder()
    mr.fit_transform(feat_contrib_mat)
    order_col = mr.order_col_.tolist()

    # 4. aggregation
    agg_feat_contrib_mat, label_to_rows, label_to_rep_row = mr.aggregate_rows(
        feat_contrib_mat, n_feats, agg_method='abs_max')

    return {
        'agg_feat_contrib_mat': agg_feat_contrib_mat.tolist(),
        'features': features,
        'clusters': [int(label) for label in unique_labels],
        'label_to_rows': [list(rows) for rows in label_to_rows],
        'label_to_rep_row': label_to_rep_row,
        'order_col': order_col,
    }


# --- caching ---------------------------------------------------------------

def get_cached_or_compute_dr1(df, token, method="PCA", force_recompute=False):
    path = _cache_path('dr1', token)
    if os.path.exists(path) and not force_recompute:
        print('Reading cached DR1 results')
        return pd.read_parquet(path)

    result = apply_dr_parallel(df, method)
    result.to_parquet(path)
    return result


def get_cached_or_compute_dr2(df, token, n_neighbors, min_dist, method="UMAP",
                              force_recompute=False):
    path = _cache_path('dr2', token)
    if os.path.exists(path) and not force_recompute:
        print('Reading cached DR2 results')
        return pd.read_parquet(path)

    result = apply_second_dr(df, method, n_neighbors=n_neighbors, min_dist=min_dist)
    result.to_parquet(path)
    return result


def load_cached_dr2(token):
    path = _cache_path('dr2', token)
    return pd.read_parquet(path) if os.path.exists(path) else None


def get_dr_time(df, dataset_key, n_neighbors, min_dist, num_clusters, force_recompute=False):
    """Run (or reuse) the full DR + clustering pass.

    ``dataset_key`` identifies the rows; DR2 is additionally keyed on the UMAP
    parameters, so changing k alone reuses both cached stages and only re-runs
    k-means — which is what makes the cluster-count control feel instant.
    """
    dr1_token = dataset_key
    dr2_token = f'{dataset_key}_{n_neighbors}_{min_dist}'

    dr1_start = timer()
    DR1_d = get_cached_or_compute_dr1(
        df, dr1_token, method=config.DR1_METHOD, force_recompute=force_recompute)
    dr1_end = timer()

    dr2_start = timer()
    DR2_d = get_cached_or_compute_dr2(
        DR1_d, dr2_token, n_neighbors, min_dist,
        method=config.DR2_METHOD, force_recompute=force_recompute)
    dr2_end = timer()

    kmeans_start = timer()
    id_clusters_w_kmeans(DR2_d, num_clusters)
    kmeans_end = timer()

    print(f'DR1 in {dr1_end - dr1_start:.3f}s | DR2 in {dr2_end - dr2_start:.3f}s '
          f'| kMeans in {kmeans_end - kmeans_start:.3f}s | {len(DR2_d)} rows')
    return DR2_d


def recompute_clusters(dataset_key, num_clusters, n_neighbors, min_dist):
    """Re-label a cached DR2 embedding for a new k.

    Returns ``None`` when no cached embedding exists for these parameters, which
    the caller surfaces as a 404 rather than a 500.
    """
    DR2_d = load_cached_dr2(f'{dataset_key}_{n_neighbors}_{min_dist}')
    if DR2_d is None:
        print('No cached DR2 results for these parameters.')
        return None

    kmeans_start = timer()
    id_clusters_w_kmeans(DR2_d, num_clusters)
    kmeans_end = timer()
    print(f'Recomputed clusters for k={num_clusters} in {kmeans_end - kmeans_start:.3f}s')

    return DR2_d
