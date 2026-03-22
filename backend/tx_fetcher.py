"""
Fetch normal transactions via Etherscan-compatible API (V2 + chainid).
Caches per-wallet JSON under cache/<address_lower>.json
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from .config import settings

logger = logging.getLogger(__name__)


def _cache_path(address: str) -> Path:
    return settings.cache_dir / f"{address.lower()}.json"


def _normalize_tx(raw: dict[str, Any]) -> dict[str, Any]:
    """Keep a stable subset for graph + heuristics."""
    return {
        "hash": raw.get("hash", ""),
        "from": (raw.get("from") or "").lower(),
        "to": (raw.get("to") or "").lower(),
        "value": str(raw.get("value", "0")),
        "timeStamp": str(raw.get("timeStamp", "0")),
        "isError": raw.get("isError", "0"),
        "txreceipt_status": raw.get("txreceipt_status", ""),
        "input": raw.get("input") or "0x",
        "nonce": raw.get("nonce", ""),
        "blockNumber": raw.get("blockNumber", ""),
    }


async def fetch_transactions(
    address: str,
    *,
    use_cache: bool = True,
    force_refresh: bool = False,
) -> list[dict[str, Any]]:
    """
    Return normalized transactions for `address` (lowercased keys in from/to).
    Uses JSON cache when use_cache and file exists unless force_refresh.
    """
    addr = address.lower()
    path = _cache_path(addr)

    if use_cache and path.is_file() and not force_refresh:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            txs = data.get("transactions", [])
            if isinstance(txs, list):
                return txs
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("cache read failed %s: %s", path, e)

    if not settings.etherscan_api_key:
        raise RuntimeError(
            "ETHERSCAN_API_KEY is not set. Add it to .env or the environment."
        )

    all_rows: list[dict[str, Any]] = []
    page = 1

    async with httpx.AsyncClient(timeout=60.0) as client:
        while page <= settings.max_tx_pages:
            params = {
                "chainid": settings.chain_id,
                "module": "account",
                "action": "txlist",
                "address": addr,
                "startblock": 0,
                "endblock": 99999999,
                "page": page,
                "offset": settings.tx_page_size,
                "sort": "asc",
                "apikey": settings.etherscan_api_key,
            }
            r = await client.get(settings.etherscan_base_url, params=params)
            r.raise_for_status()
            body = r.json()
            status = str(body.get("status", ""))
            message = str(body.get("message", ""))
            result = body.get("result")

            if status == "0" and message == "No transactions found":
                break
            if status != "1" or not isinstance(result, list):
                err = body.get("result", message)
                raise RuntimeError(f"Etherscan error: {message} — {err}")

            if not result:
                break

            for row in result:
                if isinstance(row, dict):
                    all_rows.append(_normalize_tx(row))

            if len(result) < settings.tx_page_size:
                break
            page += 1
            time.sleep(0.22)  # stay under free-tier rate limits

    payload = {
        "address": addr,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "chain_id": settings.chain_id,
        "transactions": all_rows,
    }
    settings.cache_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    return all_rows


def load_cached_transactions(address: str) -> list[dict[str, Any]] | None:
    path = _cache_path(address.lower())
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        txs = data.get("transactions")
        return txs if isinstance(txs, list) else None
    except (json.JSONDecodeError, OSError):
        return None
