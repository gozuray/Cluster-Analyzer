/**
 * D3 force-directed graph: smooth updates (position carry-over, gentle reheat),
 * node size + color from wallet_tx_count.
 */
(function () {
  const host = document.getElementById("graph-host");
  let simulation = null;
  let svg = null;
  let gRoot = null;
  let linkG = null;
  let nodeG = null;
  let zoom = null;
  let width = 800;
  let height = 600;
  /** @type {Map<string, {x:number,y:number,vx:number,vy:number}>} */
  const positionCache = new Map();
  let lastGraphSeed = "";
  /** Last graph payload for resize relayout */
  let lastGraphPayload = null;

  /**
   * While dragging a node: incident links tighten + neighbors are pulled toward the hub,
   * biased slightly opposite drag motion so they trail behind.
   */
  const graphDragState = {
    active: false,
    hub: null,
    /** @type {any[]} */
    neighbors: [],
    velX: 0,
    velY: 0,
    lastX: 0,
    lastY: 0,
  };

  function collectNeighborNodes(hub, edgeList) {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < edgeList.length; i++) {
      const e = edgeList[i];
      if (e.source === hub) {
        const t = e.target;
        if (t && t !== hub && !seen.has(t.id)) {
          seen.add(t.id);
          out.push(t);
        }
      } else if (e.target === hub) {
        const s = e.source;
        if (s && s !== hub && !seen.has(s.id)) {
          seen.add(s.id);
          out.push(s);
        }
      }
    }
    return out;
  }

  function measureHostSize() {
    if (!host) return { w: 800, h: 500 };
    const rect = host.getBoundingClientRect();
    let w = Math.max(200, Math.floor(rect.width || host.clientWidth || 0));
    let h = Math.floor(rect.height || 0);
    if (h < 120) {
      h = Math.max(
        400,
        Math.floor(window.innerHeight - (rect.top || 0) - 24)
      );
    }
    h = Math.max(320, h);
    return { w, h };
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  /** Etherscan-family explorer base URL by chain id (fallback: mainnet). */
  function explorerBaseForChain(chainId) {
    const id = Number(chainId);
    const map = {
      1: "https://etherscan.io",
      11155111: "https://sepolia.etherscan.io",
      5: "https://goerli.etherscan.io",
      137: "https://polygonscan.com",
      42161: "https://arbiscan.io",
      10: "https://optimistic.etherscan.io",
      8453: "https://basescan.org",
      56: "https://bscscan.com",
      43114: "https://snowtrace.io",
    };
    return map[id] || "https://etherscan.io";
  }

  let popupAddressLower = "";

  function closeNodePopup() {
    const bd = document.getElementById("graph-node-popup-backdrop");
    const pop = document.getElementById("graph-node-popup");
    if (bd) {
      bd.classList.remove("is-open");
      bd.setAttribute("aria-hidden", "true");
    }
    if (pop) pop.classList.remove("is-open");
    popupAddressLower = "";
  }

  function openNodePopup(addressLower, clientX, clientY) {
    const bd = document.getElementById("graph-node-popup-backdrop");
    const pop = document.getElementById("graph-node-popup");
    const addrEl = document.getElementById("graph-node-popup-addr");
    if (!bd || !pop || !addrEl) return;
    popupAddressLower = addressLower;
    addrEl.textContent = addressLower;
    const margin = 12;
    pop.classList.add("is-open");
    bd.classList.add("is-open");
    bd.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      const pw = pop.offsetWidth;
      const ph = pop.offsetHeight;
      let left = clientX + margin;
      let top = clientY + margin;
      if (left + pw > window.innerWidth - margin) {
        left = window.innerWidth - pw - margin;
      }
      if (top + ph > window.innerHeight - margin) {
        top = window.innerHeight - ph - margin;
      }
      if (left < margin) left = margin;
      if (top < margin) top = margin;
      pop.style.left = Math.round(left) + "px";
      pop.style.top = Math.round(top) + "px";
    });
  }

  function bindNodePopupOnce() {
    if (bindNodePopupOnce._done) return;
    bindNodePopupOnce._done = true;
    const bd = document.getElementById("graph-node-popup-backdrop");
    const btnA = document.getElementById("graph-node-popup-analyze");
    const btnE = document.getElementById("graph-node-popup-etherscan");
    if (bd) {
      bd.addEventListener("click", closeNodePopup);
    }
    if (btnA) {
      btnA.addEventListener("click", () => {
        if (!popupAddressLower) return;
        const u = new URL(window.location.href);
        u.search = "";
        u.searchParams.set("address", popupAddressLower);
        u.searchParams.set("depth", "1");
        u.searchParams.set("auto", "1");
        window.open(u.toString(), "_blank", "noopener,noreferrer");
        closeNodePopup();
      });
    }
    if (btnE) {
      btnE.addEventListener("click", () => {
        if (!popupAddressLower) return;
        const chainId =
          typeof window.__clusterAnalyzerChainId === "number"
            ? window.__clusterAnalyzerChainId
            : 1;
        const base = explorerBaseForChain(chainId);
        window.open(
          `${base}/address/${popupAddressLower}`,
          "_blank",
          "noopener,noreferrer"
        );
        closeNodePopup();
      });
    }
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeNodePopup();
    });
  }

  /** Radius from tx count (sublinear, capped). */
  function nodeRadius(d) {
    const n = Math.max(0, Number(d.wallet_tx_count) || 0);
    const base = d.role === "seed" ? 12 : 8;
    const extra = Math.pow(Math.log10(2 + n), 1.35) * 5.2;
    const cap = d.role === "seed" ? 38 : 34;
    return clamp(base + extra, base + 1.5, cap);
  }

  /** Discrete palette: small / cool → large / warm (by visual weight). */
  function nodeFill(d) {
    const r = nodeRadius(d);
    if (d.role === "seed") {
      if (r <= 16) return "#38bdf8";
      if (r <= 22) return "#6366f1";
      if (r <= 28) return "#a855f7";
      return "#f472b6";
    }
    if (r <= 10) return "#14b8a6";
    if (r <= 13) return "#06b6d4";
    if (r <= 16) return "#3b82f6";
    if (r <= 20) return "#8b5cf6";
    if (r <= 25) return "#d946ef";
    if (r <= 30) return "#f97316";
    return "#ef4444";
  }

  function nodeStroke(d) {
    if (d.role === "seed") return "#93c5fd";
    return "#0f172a";
  }

  function nodeStrokeWidth(d) {
    return d.role === "seed" ? 2.5 : 1.75;
  }

  function linkKey(e) {
    const s = typeof e.source === "object" ? e.source.id : e.source;
    const t = typeof e.target === "object" ? e.target.id : e.target;
    return `${String(s)}→${String(t)}`;
  }

  function seedPositions(nodes, w, h) {
    const cx = w / 2;
    const cy = h / 2;
    nodes.forEach((d, i) => {
      const prev = positionCache.get(d.id);
      if (prev && Number.isFinite(prev.x) && Number.isFinite(prev.y)) {
        d.x = prev.x;
        d.y = prev.y;
        d.vx = (prev.vx || 0) * 0.35;
        d.vy = (prev.vy || 0) * 0.35;
      } else {
        const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
        const jitter = 24 + (i % 5) * 6;
        d.x = cx + Math.cos(angle) * jitter;
        d.y = cy + Math.sin(angle) * jitter;
        d.vx = 0;
        d.vy = 0;
      }
    });
  }

  function savePositions(nodes) {
    nodes.forEach((d) => {
      if (d.x != null && d.y != null) {
        positionCache.set(d.id, {
          x: d.x,
          y: d.y,
          vx: d.vx || 0,
          vy: d.vy || 0,
        });
      }
    });
  }

  function tearDown() {
    if (simulation) {
      simulation.stop();
      simulation = null;
    }
    if (host) host.innerHTML = "";
    svg = null;
    gRoot = null;
    linkG = null;
    nodeG = null;
    zoom = null;
  }

  function ensureSvgStructure() {
    svg = d3.select(host).select("svg");
    if (svg.empty()) {
      svg = d3
        .select(host)
        .append("svg")
        .attr("preserveAspectRatio", "xMidYMid meet")
        .attr("style", "width:100%;height:100%;max-height:100%;display:block;");
      gRoot = svg.append("g");
      zoom = d3
        .zoom()
        .scaleExtent([0.3, 5])
        .on("zoom", (event) => {
          gRoot.attr("transform", event.transform);
        });
      svg.call(zoom);
      linkG = gRoot
        .append("g")
        .attr("class", "graph-links")
        .attr("stroke", "#475569")
        .attr("stroke-opacity", 0.55);
      nodeG = gRoot.append("g").attr("class", "graph-nodes");
    } else {
      const rootNode = svg.node();
      gRoot = d3.select(
        rootNode && rootNode.querySelector ? rootNode.querySelector(":scope > g") : null
      );
      if (gRoot.empty()) gRoot = svg.append("g");
      linkG = gRoot.select(".graph-links");
      nodeG = gRoot.select(".graph-nodes");
      if (linkG.empty() && nodeG.empty()) {
        const layers = gRoot.selectAll("g");
        if (layers.size() >= 2) {
          linkG = d3.select(layers.nodes()[0]).attr("class", "graph-links");
          nodeG = d3.select(layers.nodes()[1]).attr("class", "graph-nodes");
        }
      }
      if (linkG.empty()) {
        linkG = gRoot
          .append("g")
          .attr("class", "graph-links")
          .attr("stroke", "#475569")
          .attr("stroke-opacity", 0.55);
      }
      if (nodeG.empty()) {
        nodeG = gRoot.append("g").attr("class", "graph-nodes");
      }
      if (!zoom) {
        zoom = d3
          .zoom()
          .scaleExtent([0.3, 5])
          .on("zoom", (event) => {
            gRoot.attr("transform", event.transform);
          });
        svg.call(zoom);
      }
    }
    svg
      .attr("viewBox", [0, 0, width, height])
      .attr("preserveAspectRatio", "xMidYMid meet");
  }

  window.renderGraph = function renderGraph(graph) {
    if (!host || typeof d3 === "undefined") return;

    graphDragState.active = false;
    graphDragState.hub = null;
    graphDragState.neighbors = [];

    const nodes = (graph.nodes || []).map((d) => ({ ...d }));
    const rawEdges = (graph.edges || []).map((d) => ({ ...d }));

    if (!nodes.length) {
      lastGraphPayload = null;
      tearDown();
      positionCache.clear();
      lastGraphSeed = "";
      const div = document.createElement("div");
      div.style.padding = "1rem";
      div.style.color = "var(--muted)";
      div.textContent = "No nodes to display.";
      host.appendChild(div);
      return;
    }

    const seed = String(graph.seed || "").toLowerCase();
    if (seed && seed !== lastGraphSeed) {
      positionCache.clear();
      lastGraphSeed = seed;
    }

    lastGraphPayload = graph;

    host.querySelector("div")?.remove();

    const dims = measureHostSize();
    width = dims.w;
    height = dims.h;

    ensureSvgStructure();

    const nodeById = new Map(nodes.map((d) => [d.id, d]));
    rawEdges.forEach((e) => {
      const s = nodeById.get(e.source);
      const t = nodeById.get(e.target);
      if (s && t) {
        e.source = s;
        e.target = t;
      }
    });
    const edges = rawEdges.filter(
      (e) => typeof e.source === "object" && typeof e.target === "object"
    );

    seedPositions(nodes, width, height);

    const drag = d3
      .drag()
      .on("start", (event, d) => {
        d.__dragMoved = false;
        graphDragState.active = true;
        graphDragState.hub = d;
        graphDragState.neighbors = collectNeighborNodes(d, edges);
        graphDragState.lastX = event.x;
        graphDragState.lastY = event.y;
        graphDragState.velX = 0;
        graphDragState.velY = 0;
        if (!event.active) simulation.alphaTarget(0.2).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.__dragMoved = true;
        const vx = event.x - graphDragState.lastX;
        const vy = event.y - graphDragState.lastY;
        graphDragState.lastX = event.x;
        graphDragState.lastY = event.y;
        graphDragState.velX = graphDragState.velX * 0.62 + vx * 0.38;
        graphDragState.velY = graphDragState.velY * 0.62 + vy * 0.38;
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        graphDragState.active = false;
        graphDragState.hub = null;
        graphDragState.neighbors = [];
        graphDragState.velX = 0;
        graphDragState.velY = 0;
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    const linkSel = linkG
      .selectAll("line")
      .data(edges, linkKey)
      .join(
        (enter) =>
          enter
            .append("line")
            .attr("stroke-width", 0.8)
            .attr("opacity", 0)
            .call((sel) =>
              sel.transition().duration(380).ease(d3.easeCubicOut).attr("opacity", 0.9)
            ),
        (update) => update,
        (exit) =>
          exit
            .transition()
            .duration(220)
            .attr("opacity", 0)
            .remove()
      )
      .attr("stroke-width", (d) => 1 + Math.min(5, Math.log10(2 + (d.tx_count || 0))));

    const nodeJoin = nodeG
      .selectAll("g.node")
      .data(nodes, (d) => d.id)
      .join(
        (enter) => {
          const g = enter.append("g").attr("class", "node").call(drag);
          g.append("circle")
            .attr("r", 0)
            .attr("fill", (d) => nodeFill(d))
            .attr("stroke", (d) => nodeStroke(d))
            .attr("stroke-width", (d) => nodeStrokeWidth(d))
            .attr("opacity", 0)
            .transition()
            .duration(520)
            .ease(d3.easeCubicOut)
            .attr("r", (d) => nodeRadius(d))
            .attr("opacity", 1);
          g.append("text")
            .attr("x", (d) => nodeRadius(d) + 6)
            .attr("y", 4)
            .attr("fill", "#e8edf4")
            .attr("font-size", 11)
            .attr("opacity", 0)
            .text((d) => d.label || d.id)
            .transition()
            .delay(120)
            .duration(320)
            .attr("opacity", 1);
          return g;
        },
        (update) => {
          update.select("circle").each(function (d) {
            d3.select(this)
              .transition()
              .duration(400)
              .ease(d3.easeCubicOut)
              .attr("r", nodeRadius(d))
              .attr("fill", nodeFill(d))
              .attr("stroke", nodeStroke(d))
              .attr("stroke-width", nodeStrokeWidth(d));
          });
          update
            .select("text")
            .transition()
            .duration(280)
            .attr("x", (d) => nodeRadius(d) + 6);
          return update.call(drag);
        },
        (exit) =>
          exit
            .transition()
            .duration(280)
            .ease(d3.easeCubicIn)
            .attr("opacity", 0)
            .remove()
      );

    if (simulation) {
      simulation.stop();
    }

    simulation = d3
      .forceSimulation(nodes)
      .alphaDecay(0.022)
      .velocityDecay(0.38)
      .alpha(0.22)
      .alphaTarget(0)
      .force(
        "link",
        d3
          .forceLink(edges)
          .id((d) => d.id)
          .distance((d) => {
            const rs =
              nodeRadius(typeof d.source === "object" ? d.source : nodeById.get(d.source));
            const rt =
              nodeRadius(typeof d.target === "object" ? d.target : nodeById.get(d.target));
            const base = 72 + (rs + rt) * 0.45;
            const hub = graphDragState.hub;
            const pull =
              graphDragState.active &&
              hub &&
              (d.source === hub || d.target === hub);
            return pull ? base * 0.5 : base;
          })
          .strength((d) => {
            const hub = graphDragState.hub;
            if (
              graphDragState.active &&
              hub &&
              (d.source === hub || d.target === hub)
            ) {
              return 0.82;
            }
            return 0.28;
          })
      )
      .force("charge", d3.forceManyBody().strength(-140))
      .force("center", d3.forceCenter(width / 2, height / 2).strength(0.04))
      .force(
        "collision",
        d3.forceCollide().radius((d) => nodeRadius(d) + 6)
      )
      .force("drag-follow", (alpha) => {
        if (!graphDragState.active || !graphDragState.hub) return;
        const hub = graphDragState.hub;
        const hx = hub.fx != null ? hub.fx : hub.x;
        const hy = hub.fy != null ? hub.fy : hub.y;
        const vxn = graphDragState.velX;
        const vyn = graphDragState.velY;
        const vlen = Math.hypot(vxn, vyn);
        const ux = vlen > 0.35 ? vxn / vlen : 0;
        const uy = vlen > 0.35 ? vyn / vlen : 0;
        const lag = vlen > 0.35 ? 20 : 0;
        const tx = hx - ux * lag;
        const ty = hy - uy * lag;
        const pull = 0.26 * alpha;
        const trail = 0.11 * alpha;
        for (let i = 0; i < graphDragState.neighbors.length; i++) {
          const n = graphDragState.neighbors[i];
          const dx = tx - n.x;
          const dy = ty - n.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
          const w = Math.min(dist, 95);
          n.vx += (dx / dist) * pull * w;
          n.vy += (dy / dist) * pull * w;
          if (vlen > 0.35) {
            n.vx -= ux * trail;
            n.vy -= uy * trail;
          }
        }
      });

    let tickCount = 0;
    simulation.on("tick", () => {
      linkSel
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      nodeJoin.attr("transform", (d) => `translate(${d.x},${d.y})`);
      tickCount += 1;
      if (tickCount % 18 === 0) savePositions(nodes);
    });

    simulation.on("end", () => savePositions(nodes));

    simulation.restart();

    bindNodePopupOnce();
    nodeJoin
      .style("cursor", "pointer")
      .on("click", (event, d) => {
        event.stopPropagation();
        if (d.__dragMoved) return;
        const id = String(d.id || "").toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(id)) return;
        openNodePopup(id, event.clientX, event.clientY);
      });
  };

  let resizeDebounce = null;
  if (typeof ResizeObserver !== "undefined" && host) {
    new ResizeObserver(() => {
      const g = lastGraphPayload;
      if (!g || !(g.nodes || []).length) return;
      clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => {
        window.renderGraph(g);
      }, 120);
    }).observe(host);
  }
})();
