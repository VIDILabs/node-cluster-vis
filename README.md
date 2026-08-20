# Cluster-Based Visual Analytics System for HPC Performance Data

## About

This system combines visualization+analysis techniques to assess multivariate time series data from two HPC monitoring systems: (1) NOvADAQ deployed at the Near and Far Detectors from FNAL and (2) SEDC deployed at Theta supercomputer from ANL. We developed this visual analytics system to explore/analyze these datasets for the purposes of node behavior detection and hardware anomaly identification. To achieve this, we implement:

- *Intra-cluster* analysis: Two-step DR (PCA+UMAP) across time and metric domains with contrastive clusters for feature contributions.
- *Inter-cluster* analysis: Interactive mrDMD to adjust metric baselines and compute per-node devation from baseline(s).

We have included an anonymized sample dataset for exploring the interface without needing to supply your own data. More details on this project can be found in our [paper](https://arxiv.org/abs/2604.11965).

## Requirements

- Python3
- Note: Tested on macOS Tahoe and Ubuntu 24.04 LTS.

## Quick start

```bash
./start.sh              
```

## Frontend (React)

### Setup

1. In a terminal, run `cd ui`
2. Ensure Node 24+ is active:
   1. NVM: `nvm use 24` or `nvm install 24` if not installed
3. `npm install`
4. `cp .env.example .env.development` to point the app at the API

### Usage

1. `cd ui`
2. `npm run start`

Or `./start.sh --ui-only` from the repository root.

## Backend (Flask)

### Setup

1. In a terminal, run `cd server`
2. Ensure you're using Python 3.13. If you have `pyenv` installed, it should automatically switch Python versions when you `cd` into `server/`.
3. `python -m venv .venv`
4. `source .venv/bin/activate` (Repeat this whenever you start a new terminal)
5. `pip install -r requirements.txt`
6. Install CCPCA package

   1. Options:
      1. Clone the repo:`git clone https://github.com/takanori-fujiwara/ccpca.git`, follow instructions in the README.md file
      2. Run `pip install ccpca`
7. Add data to server/data/

   1. See server/data/sample_metrics.csv for format

### Usage

1. `cd server`
2. `source .venv/bin/activate`
3. `python server.py`

Or `./start.sh --api-only` from the repository root.

## References

1. Takanori Fujiwara, Shilpika, Naohisa Sakamoto, Jorji Nonaka, Keiji Yamamoto, and Kwan-Liu Ma, "A Visual Analytics Framework for Reviewing Multivariate Time-Series Data with Dimensionality Reduction". IEEE Transactions on Visualization and Computer Graphics, vol. 27, no. 2, pp. 1601-1611, 2021. [code](https://github.com/takanori-fujiwara/multidr)
2. Takanori Fujiwara, Oh-Hyun Kwon, and Kwan-Liu Ma, "Supporting Analysis of Dimensionality Reduction Results with Contrastive Learning". IEEE Transactions on Visualization and Computer Graphics, 2020. DOI: 10.1109/TVCG.2019.2934251 [code](https://github.com/takanori-fujiwara/ccpca)
3. S. Shilpika et al., "A Multi-Level, Multi-Scale Visual Analytics Approach to Assessment of Multifidelity HPC Systems," 2024 IEEE 24th International Symposium on Cluster, Cloud and Internet Computing (CCGrid), Philadelphia, PA, USA, 2024, pp. 478-488, doi: 10.1109/CCGrid59990.2024.00060. [code](https://github.com/sshilpika/mrdmd-frequency-isolation)

### Citation

Allison Austin, Shilpika, Yan To Linus Lam, Yun-Hsin Kuo, Venkatram Vishwanath, Michael E. Papka, Kwan-Liu Ma. Understanding Large-Scale HPC System Behavior
Through Cluster-Based Visual Analytics. ISC High Performance 2026 Research Paper Proceedings (41st International Conference), 2026, pp. 1-12, doi: 10.23919/ISC.2026.11520496.
