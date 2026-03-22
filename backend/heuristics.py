"""
AML-style heuristics: deployer (contract creation), relayer (fan-out), timing (bursts),
fund concentration (share of inbound native volume from the largest single sender).
Returns structured signals in [0, 1] where useful for scoring.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from typing import Any


def _ts(tx: dict[str, Any]) -> int:
    try:
        return int(tx.get("timeStamp") or 0)
    except (TypeError, ValueError):
        return 0


def deployer_signals(txs: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Contract deployments in normal tx list have empty `to`.
    Count deployments and whether seed behaves as repeated deployer.
    """
    deployments = 0
    for tx in txs:
        if tx.get("isError") == "1":
            continue
        to_val = (tx.get("to") or "").strip()
        if to_val == "":
            deployments += 1

    total = max(len([t for t in txs if t.get("isError") != "1"]), 1)
    deploy_ratio = deployments / total
    # Repeated deployer pattern: several contract creations
    deployer_strength = min(1.0, deployments / 5.0) * 0.7 + min(1.0, deploy_ratio * 3.0) * 0.3

    return {
        "contract_deployments": deployments,
        "deploy_ratio": round(deploy_ratio, 4),
        "deployer_strength": round(deployer_strength, 4),
    }


def relayer_signals(txs: list[dict[str, Any]], seed: str) -> dict[str, Any]:
    """
    High fan-out: many unique counterparties (especially small value outflows) in a window.
    """
    seed_l = seed.lower()
    out_by_dest: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for tx in txs:
        if tx.get("isError") == "1":
            continue
        f = (tx.get("from") or "").lower()
        t = (tx.get("to") or "").lower()
        if f != seed_l or not t:
            continue
        try:
            wei = int(tx.get("value") or 0)
        except (TypeError, ValueError):
            wei = 0
        out_by_dest[t].append({**tx, "_wei": wei})

    unique_dest = len(out_by_dest)
    total_out = sum(len(v) for v in out_by_dest.values())
    small_count = 0
    for dest, items in out_by_dest.items():
        for it in items:
            if it["_wei"] <= 10**17:  # <= 0.1 ETH — heuristic threshold
                small_count += 1

    fan_out_ratio = unique_dest / max(total_out, 1)
    small_ratio = small_count / max(total_out, 1)

    # Relayer-like: many destinations, many small txs
    relayer_strength = min(1.0, unique_dest / 40.0) * 0.55 + min(1.0, small_ratio * 2.5) * 0.45

    return {
        "unique_out_destinations": unique_dest,
        "outgoing_count": total_out,
        "small_value_out_ratio": round(small_ratio, 4),
        "fan_out_ratio": round(fan_out_ratio, 4),
        "relayer_strength": round(relayer_strength, 4),
    }


def timing_signals(txs: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Burst activity: many txs in short sliding windows (potential automation / mixer behavior).
    """
    ok = [t for t in txs if t.get("isError") != "1"]
    if len(ok) < 2:
        return {
            "tx_count": len(ok),
            "burst_score": 0.0,
            "median_gap_seconds": None,
        }

    times = sorted(_ts(t) for t in ok)
    gaps = [b - a for a, b in zip(times, times[1:]) if b >= a]
    median_gap = statistics.median(gaps) if gaps else None

    # Count txs in 1-hour windows (sliding coarse grid)
    window = 3600
    burst_score = 0.0
    if times:
        i = 0
        for start in range(times[0], times[-1] + 1, window):
            end = start + window
            while i < len(times) and times[i] < start:
                i += 1
            j = i
            while j < len(times) and times[j] < end:
                j += 1
            cnt = j - i
            if cnt >= 8:
                burst_score = max(burst_score, min(1.0, (cnt - 8) / 32.0))

    return {
        "tx_count": len(ok),
        "median_gap_seconds": float(median_gap) if median_gap is not None else None,
        "burst_score": round(burst_score, 4),
    }


def fund_concentration_signals(txs: list[dict[str, Any]], seed: str) -> dict[str, Any]:
    """
    Inbound native value (wei) by counterparty: classic AML-style single-source funding heuristic.
    """
    seed_l = seed.lower()
    by_from: dict[str, int] = defaultdict(int)
    inbound_with_value = 0
    for tx in txs:
        if tx.get("isError") == "1":
            continue
        f = (tx.get("from") or "").lower()
        t = (tx.get("to") or "").lower()
        if not f or f == seed_l or t != seed_l:
            continue
        try:
            wei = int(tx.get("value") or 0)
        except (TypeError, ValueError):
            wei = 0
        if wei <= 0:
            continue
        inbound_with_value += 1
        by_from[f] += wei

    total_in = sum(by_from.values())
    if total_in <= 0 or not by_from:
        return {
            "inbound_native_count": 0,
            "unique_inbound_senders": 0,
            "total_inbound_wei": 0,
            "top_sender": None,
            "top_sender_share": None,
            "concentration_strength": 0.0,
        }

    top_sender, top_wei = max(by_from.items(), key=lambda kv: kv[1])
    share = top_wei / total_in
    # Risk rises when most inbound volume is from one address (interpretive, not a legal test)
    strength = min(1.0, max(0.0, (share - 0.5) / 0.45))

    return {
        "inbound_native_count": inbound_with_value,
        "unique_inbound_senders": len(by_from),
        "total_inbound_wei": total_in,
        "top_sender": top_sender,
        "top_sender_share": round(share, 4),
        "concentration_strength": round(strength, 4),
    }


def run_all(txs: list[dict[str, Any]], seed: str) -> dict[str, Any]:
    return {
        "deployer": deployer_signals(txs),
        "relayer": relayer_signals(txs, seed),
        "timing": timing_signals(txs),
        "fund_concentration": fund_concentration_signals(txs, seed),
    }
