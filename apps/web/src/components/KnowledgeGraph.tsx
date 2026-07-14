import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { ChevronDown, CircleDot, Crosshair, FileText, Filter, GitBranch, Hexagon, History, Maximize2, Minus, Network, Pencil, Plus, Search, Share2, X, ZoomIn } from "lucide-react";

import type { GraphResponse, MemoryReference, TopicPage } from "../lib/types";
import { IconButton, SegmentedControl } from "./Primitives";

type PositionedNode = GraphResponse["nodes"][number] & { x: number; y: number; radius: number };
type GraphNodeType = GraphResponse["nodes"][number]["type"];

const NODE_COLORS: Record<GraphNodeType, string> = {
  topic: "#2c6750",
  entity: "#2f7f8c",
  claim: "#697d9b",
  source: "#bd7640",
  event: "#8275a6",
  artifact: "#8a6c58"
};

export function layoutFocusedGraph(graph: GraphResponse, width = 720, height = 620): PositionedNode[] {
  if (!graph.nodes.length) return [];
  const focusId = graph.focusId ?? graph.nodes[0]!.id;
  const focus = graph.nodes.find((node) => node.id === focusId) ?? graph.nodes[0]!;
  const others = graph.nodes.filter((node) => node.id !== focus.id);
  const connected = new Set(graph.edges.filter((edge) => edge.source === focus.id || edge.target === focus.id).flatMap((edge) => [edge.source, edge.target]));
  const firstRing = others.filter((node) => connected.has(node.id));
  const secondRing = others.filter((node) => !connected.has(node.id));
  const center = { x: width / 2, y: height / 2 - 12 };
  const placeRing = (nodes: GraphResponse["nodes"], radius: number, offset: number) => nodes.map((node, index) => {
    const angle = offset + (index / Math.max(nodes.length, 1)) * Math.PI * 2;
    return { ...node, x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius, radius: 15 + Math.min(node.weight, 3) * 3.5 };
  });
  return [{ ...focus, ...center, radius: 25 + Math.min(focus.weight, 3) * 4 }, ...placeRing(firstRing, 175, -Math.PI / 2), ...placeRing(secondRing, 270, -Math.PI / 2 + 0.35)];
}

export function KnowledgeGraph({ graph, topics, initialHops = 1, initialIncludeHistory = false, onClose, onRequestGraph, onNavigate, onEvidence, onEditTopic }: {
  graph: GraphResponse;
  topics: TopicPage[];
  initialHops?: 1 | 2;
  initialIncludeHistory?: boolean;
  onClose: () => void;
  onRequestGraph: (focusId: string | null, hops: 1 | 2, includeHistory: boolean) => void;
  onNavigate: (memory: MemoryReference) => void;
  onEvidence: (id: string) => void;
  onEditTopic: (topic: TopicPage) => void;
}) {
  const [hops, setHops] = useState<"1" | "2">(String(initialHops) as "1" | "2");
  const [includeHistory, setIncludeHistory] = useState(initialIncludeHistory);
  const [selectedId, setSelectedId] = useState(graph.focusId ?? graph.nodes[0]?.id ?? null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<GraphNodeType[]>(["topic", "entity", "claim", "source", "event", "artifact"]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);

  const visibleGraph = useMemo<GraphResponse>(() => {
    const historical = (status: string | undefined) => Boolean(status && ["historical", "expired", "superseded", "merged", "inactive", "excluded"].includes(status));
    const eligibleNodes = graph.nodes.filter((node) => types.includes(node.type) && (node.id === graph.focusId || includeHistory || !historical(node.status)));
    const eligibleIds = new Set(eligibleNodes.map((node) => node.id));
    const eligibleEdges = graph.edges.filter((edge) => eligibleIds.has(edge.source) && eligibleIds.has(edge.target) && (includeHistory || edge.status !== "historical" || edge.source === graph.focusId || edge.target === graph.focusId));
    const focusId = graph.focusId ?? eligibleNodes[0]?.id ?? null;
    if (!focusId) return { ...graph, nodes: [], edges: [] };
    const reachable = new Set([focusId]);
    let frontier = new Set([focusId]);
    for (let depth = 0; depth < Number(hops); depth += 1) {
      const next = new Set<string>();
      for (const edge of eligibleEdges) {
        if (frontier.has(edge.source) && !reachable.has(edge.target)) next.add(edge.target);
        if (frontier.has(edge.target) && !reachable.has(edge.source)) next.add(edge.source);
      }
      for (const id of next) reachable.add(id);
      frontier = next;
    }
    const nodes = eligibleNodes.filter((node) => reachable.has(node.id));
    const ids = new Set(nodes.map((node) => node.id));
    return { ...graph, focusId, nodes, edges: eligibleEdges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
  }, [graph, hops, includeHistory, types]);
  const positioned = useMemo(() => layoutFocusedGraph(visibleGraph), [visibleGraph]);
  const positions = useMemo(() => new Map(positioned.map((node) => [node.id, node])), [positioned]);
  const selectedNode = graph.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedEdge = graph.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedTopic = selectedNode ? topics.find((topic) => topic.id === selectedNode.id) : undefined;
  const selectedNodeEvidence = selectedNode ? [...new Set(graph.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id).flatMap((edge) => edge.evidenceIds))] : [];
  const matches = query.trim() ? positioned.filter((node) => `${node.label} ${node.subtitle ?? ""}`.toLowerCase().includes(query.toLowerCase())) : [];
  useEffect(() => {
    setSelectedId(graph.focusId ?? graph.nodes[0]?.id ?? null);
    setSelectedEdgeId(null);
  }, [graph.focusId, graph.nodes]);
  useEffect(() => {
    setHops(String(initialHops) as "1" | "2");
    setIncludeHistory(initialIncludeHistory);
  }, [initialHops, initialIncludeHistory]);

  const applyGraphRequest = (nextHops = hops, nextHistory = includeHistory, focusId = graph.focusId) => onRequestGraph(focusId ?? null, Number(nextHops) as 1 | 2, nextHistory);
  const zoom = (delta: number) => setTransform((current) => ({ ...current, scale: Math.min(2.3, Math.max(0.55, current.scale + delta)) }));
  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const nextScale = Math.min(2.3, Math.max(0.55, transform.scale - event.deltaY * 0.001));
    setTransform((current) => ({ ...current, scale: nextScale }));
  };
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest(".graph-node, .graph-edge-hit")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: transform.x, originY: transform.y };
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    setTransform((current) => ({ ...current, x: drag.current!.originX + event.clientX - drag.current!.x, y: drag.current!.originY + event.clientY - drag.current!.y }));
  };
  const endDrag = () => { drag.current = null; };

  return <aside className="side-drawer graph-drawer" aria-label="Knowledge graph">
    <header className="drawer-header"><div><span className="drawer-eyebrow">Focused neighborhood</span><h2>Knowledge graph</h2></div><IconButton label="Close knowledge graph" onClick={onClose}><X size={18} /></IconButton></header>
    <div className="graph-toolbar">
      <div className="graph-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a node…" aria-label="Find a graph node" />{query && <IconButton label="Clear graph search" onClick={() => setQuery("")}><X size={13} /></IconButton>}</div>
      <div className="popover-anchor"><button type="button" className={`graph-filter-button ${filterOpen ? "active" : ""}`} onClick={() => setFilterOpen((open) => !open)}><Filter size={15} /> Types <ChevronDown size={13} /></button>{filterOpen && <div className="graph-filter-popover popover-panel"><p>Visible node types</p>{(Object.keys(NODE_COLORS) as GraphNodeType[]).map((type) => <label key={type}><input type="checkbox" checked={types.includes(type)} onChange={() => setTypes((current) => current.includes(type) ? current.filter((item) => item !== type) : [...current, type])} /><span className={`legend-dot node-${type}`} />{type}</label>)}</div>}</div>
      <SegmentedControl label="Graph depth" value={hops} options={[{ value: "1", label: "1 hop" }, { value: "2", label: "2 hops" }]} onChange={(value) => { setHops(value); applyGraphRequest(value); }} />
      <button type="button" className={`history-toggle ${includeHistory ? "active" : ""}`} aria-pressed={includeHistory} onClick={() => { const next = !includeHistory; setIncludeHistory(next); applyGraphRequest(hops, next); }}><History size={15} /> History</button>
    </div>
    {query && <div className="graph-search-results">{matches.length ? matches.slice(0, 6).map((node) => <button type="button" key={node.id} onClick={() => { setSelectedId(node.id); setQuery(""); }}><span className={`legend-dot node-${node.type}`} />{node.label}<small>{node.type}</small></button>) : <span>No matching nodes</span>}</div>}
    <div className="graph-canvas-wrap">
      <p className="visually-hidden" id="graph-description">Focused knowledge graph with {positioned.length} memory nodes and {visibleGraph.edges.length} evidence-backed relationships. Use the accessible graph list after the canvas to inspect every node, relationship, and evidence record.</p>
      <svg className="graph-canvas" viewBox="0 0 720 620" aria-hidden="true" focusable="false" onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <defs><filter id="nodeShadow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="4" stdDeviation="5" floodColor="#1c2e27" floodOpacity=".16" /></filter><marker id="edgeArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
          {visibleGraph.edges.map((edge) => {
            const source = positions.get(edge.source); const target = positions.get(edge.target); if (!source || !target) return null;
            const selected = edge.id === selectedEdgeId;
            const mx = (source.x + target.x) / 2; const my = (source.y + target.y) / 2;
            return <g key={edge.id} className={`graph-edge edge-${edge.status} ${selected ? "selected" : ""}`}>
              <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} markerEnd="url(#edgeArrow)" />
              <line className="graph-edge-hit" x1={source.x} y1={source.y} x2={target.x} y2={target.y} onClick={() => { setSelectedEdgeId(edge.id); setSelectedId(null); }} />
              {edge.label && (selected || transform.scale > 1.15) && <text x={mx} y={my - 7} textAnchor="middle">{edge.label}</text>}
            </g>;
          })}
          {positioned.map((node) => <g key={node.id} className={`graph-node node-${node.type} ${node.id === selectedId ? "selected" : ""} ${node.id === visibleGraph.focusId ? "focus" : ""}`} transform={`translate(${node.x} ${node.y})`} onClick={(event) => { event.stopPropagation(); setSelectedId(node.id); setSelectedEdgeId(null); }} onDoubleClick={() => { onRequestGraph(node.id, Number(hops) as 1 | 2, includeHistory); setSelectedId(node.id); }}>
            {node.id === visibleGraph.focusId && <circle className="focus-ring" r={node.radius + 8} />}
            <circle className="node-circle" r={node.radius} fill={NODE_COLORS[node.type]} filter="url(#nodeShadow)" />
            {node.status === "historical" && <circle className="historical-ring" r={node.radius - 4} />}
            <text className="node-label" y={node.radius + 18} textAnchor="middle">{truncate(node.label, 24)}</text>
            {node.subtitle && <text className="node-subtitle" y={node.radius + 32} textAnchor="middle">{truncate(node.subtitle, 28)}</text>}
          </g>)}
        </g>
      </svg>
      <div className="graph-controls"><IconButton label="Zoom in" onClick={() => zoom(0.18)}><Plus size={16} /></IconButton><IconButton label="Zoom out" onClick={() => zoom(-0.18)}><Minus size={16} /></IconButton><IconButton label="Reset graph view" onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}><Crosshair size={16} /></IconButton></div>
      <div className="graph-legend"><span><i className="legend-dot node-topic" /> Topic</span><span><i className="legend-dot node-entity" /> Entity</span><span><i className="legend-dot node-claim" /> Claim</span><span><i className="legend-dot node-source" /> Source</span><span><i className="legend-line historical" /> Historical</span><span><i className="legend-line conflicted" /> Conflict</span></div>
    </div>
    <div className="graph-detail" aria-live="polite">
      {selectedNode ? <>
        <div className="graph-detail-heading"><span className={`graph-detail-icon node-${selectedNode.type}`}>{selectedNode.type === "topic" ? <GitBranch size={16} /> : selectedNode.type === "entity" ? <Hexagon size={16} /> : selectedNode.type === "source" ? <FileText size={16} /> : <CircleDot size={16} />}</span><div><strong>{selectedNode.label}</strong><small>{selectedNode.subtitle ?? selectedNode.type}</small></div>{selectedNode.status && <em className={`claim-status status-${selectedNode.status}`}>{selectedNode.status}</em>}</div>
        {selectedTopic ? <><p>{selectedTopic.summary}</p><div className="graph-detail-actions"><button type="button" className="secondary-button" onClick={() => onEditTopic(selectedTopic)}><Pencil size={14} /> Edit page</button><button type="button" className="primary-button" onClick={() => onNavigate({ id: selectedTopic.id, type: "topic", title: selectedTopic.title, excerpt: selectedTopic.summary, topicId: selectedTopic.id })}>Open page</button></div></> : <><p>This {selectedNode.type} is linked to {graph.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id).length} evidence-backed relationships.</p><div className="graph-detail-actions"><button type="button" className="secondary-button" onClick={() => onRequestGraph(selectedNode.id, Number(hops) as 1 | 2, includeHistory)}><Maximize2 size={14} /> Focus neighborhood</button><button type="button" className="primary-button" onClick={() => onEvidence(selectedNode.id)}><FileText size={14} /> Inspect exact record</button></div></>}
        {selectedNodeEvidence.length > 0 && <div className="graph-evidence-list"><strong>Relationship evidence</strong>{selectedNodeEvidence.slice(0, 12).map((id, index) => <button type="button" key={id} onClick={() => onEvidence(id)}><FileText size={13} /> Evidence {index + 1}<small>{id.slice(0, 8)}</small></button>)}</div>}
      </> : selectedEdge ? <><div className="graph-detail-heading"><span className="graph-detail-icon edge-icon"><Share2 size={16} /></span><div><strong>{selectedEdge.label ?? selectedEdge.type}</strong><small>{selectedEdge.status} relationship</small></div></div><p>This relationship is backed by {selectedEdge.evidenceIds.length} exact evidence source{selectedEdge.evidenceIds.length === 1 ? "" : "s"}.</p>{selectedEdge.evidenceIds.length ? <div className="graph-evidence-list">{selectedEdge.evidenceIds.map((id, index) => <button type="button" key={id} onClick={() => onEvidence(id)}><FileText size={13} /> Open evidence {index + 1}<small>{id.slice(0, 8)}</small></button>)}</div> : <p className="form-help">This retained relationship has no direct evidence ID.</p>}</> : <div className="graph-detail-placeholder"><Network size={18} /><span>Select a node or relationship to inspect its provenance.</span></div>}
    </div>
    <div className="graph-accessible-list" aria-describedby="graph-description"><details><summary><ZoomIn size={14} /> Accessible graph list <span>{positioned.length} nodes · {visibleGraph.edges.length} relationships</span></summary><section aria-label="Graph nodes"><h3>Nodes</h3><ul>{positioned.map((node) => <li key={node.id}><button type="button" aria-label={`${node.label}, ${node.type}, ${node.status ?? "current"}`} aria-pressed={selectedId === node.id} onClick={() => { setSelectedId(node.id); setSelectedEdgeId(null); }}><span className={`legend-dot node-${node.type}`} />{node.label}<small>{node.type} · {node.status ?? "current"}</small></button></li>)}</ul></section><section aria-label="Graph relationships"><h3>Relationships and evidence</h3><ul>{visibleGraph.edges.map((edge) => { const source = positions.get(edge.source); const target = positions.get(edge.target); if (!source || !target) return null; return <li key={edge.id} className="graph-accessible-edge"><button type="button" aria-label={`${source.label} ${edge.label ?? edge.type} ${target.label}, ${edge.status}, ${edge.evidenceIds.length} evidence records`} aria-pressed={selectedEdgeId === edge.id} onClick={() => { setSelectedEdgeId(edge.id); setSelectedId(null); }}><span className={`legend-line ${edge.status}`} />{source.label} → {target.label}<small>{edge.label ?? edge.type} · {edge.status} · {edge.evidenceIds.length} evidence</small></button>{edge.evidenceIds.length > 0 && <div>{edge.evidenceIds.map((evidenceId, index) => <button type="button" key={evidenceId} onClick={() => onEvidence(evidenceId)}><FileText size={12} /> Open evidence {index + 1}<small>{evidenceId.slice(0, 8)}</small></button>)}</div>}</li>; })}</ul></section></details></div>
  </aside>;
}

function truncate(value: string, max: number) { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
