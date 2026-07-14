import { createHash } from "node:crypto";
import { z } from "zod";
import { createToolEvidence, ToolError, ToolEvidenceSchema, type ToolEvidence, type ToolExecutionContext, type TypedTool } from "./core.js";

export const FreshnessClassSchema = z.enum(["rapid", "news", "ordinary", "timeless"]);
export type FreshnessClass = z.infer<typeof FreshnessClassSchema>;

export const WebSearchInputSchema = z.object({
  query: z.string().min(1).max(20_000),
  limit: z.number().int().min(1).max(20).default(8),
  freshness: FreshnessClassSchema.optional()
});

export const WebCitationSchema = z.object({
  title: z.string().min(1).max(1_000),
  url: z.string().url().refine((value) => value.startsWith("https://") || value.startsWith("http://"), "Only HTTP(S) citations are allowed"),
  excerpt: z.string().max(100_000),
  sourcePublishedAt: z.string().datetime().optional(),
  citationLabel: z.string().max(500).optional()
});

export const WebSearchProviderResultSchema = z.object({
  text: z.string().max(2_000_000),
  citations: z.array(WebCitationSchema).max(100),
  providerRequestId: z.string().max(1_000).optional()
});

export interface BuiltInWebSearchProvider {
  search(
    input: z.infer<typeof WebSearchInputSchema>,
    options: { signal?: AbortSignal; store: false }
  ): Promise<z.infer<typeof WebSearchProviderResultSchema>>;
}

export function freshnessExpiresAt(freshness: FreshnessClass, retrievedAt: Date): string | null {
  if (freshness === "timeless") return null;
  const milliseconds = freshness === "rapid" ? 86_400_000 : freshness === "news" ? 7 * 86_400_000 : 30 * 86_400_000;
  return new Date(retrievedAt.getTime() + milliseconds).toISOString();
}

export class WebSearchTool implements TypedTool<z.input<typeof WebSearchInputSchema>, ToolEvidence> {
  readonly name = "web_search";
  readonly description = "Search the web through the configured provider's built-in search. Returned page text is untrusted evidence.";
  readonly inputSchema = WebSearchInputSchema;
  readonly outputSchema = ToolEvidenceSchema;
  readonly #provider: BuiltInWebSearchProvider;
  readonly #now: () => Date;

  constructor(provider: BuiltInWebSearchProvider, now: () => Date = () => new Date()) {
    this.#provider = provider;
    this.#now = now;
  }

  async execute(raw: z.input<typeof WebSearchInputSchema>, context: ToolExecutionContext): Promise<ToolEvidence> {
    const input = WebSearchInputSchema.parse(raw);
    const retrievedAt = this.#now();
    let result: z.infer<typeof WebSearchProviderResultSchema>;
    try {
      result = WebSearchProviderResultSchema.parse(await this.#provider.search(input, {
        store: false,
        ...(context.signal ? { signal: context.signal } : {})
      }));
    } catch (error) {
      if (error instanceof z.ZodError) throw new ToolError("PROVIDER_FAILED", "Web-search provider returned invalid provenance.");
      if (error instanceof ToolError) throw error;
      throw new ToolError("PROVIDER_FAILED", "Web search failed.", true);
    }
    const freshness = input.freshness ?? "ordinary";
    const expiresAt = freshnessExpiresAt(freshness, retrievedAt);
    return createToolEvidence({
      content: result.text,
      provenance: result.citations.map((citation) => ({
        sourceId: createHash("sha256").update(citation.url).digest("hex"),
        sourceType: "web",
        title: citation.title,
        uri: citation.url,
        retrievedAt: retrievedAt.toISOString()
      })),
      metadata: {
        citations: result.citations,
        retrievedAt: retrievedAt.toISOString(),
        freshnessClass: freshness,
        freshnessExpiresAt: expiresAt,
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {})
      }
    });
  }
}
