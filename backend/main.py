"""
FastAPI app: /analyze (full report), /graph (graph JSON), static frontend.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .cluster_engine import build_graph_from_txs, merge_tx_maps
from .config import settings
from .heuristics import run_all
from .risk_scorer import cluster_risk_score, wallet_risk_score
from .tx_fetcher import fetch_transactions, load_cached_transactions

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"

app = FastAPI(title="Wallet Cluster Analyzer", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyzeBody(BaseModel):
    address: str = Field(..., description="Ethereum address (checksummed or not)")
    depth: int = Field(1, ge=0, le=2, description="0 = seed only, 1–2 = fetch top neighbors")
    force_refresh: bool = Field(False, description="Bypass JSON cache for seed + neighbors")
    neighbor_limit: int | None = Field(
        None, ge=1, le=64, description="Override max neighbor wallets to expand"
    )


def _top_neighbors(seed: str, txs: list[dict[str, Any]], limit: int) -> list[str]:
    seed_l = seed.lower()
    counts: dict[str, int] = {}
    for tx in txs:
        if tx.get("isError") == "1":
            continue
        f = (tx.get("from") or "").lower()
        t = (tx.get("to") or "").lower()
        other = ""
        if f == seed_l and t:
            other = t
        elif t == seed_l and f:
            other = f
        if not other:
            continue
        counts[other] = counts.get(other, 0) + 1
    ranked = sorted(counts.items(), key=lambda x: (-x[1], x[0]))
    return [a for a, _ in ranked[:limit]]


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/analyze")
async def analyze(body: AnalyzeBody) -> dict[str, Any]:
    addr = body.address.strip()
    if not addr.startswith("0x") or len(addr) != 42:
        raise HTTPException(status_code=400, detail="Invalid address format")

    limit = body.neighbor_limit or settings.neighbor_limit
    if body.depth == 2:
        limit = min(64, limit * 2)

    try:
        seed_txs = await fetch_transactions(
            addr, use_cache=True, force_refresh=body.force_refresh
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        logger.exception("fetch seed")
        raise HTTPException(status_code=502, detail=f"Upstream error: {e}") from e

    txs_map: dict[str, list[dict[str, Any]]] = {addr.lower(): seed_txs}
    neighbor_meta: list[dict[str, Any]] = []

    if body.depth >= 1:
        neighbors = _top_neighbors(addr.lower(), seed_txs, limit)

        async def _fetch_neighbor(
            nb: str,
        ) -> tuple[str, list[dict[str, Any]] | None, dict[str, Any] | None]:
            nb_l = nb.lower()
            try:
                nb_txs = await fetch_transactions(
                    nb,
                    use_cache=not body.force_refresh,
                    force_refresh=body.force_refresh,
                )
                return (
                    nb_l,
                    nb_txs,
                    {"address": nb_l, "tx_count": len(nb_txs)},
                )
            except Exception as e:
                logger.warning("neighbor fetch failed %s: %s", nb, e)
                cached = load_cached_transactions(nb)
                if cached is not None:
                    return (
                        nb_l,
                        cached,
                        {
                            "address": nb_l,
                            "tx_count": len(cached),
                            "from_cache_only": True,
                        },
                    )
                return (nb_l, None, None)

        gathered = await asyncio.gather(*(_fetch_neighbor(nb) for nb in neighbors))
        for nb_l, txs, meta in gathered:
            if txs is not None and meta is not None:
                txs_map[nb_l] = txs
                neighbor_meta.append(meta)

    seed_lower = addr.lower()
    heur = run_all(seed_txs, seed_lower)
    wallet_score = wallet_risk_score(heur)

    graph = build_graph_from_txs(txs_map, seed_lower)

    wallet_scores_list = [wallet_score["score"]]
    per_wallet_risk: dict[str, Any] = {seed_lower: wallet_score}
    for nb in neighbor_meta:
        a = nb["address"]
        txs_nb = txs_map.get(a, [])
        h = run_all(txs_nb, a)
        wr = wallet_risk_score(h)
        per_wallet_risk[a] = wr
        wallet_scores_list.append(wr["score"])

    cluster = cluster_risk_score(wallet_scores_list)

    return {
        "address": seed_lower,
        "depth": body.depth,
        "chain_id": settings.chain_id,
        "risk": {
            "wallet": wallet_score,
            "cluster": cluster,
        },
        "heuristics": heur,
        "per_wallet": per_wallet_risk,
        "neighbors": neighbor_meta,
        "graph": graph,
    }


@app.get("/graph")
async def graph_json(
    address: str = Query(..., description="Seed address"),
    depth: int = Query(1, ge=0, le=2),
) -> dict[str, Any]:
    """Return graph only (lighter than /analyze)."""
    body = AnalyzeBody(address=address, depth=depth, force_refresh=False)
    data = await analyze(body)
    return data["graph"]


if FRONTEND.is_dir():
    app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")


@app.get("/")
async def index() -> FileResponse:
    index_path = FRONTEND / "index.html"
    if not index_path.is_file():
        raise HTTPException(status_code=404, detail="frontend/index.html not found")
    return FileResponse(index_path)
