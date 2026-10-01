import type { RpcTarget } from "cloudflare:workers";

export interface SearchResult {
  /** Page title. */
  title: string;
  /** Page URL. */
  url: string;
  /** Text snippet / summary of the page content. */
  content: string;
  /** Relevance score (0–1). Higher is more relevant. */
  score: number;
}

export interface SearchResponse {
  /** The original query. */
  query: string;
  /**
   * Tavily's AI-synthesized answer to the query, if available.
   * Useful for direct factual questions — check this before reading individual results.
   */
  answer: string | null;
  /** Up to `maxResults` most relevant search results. */
  results: SearchResult[];
}

export interface SearchOptions {
  /**
   * Maximum number of results to return (1–10, default 5).
   * Use 3 for quick lookups, 10 for comprehensive research.
   */
  maxResults?: number;
  /**
   * Search depth. "basic" is faster; "advanced" crawls pages for richer snippets.
   * Defaults to "basic".
   */
  searchDepth?: "basic" | "advanced";
  /**
   * Restrict results to specific domains, e.g. ["github.com", "docs.cloudflare.com"].
   * Leave empty for unrestricted search.
   */
  includeDomains?: string[];
}

export interface WebSearchSession extends RpcTarget {
  /**
   * Search the internet and return relevant results.
   * @param query Natural-language search query.
   * @param options Optional search settings.
   */
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}
