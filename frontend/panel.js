/**
 * Risk panel: wallet + cluster scores, heuristic breakdown, neighbor list.
 */
(function () {
  const host = document.getElementById("panel-host");

  function riskColor(label) {
    if (label === "high") return "var(--risk-high)";
    if (label === "medium") return "var(--risk-mid)";
    return "var(--risk-low)";
  }

  function section(title, bodyHtml) {
    return (
      '<section style="padding:0.75rem 1rem;border-bottom:1px solid var(--border);">' +
      '<h2 style="margin:0 0 0.5rem;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);">' +
      title +
      "</h2>" +
      bodyHtml +
      "</section>"
    );
  }

  window.renderPanel = function renderPanel(data) {
    if (!host) return;

    if (data.loading) {
      host.innerHTML =
        '<div style="padding:1rem;color:var(--muted);">Loading…</div>';
      return;
    }

    if (data.error) {
      host.innerHTML =
        '<div style="padding:1rem;color:var(--risk-high);">' +
        escapeHtml(String(data.error)) +
        "</div>";
      return;
    }

    const wr = (data.risk && data.risk.wallet) || {};
    const cr = (data.risk && data.risk.cluster) || {};
    const heur = data.heuristics || {};
    const dep = heur.deployer || {};
    const rel = heur.relayer || {};
    const tim = heur.timing || {};

    const scoreBlock = (label, obj) => {
      const sc = obj.score != null ? obj.score : "—";
      const lb = obj.label || "";
      return (
        '<div style="display:flex;align-items:baseline;gap:0.5rem;">' +
        '<span style="font-size:2rem;font-weight:700;color:' +
        riskColor(lb) +
        ';">' +
        sc +
        "</span>" +
        '<span style="color:var(--muted);">/ 100 · ' +
        escapeHtml(lb) +
        "</span>" +
        "</div>"
      );
    };

    let html = "";
    html += section(
      "Seed address",
      '<code style="word-break:break-all;font-size:0.85rem;">' +
        escapeHtml(String(data.address || "")) +
        "</code>" +
        '<div style="margin-top:0.35rem;font-size:0.8rem;color:var(--muted);">chain ' +
        escapeHtml(String(data.chain_id ?? "")) +
        " · depth " +
        escapeHtml(String(data.depth ?? "")) +
        "</div>"
    );

    html += section("Wallet risk", scoreBlock("wallet", wr));
    html += section("Cluster risk", scoreBlock("cluster", cr));

    html += section(
      "Heuristics (seed)",
      '<ul style="margin:0;padding-left:1.1rem;font-size:0.88rem;line-height:1.5;">' +
        "<li><strong>Deployer</strong>: " +
        escapeHtml(String(dep.contract_deployments ?? 0)) +
        " deployments · strength " +
        escapeHtml(String(dep.deployer_strength ?? "—")) +
        "</li>" +
        "<li><strong>Relayer</strong>: " +
        escapeHtml(String(rel.unique_out_destinations ?? "—")) +
        " unique out-destinations · strength " +
        escapeHtml(String(rel.relayer_strength ?? "—")) +
        "</li>" +
        "<li><strong>Timing</strong>: burst " +
        escapeHtml(String(tim.burst_score ?? "—")) +
        " · txs " +
        escapeHtml(String(tim.tx_count ?? "—")) +
        "</li>" +
        "</ul>"
    );

    const neigh = data.neighbors || [];
    if (neigh.length) {
      const rows = neigh
        .map(
          (n) =>
            "<li><code>" +
            escapeHtml(String(n.address || "")) +
            "</code> · " +
            escapeHtml(String(n.tx_count ?? "")) +
            " txs" +
            (n.from_cache_only ? " (cache)" : "") +
            "</li>"
        )
        .join("");
      html += section(
        "Expanded wallets",
        "<ul style=\"margin:0;padding-left:1.1rem;font-size:0.85rem;\">" +
          rows +
          "</ul>"
      );
    }

    html += section(
      "Graph",
      '<div style="font-size:0.88rem;color:var(--muted);">Nodes: ' +
        escapeHtml(String((data.graph && data.graph.node_count) ?? "—")) +
        " · Edges: " +
        escapeHtml(String((data.graph && data.graph.edge_count) ?? "—")) +
        "</div>"
    );

    host.innerHTML = html;
  };

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
