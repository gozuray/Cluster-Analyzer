/**
 * D3 force-directed graph for wallet cluster edges.
 */
(function () {
  const host = document.getElementById("graph-host");
  let simulation = null;

  window.renderGraph = function renderGraph(graph) {
    if (!host || typeof d3 === "undefined") return;

    const nodes = (graph.nodes || []).map((d) => ({ ...d }));
    const edges = (graph.edges || []).map((d) => ({ ...d }));

    host.innerHTML = "";

    if (!nodes.length) {
      const div = document.createElement("div");
      div.style.padding = "1rem";
      div.style.color = "var(--muted)";
      div.textContent = "No nodes to display.";
      host.appendChild(div);
      return;
    }

    const width = host.clientWidth || 800;
    const height = Math.max(420, window.innerHeight - 200);

    const svg = d3
      .select(host)
      .append("svg")
      .attr("viewBox", [0, 0, width, height])
      .attr("style", "max-width:100%;height:auto;");

    const gRoot = svg.append("g");

    const zoom = d3
      .zoom()
      .scaleExtent([0.35, 4])
      .on("zoom", (event) => {
        gRoot.attr("transform", event.transform);
      });
    svg.call(zoom);

    const link = gRoot
      .append("g")
      .attr("stroke", "#334155")
      .attr("stroke-opacity", 0.85)
      .selectAll("line")
      .data(edges)
      .join("line")
      .attr("stroke-width", (d) => 1 + Math.min(6, Math.log10(2 + (d.tx_count || 0))));

    const drag = d3
      .drag()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.25).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    const node = gRoot
      .append("g")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .call(drag);

    node
      .append("circle")
      .attr("r", (d) => (d.role === "seed" ? 14 : 10))
      .attr("fill", (d) =>
        d.role === "seed" ? "#3b82f6" : d.role === "cluster" ? "#64748b" : "#475569"
      )
      .attr("stroke", "#0f172a")
      .attr("stroke-width", 2);

    node
      .append("text")
      .attr("x", 16)
      .attr("y", 4)
      .attr("fill", "#e8edf4")
      .attr("font-size", 11)
      .text((d) => d.label || d.id);

    simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(edges)
          .id((d) => d.id)
          .distance(90)
          .strength(0.35)
      )
      .force("charge", d3.forceManyBody().strength(-220))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force(
        "collision",
        d3.forceCollide().radius((d) => (d.role === "seed" ? 22 : 18))
      );

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });
  };

  window.addEventListener("resize", () => {
    /* optional: re-render on resize */
  });
})();
