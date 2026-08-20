"""Holds the dataset the server is currently serving.

The previous implementation kept the active frame in module-level globals that
every request mutated. This wraps that state behind a lock and a single swap
point, so an ingest request can replace the dataset without another in-flight
request seeing a half-updated frame.
"""
import threading

import numpy as np
import pandas as pd

import config
import datasource
from scripts import pipeline


class DatasetStore:
    def __init__(self):
        self._lock = threading.RLock()
        self._dataset = None
        self._headers = {}
        self._cluster_assignments = None
        self._stream_index = 0

    # --- access ------------------------------------------------------------
    @property
    def dataset(self):
        with self._lock:
            if self._dataset is None:
                raise datasource.DataSourceError(
                    'No dataset is loaded. POST a source to /api/datasets/load first.',
                    status=503,
                )
            return self._dataset

    @property
    def frame(self):
        return self.dataset.frame

    @property
    def headers(self):
        with self._lock:
            return self._headers

    @property
    def key(self):
        return self.dataset.key()

    @property
    def stream_index(self):
        with self._lock:
            return self._stream_index

    @property
    def cluster_assignments(self):
        """Latest nodeId -> Cluster frame, or None before the first DR pass."""
        with self._lock:
            return self._cluster_assignments

    def is_loaded(self):
        with self._lock:
            return self._dataset is not None

    # --- mutation ----------------------------------------------------------
    def load(self, source, name=None):
        """Swap in a new dataset, discarding anything derived from the old one."""
        dataset = datasource.load_dataset(source, name=name)
        headers = datasource.load_headers(dataset.path)
        with self._lock:
            self._dataset = dataset
            self._headers = headers
            self._cluster_assignments = None
            self._stream_index = 0
            pipeline.clear_cache()
        print(
            f'Loaded dataset "{dataset.name}": {len(dataset.frame):,} rows, '
            f'{len(dataset.nodes)} nodes, {len(dataset.metrics)} metrics'
        )
        return dataset

    def append(self, frame, advance=True):
        """Merge a streamed batch into the active dataset.

        A batch adds **rows**, never columns and never a new population. Both
        rules are enforced here rather than trusted, because the failure is
        silent and expensive: appending the raw ganglia export to the anonymized
        sample produced a 315-node, 46-metric frame spanning two islands 52 days
        apart, and the 120 original nodes then had no DR1 row for any of the 23
        metrics they had never carried — so the DR2 pivot was NaN and UMAP threw
        `Input contains NaN`. Real hostnames also ended up in what is meant to
        be an anonymized demo.

        Raises `DataSourceError` (422) when the batch describes different nodes
        entirely, which is the signal that it is not a continuation of this run.
        """
        normalized = datasource.normalize(frame)
        node = config.NODE_COLUMN

        with self._lock:
            current = self.dataset

            # Columns the dataset does not already have are dropped rather than
            # merged: a mid-stream schema change would silently re-rank the
            # metric list and re-fit the embedding on a different feature space.
            keep = [c for c in normalized.columns if c in current.frame.columns]
            dropped = [c for c in normalized.columns if c not in keep]
            normalized = normalized[keep]
            if dropped:
                print(f'Stream batch: ignoring {len(dropped)} column(s) not in '
                      f'the active dataset: {", ".join(dropped[:5])}'
                      f'{"..." if len(dropped) > 5 else ""}')

            shared = set(normalized[node]) & set(current.frame[node])
            if not shared:
                raise datasource.DataSourceError(
                    f'That batch names {normalized[node].nunique()} node(s), none of '
                    f'which are in the active dataset. A stream batch has to continue '
                    f'the same nodes, not introduce a different population.',
                    status=422,
                )

            combined = pd.concat([current.frame, normalized], ignore_index=True)
            combined = combined.drop_duplicates(
                subset=[config.NODE_COLUMN, config.TIME_COLUMN], keep='last'
            )
            combined = combined.sort_values(
                [config.TIME_COLUMN, config.NODE_COLUMN]
            ).reset_index(drop=True)
            self._dataset = datasource.Dataset(
                current.name, current.source, combined, path=current.path
            )
            # Only a prepared batch advances the counter. A source tail is not
            # numbered, and letting it advance meant one tailed append skipped
            # `batch_000.csv` — the two mechanisms silently consuming one
            # another's position.
            if advance:
                self._stream_index += 1
            # Rows changed, so every cached DR/baseline artifact is stale.
            pipeline.clear_cache()
            return self._dataset

    def restore(self, dataset, stream_index):
        """Put a previous dataset back after a batch failed to analyse.

        The caches are cleared again on the way out: whatever the failed pass
        managed to write describes rows that are no longer loaded.
        """
        with self._lock:
            self._dataset = dataset
            self._stream_index = stream_index
            pipeline.clear_cache()

    # --- cluster label stability -------------------------------------------
    def align_clusters(self, new_df):
        """Relabel clusters to match the previous assignment where they overlap.

        k-means numbers clusters arbitrarily, so without this the colors in every
        view reshuffle on each recompute even when the grouping is unchanged.
        Uses Hungarian matching on node overlap.
        """
        from scipy.optimize import linear_sum_assignment

        node = config.NODE_COLUMN
        with self._lock:
            old_df = self._cluster_assignments

            if old_df is not None and not old_df.empty:
                old_clusters = sorted(old_df['Cluster'].unique())
                new_clusters = sorted(new_df['Cluster'].unique())

                cost = np.zeros((len(old_clusters), len(new_clusters)))
                old_members = {
                    c: set(old_df[old_df['Cluster'] == c][node]) for c in old_clusters
                }
                for i, old_c in enumerate(old_clusters):
                    for j, new_c in enumerate(new_clusters):
                        members = set(new_df[new_df['Cluster'] == new_c][node])
                        cost[i, j] = -len(old_members[old_c] & members)

                row_ind, col_ind = linear_sum_assignment(cost)
                mapping = {
                    new_clusters[col]: old_clusters[row]
                    for row, col in zip(row_ind, col_ind)
                }
                # k may have grown; park unmatched clusters above the matched
                # ones so they sort last in the compaction below.
                ceiling = max(old_clusters, default=-1) + 1
                for offset, cluster in enumerate(
                    c for c in new_clusters if c not in mapping
                ):
                    mapping[cluster] = ceiling + offset

                # Compact onto 0..k-1 while keeping the order alignment produced.
                # Without this, cycling k up and down leaves gaps (c0, c2, c3, c4
                # for four clusters) and eventually pushes labels past the end of
                # the color palette.
                ranks = {
                    label: rank
                    for rank, label in enumerate(sorted(set(mapping.values())))
                }
                mapping = {new: ranks[old] for new, old in mapping.items()}

                new_df['Cluster'] = new_df['Cluster'].map(mapping)

            self._cluster_assignments = new_df[[node, 'Cluster']].copy()
        return new_df


store = DatasetStore()
