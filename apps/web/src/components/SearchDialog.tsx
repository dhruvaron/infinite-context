import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, CheckCircle2, File, FileText, Filter, GitBranch, Hash, Hexagon, LoaderCircle, MessageSquare, Search, SlidersHorizontal, Wrench } from "lucide-react";

import { continuumApi } from "../lib/api-client";
import type { SearchFilters, SearchResult } from "../lib/types";
import { Modal, formatRelativeTime } from "./Primitives";

const DEFAULT_FILTERS: SearchFilters = { types: [], role: "all", status: "all", date: "all", source: "", tag: "" };
const TYPES: Array<{ value: SearchResult["type"]; label: string }> = [
  { value: "event", label: "Messages" },
  { value: "topic", label: "Wiki pages" },
  { value: "claim", label: "Claims" },
  { value: "entity", label: "Entities" },
  { value: "source", label: "Sources" },
  { value: "attachment", label: "Files" },
  { value: "tool_result", label: "Tool evidence" }
];

const resultIcons = {
  event: MessageSquare,
  topic: GitBranch,
  claim: Hash,
  entity: Hexagon,
  source: FileText,
  attachment: File,
  tool_result: Wrench
};

export function searchResultIdentity(result: SearchResult): string {
  return `${result.type}:${result.id}:${result.topicRevisionId ?? result.evidenceId ?? ""}`;
}

export function SearchDialog({ open, demo = false, disabled = false, onClose, onSelect }: { open: boolean; demo?: boolean; disabled?: boolean; onClose: () => void; onSelect: (result: SearchResult) => void }) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tookMs, setTookMs] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open && !disabled) window.setTimeout(() => inputRef.current?.focus(), 40); }, [disabled, open]);
  useEffect(() => {
    if (!open || disabled) {
      setResults([]);
      setNextCursor(null);
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    if (!query.trim()) { setResults([]); setNextCursor(null); setTookMs(0); setLoading(false); setError(null); return; }
    let cancelled = false;
    setError(null);
    setLoading(true);
    const timeout = window.setTimeout(() => {
      void continuumApi.search(query, filters, undefined, demo).then((response) => {
        if (cancelled) return;
        setResults(response.results);
        setNextCursor(response.nextCursor);
        setTookMs(response.tookMs);
        setActiveIndex(0);
      }).catch((reason: unknown) => {
        if (cancelled) return;
        setResults([]);
        setNextCursor(null);
        setError(reason instanceof Error ? reason.message : "Search is temporarily unavailable.");
      }).finally(() => { if (!cancelled) setLoading(false); });
    }, 160);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [demo, disabled, filters, open, query]);

  const activeFilters = filters.types.length + Number(filters.role !== "all") + Number(filters.status !== "all") + Number(filters.date !== "all") + Number(Boolean(filters.source.trim())) + Number(Boolean(filters.tag.trim()));
  const resultSummary = useMemo(() => loading ? "Searching local memory…" : `${results.length} result${results.length === 1 ? "" : "s"}${tookMs ? ` in ${Math.round(tookMs)} ms` : ""}`, [loading, results.length, tookMs]);

  const loadMore = async () => {
    if (disabled || !nextCursor || loading || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await continuumApi.search(query, filters, nextCursor, demo);
      setResults((current) => {
        const seen = new Set(current.map(searchResultIdentity));
        return [...current, ...response.results.filter((item) => !seen.has(searchResultIdentity(item)))];
      });
      setNextCursor(response.nextCursor);
      setTookMs((current) => current + response.tookMs);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "More search results could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  };

  return <Modal open={open} title="Search your entire history" description="Messages, wiki pages, claims, entities, sources, files, and tool evidence are searched locally." width="wide" onClose={onClose}>
    <div className="search-dialog" onKeyDown={(event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, Math.max(0, results.length - 1))); }
      if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
      if (event.key === "Enter" && results[activeIndex]) { event.preventDefault(); onSelect(results[activeIndex]); }
    }}>
      <div className="search-field"><Search size={20} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a decision, exact phrase, person, or file…" aria-label="Search all memory" />{loading && <LoaderCircle size={17} className="spin" />}<button type="button" className={filtersOpen ? "active" : ""} onClick={() => setFiltersOpen((value) => !value)}><SlidersHorizontal size={16} /> Filters{activeFilters ? <span>{activeFilters}</span> : null}</button></div>
      <div className="type-filter-row" aria-label="Filter by type">
        {TYPES.map((type) => <button type="button" className={filters.types.includes(type.value) ? "active" : ""} key={type.value} onClick={() => setFilters((value) => ({ ...value, types: value.types.includes(type.value) ? value.types.filter((item) => item !== type.value) : [...value.types, type.value] }))}>{type.label}</button>)}
      </div>
      {filtersOpen && <div className="advanced-filters">
        <label><span><MessageSquare size={14} /> Role</span><select value={filters.role} onChange={(event) => setFilters((value) => ({ ...value, role: event.target.value as SearchFilters["role"] }))}><option value="all">Any role</option><option value="user">You</option><option value="assistant">Assistant</option><option value="tool">Tool</option></select></label>
        <label><span><CheckCircle2 size={14} /> State</span><select value={filters.status} onChange={(event) => setFilters((value) => ({ ...value, status: event.target.value as SearchFilters["status"] }))}><option value="all">Any state</option><option value="current">Current</option><option value="superseded">Superseded</option></select></label>
        <label><span><CalendarDays size={14} /> Date</span><select value={filters.date} onChange={(event) => setFilters((value) => ({ ...value, date: event.target.value as SearchFilters["date"] }))}><option value="all">Any time</option><option value="today">Today</option><option value="week">Past week</option><option value="month">Past month</option><option value="year">Past year</option></select></label>
        <label><span><FileText size={14} /> Source</span><input value={filters.source} onChange={(event) => setFilters((value) => ({ ...value, source: event.target.value }))} placeholder="File or page" /></label>
        <label><span><Hash size={14} /> Tag</span><input value={filters.tag} onChange={(event) => setFilters((value) => ({ ...value, tag: event.target.value }))} placeholder="architecture" /></label>
        <button type="button" className="text-button" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</button>
      </div>}
      <div className="search-meta"><span>{query.trim() ? resultSummary : "Type to search exact retained evidence"}</span><span><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> open</span></div>
      <div className="search-results" role="listbox" aria-label="Search results">
        {!query.trim() ? <SearchSuggestions onSelect={setQuery} /> : error ? <div className="search-empty"><AlertTriangle size={24} /><strong>Search could not finish</strong><p>{error}</p></div> : !loading && !results.length ? <div className="search-empty"><Filter size={24} /><strong>No local evidence found</strong><p>Try fewer words or clear a filter. Continuum will not invent a memory when nothing matches.</p></div> : results.map((result, index) => {
          const Icon = resultIcons[result.type];
          return <button type="button" role="option" aria-selected={index === activeIndex} className={`search-result ${index === activeIndex ? "active" : ""}`} key={searchResultIdentity(result)} onMouseEnter={() => setActiveIndex(index)} onClick={() => onSelect(result)}>
            <span className={`result-icon result-${result.type}`}><Icon size={17} /></span>
            <span className="result-main"><span className="result-heading"><strong>{result.title}</strong><em>{result.type}</em></span><span className="result-snippet"><HighlightedSnippet value={result.snippet} /></span><span className="result-meta">{result.tags.map((tag) => <i key={tag}>{tag}</i>)}{result.timestamp && <small>{formatRelativeTime(result.timestamp)}</small>}</span></span>
            <span className="result-score">{Math.round(result.score * 100)}%</span>
          </button>;
        })}
        {nextCursor && !loading && <button type="button" className="secondary-button search-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <><LoaderCircle size={15} className="spin" /> Loading older matches…</> : "Load older matches"}</button>}
      </div>
    </div>
  </Modal>;
}

function HighlightedSnippet({ value }: { value: string }) {
  let highlighted = false;
  return <>{value.split(/(<mark>|<\/mark>)/i).map((part, index) => {
    if (part.toLowerCase() === "<mark>") { highlighted = true; return null; }
    if (part.toLowerCase() === "</mark>") { highlighted = false; return null; }
    return highlighted ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>;
  })}</>;
}

function SearchSuggestions({ onSelect }: { onSelect: (query: string) => void }) {
  return <div className="search-suggestions"><p>Try a historical question</p>{["What did we decide about raw history?", "Show superseded architecture decisions", "Find the original infinite context idea"].map((suggestion) => <button type="button" key={suggestion} onClick={() => onSelect(suggestion)}><Search size={14} />{suggestion}</button>)}</div>;
}
