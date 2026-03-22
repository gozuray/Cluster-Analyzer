"""
FastAPI app: /analyze (full report), /graph (graph JSON), static frontend.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .cluster_engine import build_graph_from_txs
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


def _assemble_report(
    seed_lower: str,
    depth: int,
    txs_map: dict[str, list[dict[str, Any]]],
    neighbor_meta: list[dict[str, Any]],
) -> dict[str, Any]:
    seed_txs = txs_map[seed_lower]
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
        "depth": depth,
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


async def _fetch_neighbors_sequential(
    seed_lower: str,
    seed_txs: list[dict[str, Any]],
    neighbors: list[str],
    *,
    neighbor_force_refresh: bool,
) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    txs_map: dict[str, list[dict[str, Any]]] = {seed_lower: seed_txs}
    neighbor_meta: list[dict[str, Any]] = []
    for nb in neighbors:
        nb_l = nb.lower()
        try:
            nb_txs = await fetch_transactions(
                nb,
                use_cache=True,
                force_refresh=neighbor_force_refresh,
            )
            neighbor_meta.append({"address": nb_l, "tx_count": len(nb_txs)})
            txs_map[nb_l] = nb_txs
        except Exception as e:
            logger.warning("neighbor fetch failed %s: %s", nb, e)
            cached = load_cached_transactions(nb)
            if cached is not None:
                txs_map[nb_l] = cached
                neighbor_meta.append(
                    {
                        "address": nb_l,
                        "tx_count": len(cached),
                        "from_cache_only": True,
                    }
                )
    return txs_map, neighbor_meta


async def _refresh_stale_neighbors(
    txs_map: dict[str, list[dict[str, Any]]],
    neighbor_meta: list[dict[str, Any]],
) -> tuple[int, int]:
    """Retry network fetch for neighbors marked from_cache_only. Returns (ok, failed)."""
    ok = 0
    failed = 0
    for m in neighbor_meta:
        if not m.get("from_cache_only"):
            continue
        a = m["address"]
        try:
            nb_txs = await fetch_transactions(
                a, use_cache=True, force_refresh=True
            )
            txs_map[a] = nb_txs
            m["tx_count"] = len(nb_txs)
            del m["from_cache_only"]
            ok += 1
        except Exception as e:
            logger.warning("stale neighbor refresh failed %s: %s", a, e)
            failed += 1
    return ok, failed


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

    seed_lower = addr.lower()

    try:
        seed_txs = await fetch_transactions(
            addr, use_cache=True, force_refresh=body.force_refresh
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        logger.exception("fetch seed")
        raise HTTPException(status_code=502, detail=f"Upstream error: {e}") from e

    txs_map: dict[str, list[dict[str, Any]]] = {seed_lower: seed_txs}
    neighbor_meta: list[dict[str, Any]] = []

    if body.depth >= 1:
        neighbors = _top_neighbors(seed_lower, seed_txs, limit)
        txs_map, neighbor_meta = await _fetch_neighbors_sequential(
            seed_lower,
            seed_txs,
            neighbors,
            neighbor_force_refresh=body.force_refresh,
        )

    stale_ok, stale_fail = await _refresh_stale_neighbors(txs_map, neighbor_meta)

    out = _assemble_report(seed_lower, body.depth, txs_map, neighbor_meta)
    if stale_ok or stale_fail:
        out["sync_note"] = {
            "stale_refreshed": stale_ok,
            "stale_still_cached": stale_fail,
        }
    return out


async def _analyze_event_bytes(body: AnalyzeBody) -> AsyncIterator[bytes]:
    def sse(obj: dict[str, Any]) -> bytes:
        return f"data: {json.dumps(obj, default=str)}\n\n".encode("utf-8")

    addr = body.address.strip()
    if not addr.startswith("0x") or len(addr) != 42:
        yield sse({"event": "error", "detail": "Invalid address format"})
        return

    limit = body.neighbor_limit or settings.neighbor_limit
    if body.depth == 2:
        limit = min(64, limit * 2)
    seed_lower = addr.lower()

    yield sse({"event": "status", "sync": {"phase": "started", "message": "Starting…"}})

    preview_emitted = False
    if not body.force_refresh:
        cached_seed = load_cached_transactions(addr)
        if cached_seed is not None:
            txs_pre: dict[str, list[dict[str, Any]]] = {seed_lower: cached_seed}
            meta_pre: list[dict[str, Any]] = []
            if body.depth >= 1:
                for nb in _top_neighbors(seed_lower, cached_seed, limit):
                    c = load_cached_transactions(nb)
                    if c is not None:
                        nl = nb.lower()
                        txs_pre[nl] = c
                        meta_pre.append(
                            {
                                "address": nl,
                                "tx_count": len(c),
                                "from_cache_only": True,
                            }
                        )
            report = _assemble_report(seed_lower, body.depth, txs_pre, meta_pre)
            yield sse(
                {
                    "event": "snapshot",
                    "data": report,
                    "sync": {
                        "phase": "cached_preview",
                        "message": "Showing cached snapshot; syncing with the network…",
                    },
                }
            )
            preview_emitted = True

    seed_force = body.force_refresh or preview_emitted
    try:
        seed_txs = await fetch_transactions(
            addr, use_cache=True, force_refresh=seed_force
        )
    except RuntimeError as e:
        yield sse({"event": "error", "detail": str(e)})
        return
    except Exception as e:
        logger.exception("stream fetch seed")
        yield sse({"event": "error", "detail": f"Upstream error: {e}"})
        return

    txs_map = {seed_lower: seed_txs}
    neighbor_meta: list[dict[str, Any]] = []
    nb_force = body.force_refresh or preview_emitted

    report = _assemble_report(seed_lower, body.depth, txs_map, neighbor_meta)
    yield sse(
        {
            "event": "snapshot",
            "data": report,
            "sync": {
                "phase": "syncing",
                "step": "seed",
                "message": "Seed wallet data loaded from the network.",
            },
        }
    )

    if body.depth < 1:
        yield sse(
            {
                "event": "done",
                "message": "Analysis complete. Seed wallet is up to date.",
            }
        )
        return

    neighbors = _top_neighbors(seed_lower, seed_txs, limit)
    n_total = len(neighbors)

    for i, nb in enumerate(neighbors):
        nb_l = nb.lower()
        try:
            nb_txs = await fetch_transactions(
                nb, use_cache=True, force_refresh=nb_force
            )
            neighbor_meta.append({"address": nb_l, "tx_count": len(nb_txs)})
            txs_map[nb_l] = nb_txs
        except Exception as e:
            logger.warning("neighbor fetch failed %s: %s", nb, e)
            cached = load_cached_transactions(nb)
            if cached is not None:
                txs_map[nb_l] = cached
                neighbor_meta.append(
                    {
                        "address": nb_l,
                        "tx_count": len(cached),
                        "from_cache_only": True,
                    }
                )

        report = _assemble_report(seed_lower, body.depth, txs_map, neighbor_meta)
        yield sse(
            {
                "event": "snapshot",
                "data": report,
                "sync": {
                    "phase": "syncing",
                    "step": "neighbor",
                    "index": i + 1,
                    "total": n_total,
                    "message": f"Loaded neighbor {i + 1} of {n_total}…",
                },
            }
        )

    stale = [m for m in neighbor_meta if m.get("from_cache_only")]
    if stale:
        yield sse(
            {
                "event": "status",
                "sync": {
                    "phase": "background_refresh",
                    "message": "Refreshing wallets that fell back to cache…",
                },
            }
        )
        stale_ok, stale_fail = await _refresh_stale_neighbors(txs_map, neighbor_meta)
        report = _assemble_report(seed_lower, body.depth, txs_map, neighbor_meta)
        yield sse(
            {
                "event": "snapshot",
                "data": report,
                "sync": {
                    "phase": "syncing",
                    "step": "stale_refresh",
                    "message": "Updated cache-only neighbors where possible.",
                    "stale_refreshed": stale_ok,
                    "stale_still_cached": stale_fail,
                },
            }
        )
        if stale_fail == 0:
            done_msg = (
                "Sync complete: all expanded wallets now match the latest on-chain fetch."
            )
        else:
            done_msg = (
                "Sync finished; some neighbors could not be refreshed (still cache-only)."
            )
    else:
        done_msg = "Sync complete: all expanded wallets loaded from the network."

    yield sse({"event": "done", "message": done_msg})


@app.post("/analyze/stream")
async def analyze_stream(body: AnalyzeBody) -> StreamingResponse:
    """Server-Sent Events: progressive snapshots + final confirmation."""

    async def gen() -> AsyncIterator[bytes]:
        async for chunk in _analyze_event_bytes(body):
            yield chunk

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


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
