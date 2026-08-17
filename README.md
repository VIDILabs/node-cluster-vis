# Cluster-Based Visual Analytics System for HPC Performance Data

## About

- Implementation of two-step DR (PCA+UMAP) with contrastive clusters for feature contributions.
- Interactive mrDMD to adjust metric baselines and compute per-node devation from baseline(s).

## Requirements

- Python3
- Note: Tested on macOS Tahoe and Ubuntu 24.04 LTS.

### Frontend (React)

### Setup

1. Open a terminal
2. Run `cd ui`
3. Ensure Node 24+ is active:
   1. NVM: `nvm use 24` or `nvm install 24` if not installed
4. `npm install`

### Usage

1. Open terminal
2. `cd ui`
3. `npm run start`

## Backend (Flask)

### Setup

1. Open a second terminal
2. Run `cd server`
3. Ensure you're using Python 3.13. If you have `pyenv` installed, it should automatically switch Python versions when you `cd` into `server/`.
4. `python -m venv .venv`
5. `source .venv/bin/activate` (Repeat this whenever you start a new terminal)
6. `pip install -r requirements.txt`
7. Install CCPCA package

   1. Options:
      1. Clone the repo:`git clone https://github.com/takanori-fujiwara/ccpca.git`, follow instructions in the README.md file
      2. Run `pip install ccpca`
8. Add data to server/data/

   1. Format (csv):

   | timestamp           | nodeId | metric_1 | metric_2 | metric_n |
   | ------------------- | ------ | -------- | -------- | -------- |
   | MM-DD-YYYY HH:mm:ss | node0  | ...      | ...      | ...      |
   | MM-DD-YYYY HH:mm:ss | node1  | ...      | ...      | ...      |

### Usage

1. Open terminal
2. `cd server`
3. `source .venv/bin/activate`
4. `python server.py`

## References

1. Takanori Fujiwara, Shilpika, Naohisa Sakamoto, Jorji Nonaka, Keiji Yamamoto, and Kwan-Liu Ma, "A Visual Analytics Framework for Reviewing Multivariate Time-Series Data with Dimensionality Reduction". IEEE Transactions on Visualization and Computer Graphics, vol. 27, no. 2, pp. 1601-1611, 2021. [code](https://github.com/takanori-fujiwara/multidr)
2. Takanori Fujiwara, Oh-Hyun Kwon, and Kwan-Liu Ma, "Supporting Analysis of Dimensionality Reduction Results with Contrastive Learning". IEEE Transactions on Visualization and Computer Graphics, 2020. DOI: 10.1109/TVCG.2019.2934251 [code](https://github.com/takanori-fujiwara/ccpca)
3. S. Shilpika et al., "A Multi-Level, Multi-Scale Visual Analytics Approach to Assessment of Multifidelity HPC Systems," 2024 IEEE 24th International Symposium on Cluster, Cloud and Internet Computing (CCGrid), Philadelphia, PA, USA, 2024, pp. 478-488, doi: 10.1109/CCGrid59990.2024.00060. [code](https://github.com/sshilpika/mrdmd-frequency-isolation)

### Citation

Allison Austin, Shilpika, Yan To Linus Lam, Yun-Hsin Kuo, Venkatram Vishwanath, Michael E. Papka, & Kwan-Liu Ma (2026). Understanding Large-Scale HPC System Behavior Through Cluster-Based Visual Analytics. arXiv. https://doi.org/10.48550/arXiv.2604.11965
