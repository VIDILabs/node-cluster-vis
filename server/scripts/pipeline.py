"""2-stage dimension reduction across time domain then feature domain"""
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

CACHE_DIR = './scripts/cache/'
DR1_CACHE_NAME = CACHE_DIR + 'drTimeDataDR1.parquet'
DR2_CACHE_NAME = CACHE_DIR + 'drTimeDataDR2.parquet'

def preprocess(df, value_column):
    return df.loc[:, ['timestamp', 'nodeId', value_column]] \
             .pivot_table(index='timestamp', columns='nodeId', values=value_column) \
             .apply(lambda row: row.fillna(0.0), axis=0).T

def apply_first_dr(df, col_name, method='PCA', clamp_time_window=False):
    try:
        # pivot: rows -> timestamps, columns -> nodeId
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

        # apply PCA
        if (method == 'PCA'):
            pca = PCA(n_components=1) # look into n_components in PCA sklearn implementation
            scores = pca.fit_transform(X_scaled)
        
        elif (method == 'UMAP'):
            umap = UMAP(n_components=1, n_neighbors=15, min_dist=0.1, random_state=42, n_jobs=1)
            scores = umap.fit_transform(X_scaled)
        
        elif (method == "TSNE"):
            tsne = TSNE(n_components=1, random_state=42, perplexity=min(30, X_scaled.shape[0] - 1))
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
    return df.drop(columns=['timestamp', 'nodeId']).columns

def apply_dr_parallel(df, method="PCA"):
    print(f"Applying DR1 using {method}")
    P_final = []

    numeric_cols = get_numeric_columns(df)

    def process_single_column(col_name):
        r_df = apply_first_dr(df, col_name, method=method)
        if r_df is not None:
            P_final.append(r_df)

    if method in ("UMAP", "TSNE"):
        for col in numeric_cols:
            process_single_column(col)
    else:
        with ThreadPoolExecutor() as executor:
            executor.map(process_single_column, numeric_cols)

    return pd.concat(P_final, ignore_index=True) if P_final else pd.DataFrame()

def apply_pca(df, n_components=2):
    print('Applying DR2 PCA')
    X = df.copy(deep=True)

    try:
        baseline = X.values

        # normalizing the data (demean)
        mean_hat = baseline.mean(axis=0)
        demeaned = baseline - mean_hat

        # standardize
        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(demeaned)

        # apply PCA
        pca = PCA(n_components=n_components)
        scores = pca.fit_transform(X_scaled)  

        P_fin = pd.DataFrame({f"PC{k+1}": scores[:, k] if k < n_components else np.nan for k in range(n_components)})
        P_fin['Measurement'] = X.index
        P_fin.set_index('Measurement', inplace=True)

        return P_fin # return df with rows = node IDs, cols PC1, PC2, nodeId, measurement index

    except Exception as e:
        print(f"Error processing PCA across features: {e}")
        return None
    
def apply_umap(df, min_dist, n_neighbors): 
    print('Applying DR2 UMAP')
    df_umap = df.copy(deep=True)
    umap = UMAP(n_components=2, min_dist=min_dist, n_neighbors=n_neighbors, random_state=42)
    embedding = umap.fit_transform(df_umap)
    return embedding[:, 0], embedding[:, 1] # columns 'UMAP1', 'UMAP2'

def apply_tsne(df):
    print('Applying DR2 tSNE')
    df_tsne = df.copy(deep=True)
    tsne = TSNE(n_components=2, random_state=42)
    embedding = tsne.fit_transform(df_tsne)
    return embedding[:, 0], embedding[:, 1] # columns 'tSNE1', 'tSNE2'

def apply_second_dr(df, method, n_neighbors=15, min_dist=0.1):
    print('Applying DR2 using:', method)
    df_pivot = df.pivot(index="Measurement", columns="Col", values="DR1")
    X = df_pivot.values

    if (method == "PCA"):
        pca = PCA(n_components=2, random_state=42)
        emb = pca.fit_transform(X)
        
    elif (method == "UMAP"): 
        # old
        # umap1, umap2 = apply_umap(df_pivot, n_neighbors=n_neighbors, min_dist=min_dist)
        
        umap = UMAP(
            n_components=2,
            n_neighbors=n_neighbors,
            min_dist=min_dist,
            random_state=42
        )
        emb = umap.fit_transform(X)

    elif (method == "TSNE"):
        tsne = TSNE(
            n_components=2,
            random_state=42,
            perplexity=min(30, X.shape[0] - 1)
        )
        emb = tsne.fit_transform(X)

    else:
        raise ValueError(f"Invalid DR2 method: {method}")

    # append DR results to df
    return df_pivot.assign(
        E1=emb[:, 0],
        E2=emb[:, 1]
    )

def id_clusters_w_kmeans(df_pivot, k):
    X = df_pivot[['E1', 'E2']]
    kmeans = KMeans(n_clusters=k, random_state=42, n_init=10)
    df_pivot['Cluster'] = kmeans.fit_predict(X)
    df_pivot['nodeId'] = df_pivot.index

def get_feat_contributions(df):
    excluded_columns = ["E1", "E2", "nodeId", "Cluster"]
    X = (
        df
        .drop(columns=[c for c in excluded_columns if c in df.columns])
        .select_dtypes(include=[np.number])
        .to_numpy(dtype=float)
    )
    y = np.int_(df['Cluster'])

    unique_labels = np.unique(y) # unique cluster ids
    _, n_feats = X.shape
    n_labels = len(unique_labels)
    first_cpc_mat = np.zeros((n_feats, n_labels))
    feat_contrib_mat = np.zeros((n_feats, n_labels))

    # 1. get the scaled feature contributions and first cPC for each label
    ccpca = CCPCA(n_components=1)
    for i, target_label in enumerate(unique_labels):
        ccpca.fit(
            X[y == target_label],
            X[y != target_label],
            var_thres_ratio=0.5,
            n_alphas=40,
            max_log_alpha=0.5)

        first_cpc_mat[:, i] = ccpca.get_first_component()
        feat_contrib_mat[:, i] = ccpca.get_scaled_feat_contribs()

    # 2. apply optimal sign flipping
    OptSignFlip().opt_sign_flip(first_cpc_mat, feat_contrib_mat)

    # 3. apply hierarchical clustering with optimal-leaf-ordering
    mr = MatReorder()
    mr.fit_transform(feat_contrib_mat)
    order_col = mr.order_col_.tolist()

    # 4. apply aggregation
    n_feats_shown = n_feats
    agg_feat_contrib_mat, label_to_rows, label_to_rep_row = mr.aggregate_rows(feat_contrib_mat,
                                                                            n_feats_shown,
                                                                            agg_method='abs_max')
    return agg_feat_contrib_mat, label_to_rows, label_to_rep_row, order_col

def get_cached_or_compute_dr1(df, method="PCA", force_recompute=False):
    if os.path.exists(DR1_CACHE_NAME) and not force_recompute:
        # Read cached DR1 results
        # print('Reading cached DR1 results from parquet')
        return pd.read_parquet(DR1_CACHE_NAME)
    
    DR1_d = apply_dr_parallel(df, method)
    os.makedirs(CACHE_DIR, exist_ok=True)
    DR1_d.to_parquet(DR1_CACHE_NAME)
    # print(f'Cached DR1 results to parquet {DR1_CACHE_NAME}.')
    return DR1_d

def get_cached_or_compute_dr2(df, n_neighbors, min_dist, method="UMAP", force_recompute=False):
    if os.path.exists(DR2_CACHE_NAME) and not force_recompute:
        # Read cached DR2 results
        print('Reading cached DR2 results from parquet')
        return pd.read_parquet(DR2_CACHE_NAME)
    
    DR2_d = apply_second_dr(df, method, n_neighbors=n_neighbors, min_dist=min_dist)
    os.makedirs(CACHE_DIR, exist_ok=True)
    DR2_d.to_parquet(DR2_CACHE_NAME)
    # print(f'Cached DR2 results to parquet {DR2_CACHE_NAME}.')
    return DR2_d

def get_dr_time(df, n_neighbors, min_dist, num_clusters, force_recompute_dr1=1):
    recompute_dr1 = True if force_recompute_dr1 == 1 else False
    recompute_dr2 = True if force_recompute_dr1 == 1 else False
    # First pass DR across Timestamps
    dr1start = timer()
    DR1_d = get_cached_or_compute_dr1(df, method="PCA", force_recompute=recompute_dr1)
    dr1end = timer()
    # Second pass DR across Features
    dr2start = timer()
    DR2_d = get_cached_or_compute_dr2(DR1_d, n_neighbors, min_dist, method="UMAP", force_recompute=recompute_dr2)
    dr2end = timer()
    # Use kMeans to get cluster IDs
    kmeansStart = timer()
    id_clusters_w_kmeans(DR2_d, num_clusters)
    kmeansEnd = timer()
    print(f'DR1 in {(dr1end - dr1start)}s')
    print(f'DR2 in {(dr2end - dr2start)}s')
    print(f'kMeans in {(kmeansEnd - kmeansStart)}s')
    print(f'Returning {len(DR2_d)} rows')
    return DR2_d

def recompute_clusters(df, num_clusters, n_neighbors, min_dist, force_recompute=0):
    if (force_recompute == 1):
        DR1_d = get_cached_or_compute_dr1(df)
        DR2_d = apply_second_dr(DR1_d, "UMAP", n_neighbors, min_dist)
        DR2_d.to_parquet(CACHE_DIR + DR2_CACHE_NAME)
    else:
        DR2_d = pd.read_parquet(CACHE_DIR + DR2_CACHE_NAME)

    kmeans_start = timer()
    if not os.path.exists(CACHE_DIR + DR2_CACHE_NAME):
        print("No cached DR2 results.")
        return None
    
    id_clusters_w_kmeans(DR2_d, num_clusters)
    kmeans_end = timer()
    print(f'Recomputed cluster IDs for new k={num_clusters} with cached DR2 results in {kmeans_end - kmeans_start}')

    print(f'Recomputing feature contributions for new k={num_clusters} clusters.')
    fc_start = timer()
    agg_feat_contrib_mat, label_to_rows, label_to_rep_row, order_col, = get_feat_contributions(DR2_d)
    fc_end = timer()
    print(f'Recomputed feature contributions for new k={num_clusters} clusters with cached DR2 results in {fc_end - fc_start}')

    return {
        "dr_features": DR2_d.to_dict(orient='records'),
        "node_cluster_map": DR2_d[['Cluster', 'nodeId']].to_dict(orient='records'),
        "feat_contributions": {
            "agg_feat_contrib_mat": agg_feat_contrib_mat.tolist(),
            "label_to_rows": [list(rows) for rows in label_to_rows],
            "label_to_rep_row": label_to_rep_row,
            "order_col": order_col
        },
    }
