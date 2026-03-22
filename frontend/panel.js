/**
 * Risk panel: wallet + cluster scores, heuristic breakdown, neighbor list.
 */
(function () {
  const host = document.getElementById("panel-host");
  let tipHideTimer = null;
  let tipGlobalListenersBound = false;

  function riskColor(label) {
    if (label === "high") return "var(--risk-high)";
    if (label === "medium") return "var(--risk-mid)";
    return "var(--risk-low)";
  }

  const WALLET_RISK_INFO =
    "<strong>0–100</strong> score for the <strong>seed wallet</strong> only, based on the loaded history (heuristic; not a legal or exhaustive assessment). " +
    "Four normalized signals (0–1) are combined: <strong>28%</strong> deployer strength (contracts created), <strong>32%</strong> relayer strength (diversity of outgoing destinations), " +
    "<strong>20%</strong> temporal bursts, <strong>20%</strong> inbound fund concentration (share of native inflow from the largest single sender). " +
    "The low / medium / high label uses thresholds at <strong>40</strong> and <strong>70</strong>.";

  const CLUSTER_RISK_INFO =
    "Summarizes <strong>all wallets</strong> in this analysis (seed + expanded neighbors). " +
    "Formula: <strong>65%</strong> × the highest <em>wallet risk</em> in the group + <strong>35%</strong> × the mean of those <em>wallet risk</em> scores, rounded and capped at 100. " +
    "It weights the hottest wallet in the cluster. Same label thresholds: <strong>40</strong> and <strong>70</strong>.";

  function section(title, bodyHtml, infoOpts) {
    const tip = infoOpts && infoOpts.html
      ? '<span class="panel-info">' +
        '<span class="panel-info-btn" tabindex="0" role="button" aria-label="' +
        escapeHtml(infoOpts.aria || "Information") +
        '">i</span>' +
        '<span class="panel-info-tip-src" aria-hidden="true">' +
        infoOpts.html +
        "</span></span>"
      : "";
    return (
      '<section style="padding:0.75rem 1rem;border-bottom:1px solid var(--border);">' +
      '<h2 class="panel-h2">' +
      escapeHtml(title) +
      tip +
      "</h2>" +
      bodyHtml +
      "</section>"
    );
  }

  function hidePanelTooltipPortal() {
    clearTimeout(tipHideTimer);
    tipHideTimer = null;
    const portal = document.getElementById("panel-tooltip-portal");
    if (!portal) return;
    portal.hidden = true;
    portal.innerHTML = "";
    portal.style.visibility = "";
  }

  function positionFixedTooltip(btn, portal) {
    const rect = btn.getBoundingClientRect();
    const margin = 10;
    portal.removeAttribute("hidden");
    portal.style.left = "0px";
    portal.style.top = "0px";
    portal.style.visibility = "hidden";
    const tw = portal.offsetWidth;
    const th = portal.offsetHeight;
    let left = rect.left;
    let top = rect.bottom + margin;
    if (top + th > window.innerHeight - margin) {
      top = rect.top - th - margin;
    }
    if (top < margin) {
      top = margin;
    }
    if (left + tw > window.innerWidth - margin) {
      left = window.innerWidth - tw - margin;
    }
    if (left < margin) {
      left = margin;
    }
    if (top + th > window.innerHeight - margin) {
      top = window.innerHeight - th - margin;
    }
    portal.style.left = Math.round(left) + "px";
    portal.style.top = Math.round(top) + "px";
    portal.style.visibility = "visible";
  }

  function showPanelTooltip(btn) {
    const wrap = btn.closest(".panel-info");
    const src = wrap && wrap.querySelector(".panel-info-tip-src");
    const portal = document.getElementById("panel-tooltip-portal");
    if (!src || !portal) return;
    portal.innerHTML = src.innerHTML;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        positionFixedTooltip(btn, portal);
      });
    });
  }

  function scheduleHideTooltip() {
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(hidePanelTooltipPortal, 120);
  }

  function bindPanelInfoTooltips(root) {
    if (!root) return;
    root.querySelectorAll(".panel-info-btn").forEach((btn) => {
      if (btn.dataset.tipBound === "1") return;
      btn.dataset.tipBound = "1";
      btn.addEventListener("mouseenter", () => {
        clearTimeout(tipHideTimer);
        showPanelTooltip(btn);
      });
      btn.addEventListener("mouseleave", scheduleHideTooltip);
      btn.addEventListener("focus", () => {
        clearTimeout(tipHideTimer);
        showPanelTooltip(btn);
      });
      btn.addEventListener("blur", scheduleHideTooltip);
    });
    if (!tipGlobalListenersBound) {
      tipGlobalListenersBound = true;
      window.addEventListener("scroll", hidePanelTooltipPortal, true);
      window.addEventListener("resize", hidePanelTooltipPortal);
    }
  }

  window.renderPanel = function renderPanel(data) {
    if (!host) return;

    if (data.loading) {
      hidePanelTooltipPortal();
      host.innerHTML =
        '<div style="padding:1rem;color:var(--muted);">Loading…</div>';
      return;
    }

    if (data.error) {
      hidePanelTooltipPortal();
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
    const fund = heur.fund_concentration || {};

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

    html += section("Wallet risk", scoreBlock("wallet", wr), {
      aria: "How wallet risk is calculated",
      html: WALLET_RISK_INFO,
    });
    html += section("Cluster risk", scoreBlock("cluster", cr), {
      aria: "How cluster risk is calculated",
      html: CLUSTER_RISK_INFO,
    });

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
        "<li><strong>Fund concentration</strong>: top sender share " +
        escapeHtml(
          fund.top_sender_share != null ? String(fund.top_sender_share) : "—"
        ) +
        (fund.top_sender
          ? " · <code>" + escapeHtml(String(fund.top_sender)) + "</code>"
          : "") +
        " · strength " +
        escapeHtml(String(fund.concentration_strength ?? "—")) +
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
        "</div>" +
        '<div style="margin-top:0.4rem;font-size:0.78rem;color:var(--muted);line-height:1.4;">' +
        "Circle size and hue scale with each wallet’s tx count in this view (teal = light, " +
        "orange/red = heavy). Seed uses a brighter outline." +
        "</div>"
    );

    host.innerHTML = html;
    bindPanelInfoTooltips(host);
  };

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
