"""Data-driven choices for the DR and clustering parameters.

Kept apart from ``pipeline`` deliberately: ``datasource`` needs these to describe
a dataset's defaults, and importing ``pipeline`` there would drag ``umap`` and
``ccpca`` into every consumer — including ``scripts/anonymize.py``, which runs on
machines where ``ccpca`` (a local build, not a wheel) isn't installed.

Only numpy and scikit-learn are needed here.
"""
import numpy as np
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

import config


def suggest_umap_params(n_samples):
    """Derive ``(n_neighbors, min_dist)`` from the size of the node set.

    A fixed n_neighbors is wrong at both ends: 15 over 20 nodes pulls in most of
    the population as "local" and collapses the embedding into one blob, while
    over thousands of nodes it resolves noise. sqrt(n) is the usual scaling for
    a neighbourhood that should grow sub-linearly with the sample; it is clamped
    to [5, 50] and always held below n-1, which UMAP requires.

    min_dist moves the other way — a handful of points needs them spread apart
    to be readable, a crowded embedding needs them packed so structure shows.
    """
    n = int(max(n_samples, 2))
    neighbors = int(np.clip(round(np.sqrt(n)), 5, 50))
    neighbors = int(max(2, min(neighbors, n - 1)))
    min_dist = 0.25 if n <= 50 else (0.1 if n <= 500 else 0.05)
    return neighbors, min_dist


def resolve_umap_params(node_count, n_neighbors=None, min_dist=None):
    """Fill in whichever parameters the caller left unspecified.

    ``None`` or a non-positive value means "choose for me"; anything explicit is
    honoured, so the manual controls in the UI still win over the heuristic.
    """
    auto_neighbors, auto_dist = suggest_umap_params(node_count)
    if not config.AUTO_PARAMS:
        auto_neighbors, auto_dist = config.DEFAULT_N_NEIGHBORS, config.DEFAULT_MIN_DIST

    neighbors = auto_neighbors if (n_neighbors is None or n_neighbors <= 0) else int(n_neighbors)
    # UMAP raises outright once n_neighbors reaches the sample count.
    neighbors = int(max(2, min(neighbors, max(int(node_count) - 1, 2))))
    dist = auto_dist if (min_dist is None or min_dist < 0) else float(min_dist)
    return neighbors, dist


def suggest_k(embedding, k_max=None):
    """Pick a cluster count by silhouette score, preferring the simpler model.

    Scored on the 2D embedding the user is actually looking at, so the chosen k
    is the one that reads as most separated in the scatter plot rather than one
    that is optimal in a space nobody sees. Cheap enough to run on every pass:
    the input is n x 2, so the whole sweep costs far less than one UMAP fit.

    Taking the arg-max alone overfits. UMAP deliberately produces many small
    tight blobs, so the curve is typically flat across a wide band of k — on the
    bundled sample every k from 4 to 9 scores within 3% of the best, and the raw
    arg-max lands on 9, splitting 120 nodes into nine near-identical groups. So
    the winner is the *smallest* k scoring within ``K_TOLERANCE`` of the best,
    which keeps a genuinely better split while refusing to chase noise.
    """
    X = np.asarray(embedding, dtype=float)
    n = X.shape[0]
    ceiling = int(min(k_max or config.MAX_AUTO_CLUSTERS, n - 1))
    if n < 3 or ceiling < 2:
        return int(max(1, min(config.DEFAULT_NUM_CLUSTERS, n)))

    scores = {}
    for k in range(2, ceiling + 1):
        labels = KMeans(
            n_clusters=k, random_state=config.RANDOM_SEED, n_init=10
        ).fit_predict(X)
        if len(np.unique(labels)) < 2:
            continue
        scores[k] = float(silhouette_score(X, labels))

    if not scores:
        return int(max(1, min(config.DEFAULT_NUM_CLUSTERS, n)))

    best = max(scores.values())
    threshold = best * (1.0 - config.K_TOLERANCE) if best > 0 else best
    chosen = min(k for k, score in scores.items() if score >= threshold)

    print(
        f'Auto-selected k={chosen} (silhouette {scores[chosen]:.3f}; '
        f'best {best:.3f} over 2..{ceiling})'
    )
    return chosen
