# Methodology

## What is a "cluster"?

Wallets are linked by shared activity neighbors up to configurable depth (0–2).

Not a definitive legal cluster — a behavioral hypothesis for investigation.

## How cluster risk is aggregated

Wallet scores for the seed and each expanded neighbor are rolled up into one cluster score: **65%** × the highest wallet score in the set **+ 35%** × the mean of those scores (capped at 100). That emphasizes the worst wallet while still reflecting the group.

No ground truth validation; scores are relative, not absolute thresholds.

## Known limitations

- Only sees what the Etherscan API returns (no mempool, no L2, no off-chain data)
- Cache is local JSON; stale data possible without `force_refresh`
- Depth > 2 is computationally expensive and not recommended
- Heuristics are not trained on labeled AML datasets
