"""
Aggregate heuristics into a 0–100 risk score for a wallet (and optional cluster rollup).
"""

from __future__ import annotations

from typing import Any

# Sum to 1.0 — prior 35/40/25 split among first three scaled by 0.8, plus 20% fund concentration
_W_DEPLOYER = 0.28
_W_RELAYER = 0.32
_W_TIMING = 0.20
_W_FUND = 0.20


def wallet_risk_score(heuristic_bundle: dict[str, Any]) -> dict[str, Any]:
    d = heuristic_bundle.get("deployer", {})
    r = heuristic_bundle.get("relayer", {})
    t = heuristic_bundle.get("timing", {})
    fc = heuristic_bundle.get("fund_concentration", {})

    deployer_strength = float(d.get("deployer_strength", 0.0))
    relayer_strength = float(r.get("relayer_strength", 0.0))
    burst = float(t.get("burst_score", 0.0))
    concentration = float(fc.get("concentration_strength", 0.0))

    score_01 = (
        _W_DEPLOYER * deployer_strength
        + _W_RELAYER * relayer_strength
        + _W_TIMING * burst
        + _W_FUND * concentration
    )
    score_100 = int(round(max(0.0, min(1.0, score_01)) * 100))

    label = "low"
    if score_100 >= 70:
        label = "high"
    elif score_100 >= 40:
        label = "medium"

    return {
        "score": score_100,
        "label": label,
        "components": {
            "deployer_weighted": round(_W_DEPLOYER * deployer_strength * 100, 1),
            "relayer_weighted": round(_W_RELAYER * relayer_strength * 100, 1),
            "timing_weighted": round(_W_TIMING * burst * 100, 1),
            "fund_concentration_weighted": round(_W_FUND * concentration * 100, 1),
        },
    }


def cluster_risk_score(wallet_scores: list[int]) -> dict[str, Any]:
    if not wallet_scores:
        return {"score": 0, "label": "low", "max_wallet": 0, "avg_wallet": 0.0}
    mx = max(wallet_scores)
    avg = sum(wallet_scores) / len(wallet_scores)
    # Cluster score: emphasize worst actor
    blended = min(100, int(round(0.65 * mx + 0.35 * avg)))
    label = "low"
    if blended >= 70:
        label = "high"
    elif blended >= 40:
        label = "medium"
    return {
        "score": blended,
        "label": label,
        "max_wallet": mx,
        "avg_wallet": round(avg, 1),
    }
