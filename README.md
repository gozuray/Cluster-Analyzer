# Cluster Analyzer

Web tool to analyze Ethereum addresses: it fetches transactions via Etherscan, builds a relationship graph with neighbors, applies heuristics, and computes wallet- and cluster-level risk scores.

## Requirements

- Python 3.12+ (recommended)
- An [Etherscan API key](https://etherscan.io/apis)

## Setup

1. Clone the repository and install dependencies:

```bash
cd Cluster-Analyzer
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

On Linux or macOS, use `source .venv/bin/activate` instead of the Windows activation line above.

2. Environment variables: copy `.env.example` to `.env` and set `ETHERSCAN_API_KEY` to your key. Optionally adjust `ETHERSCAN_BASE_URL` and `CHAIN_ID` for your network.

## Running

From the project folder (with the virtual environment activated):

```bash
uvicorn backend.main:app --reload
```

Open the browser at the server root (by default `http://127.0.0.1:8000/`) for the UI. The documented API is at `/docs` (Swagger).

## UI preview

Example of the live graph, risk panel, and streaming load progress (depth 1):

![Wallet cluster analyzer UI](docs/examples/ui-wallet-cluster-analyzer.png)

## Main API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/analyze` | Full report: risk, heuristics, neighbors, and graph |
| GET | `/graph` | Graph JSON only (lighter than `/analyze`) |

The `POST /analyze` body accepts `address`, `depth` (0–2), `force_refresh`, and optional `neighbor_limit`.

## Project layout

- `backend/` — FastAPI, cluster engine, transaction fetch, heuristics, and scoring
- `frontend/` — Static UI and graph visualization
- `docs/examples/` — Screenshots and other visual examples
- `cache/` — Local transaction cache (JSON; not versioned in git)

## License

Use of this repository is governed by the project owner.
