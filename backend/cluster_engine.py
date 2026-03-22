"""
Build a directed multigraph summary from normalized transactions.
Nodes = addresses; edges = aggregated flows between pairs (seed neighborhood).
"""

from __future__ import annotations

from typing import Any


def _add_edge(
    edges: dict[tuple[str, str], dict[str, Any]],
    src: str,
    dst: str,
    wei: int,
    tx_hash: str,
) -> None:
    key = (src, dst)
    if key not in edges:
        edges[key] = {
            "source": src,
            "target": dst,
            "tx_count": 0,
            "value_wei": 0,
            "tx_hashes_sample": [],
        }
    e = edges[key]
    e["tx_count"] += 1
    e["value_wei"] += wei
    if len(e["tx_hashes_sample"]) < 12 and tx_hash:
        e["tx_hashes_sample"].append(tx_hash)


def build_graph_from_txs(
    txs_by_address: dict[str, list[dict[str, Any]]],
    seed: str,
) -> dict[str, Any]:
    seed_l = seed.lower()
    nodes: dict[str, dict[str, Any]] = {}
    edges_map: dict[tuple[str, str], dict[str, Any]] = {}

    def ensure_node(addr: str, role: str | None = None) -> None:
        if addr not in nodes:
            nodes[addr] = {"id": addr, "label": addr[:6] + "…" + addr[-4:], "role": role or "peer"}
        elif role == "seed":
            nodes[addr]["role"] = "seed"

    ensure_node(seed_l, "seed")

    for addr, txs in txs_by_address.items():
        addr_l = addr.lower()
        ensure_node(addr_l, "seed" if addr_l == seed_l else "cluster")
        for tx in txs:
            if tx.get("isError") == "1":
                continue
            f = (tx.get("from") or "").lower()
            t = (tx.get("to") or "").lower()
            if not f:
                continue
            try:
                wei = int(tx.get("value") or 0)
            except (TypeError, ValueError):
                wei = 0
            h = str(tx.get("hash") or "")
            if t:
                ensure_node(f)
                ensure_node(t)
                _add_edge(edges_map, f, t, wei, h)
            else:
                # contract creation: still link from creator
                ensure_node(f)

    # Keep subgraph connected to seed: edges incident to seed + direct neighbors
    neighbor_addrs: set[str] = set()
    for (a, b), e in list(edges_map.items()):
        if a == seed_l or b == seed_l:
            neighbor_addrs.add(a)
            neighbor_addrs.add(b)

    filtered_edges: list[dict[str, Any]] = []
    for (a, b), e in edges_map.items():
        if e["tx_count"] == 0:
            continue
        if a == seed_l or b == seed_l or (a in neighbor_addrs and b in neighbor_addrs):
            filtered_edges.append(
                {
                    "source": e["source"],
                    "target": e["target"],
                    "tx_count": e["tx_count"],
                    "value_wei": e["value_wei"],
                    "value_eth": round(e["value_wei"] / 10**18, 6),
                    "tx_hashes_sample": e["tx_hashes_sample"],
                }
            )

    # Prune nodes with no incident filtered edge (except seed)
    incident: set[str] = {seed_l}
    for e in filtered_edges:
        incident.add(e["source"])
        incident.add(e["target"])

    nodes_out = [nodes[k] for k in nodes if k in incident]

    return {
        "seed": seed_l,
        "node_count": len(nodes_out),
        "edge_count": len(filtered_edges),
        "nodes": nodes_out,
        "edges": filtered_edges,
    }


def merge_tx_maps(*maps: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for m in maps:
        for k, v in m.items():
            out[k.lower()] = v
    return out
