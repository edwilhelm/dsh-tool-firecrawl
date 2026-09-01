/**
 * Model-facing `firecrawl_search` tool: search the web using the Firecrawl
 * keyless free tier. Calls `POST https://api.firecrawl.dev/v2/search` without
 * an API key (rate-limited). This package owns the model-facing schema,
 * argument validation, result formatting, and presentation — never the
 * provider selection, because the free tier is the only path.
 * @module @deepseek-ai/dsh-tool-firecrawl
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
/**
 * Cordis plugin name used by loader diagnostics.
 */
const name = "tool-firecrawl";
/**
 * Services required by this tool.
 */
const inject = [
	"tools",
	"systemPrompt"
];
/**
 * The Firecrawl search API default endpoint (v2, no API key needed).
 */
const DEFAULT_ENDPOINT = "https://api.firecrawl.dev/v2/search";
/**
 * Default cooperative tool-call timeout budget (ms).
 */
const DEFAULT_TIMEOUT_MS = 30000;
/**
 * Default upper bound on returned results per source type.
 */
const DEFAULT_MAX_RESULTS = 8;
/**
 * Attribution header sent on every request.
 */
const USER_AGENT = "deepseek-harness/0.0.1";
/**
 * Allowed source types for the `sources` parameter.
 */
const SOURCES = ["web", "news", "images"];
/**
 * Allowed category filters for the `categories` parameter.
 */
const CATEGORIES = ["research", "pdf", "developer"];
/**
 * Allowed scrape format values.
 */
const SCRAPE_FORMATS = ["markdown", "links", "html", "screenshot", "rawHtml"];
/**
 * Format a search result as one model-facing text block.
 *
 * @param results - the normalized search outcomes.
 * @param truncated - whether the result count was capped.
 * @returns the markdown text with source list.
 */
function formatSearchResults(results, truncated) {
	const parts = [];
	// Group results by their source type
	const byGroup = { web: [], news: [], images: [] };
	for (const r of results) {
		const group = r.group ?? "web";
		const list = byGroup[group];
		if (list) list.push(r);
	}
	for (const group of ["web", "news", "images"]) {
		const items = byGroup[group];
		if (items.length === 0) continue;
		const heading = group === "web" ? "Web" : group === "news" ? "News" : "Images";
		parts.push(`### ${heading}`);
		const lines = items.map((item) => {
			const meta = [];
			if (item.snippet !== void 0 && item.snippet.length > 0) meta.push(item.snippet);
			if (item.publishedAt !== void 0 && item.publishedAt.length > 0) meta.push(`_(${item.publishedAt})_`);
			if (item.category !== void 0 && item.category.length > 0) meta.push(`[${item.category}]`);
			const suffix = meta.length > 0 ? ` — ${meta.join(" ")}` : "";
			const label = item.title && item.title.length > 0 ? item.title : item.url;
			let line = `- [${label}](${item.url})${suffix}`;
			// Append full-page content when scrapeFormats returned markdown
			if (item.markdown !== void 0 && item.markdown.length > 0) {
				// Indent the content block so it's clearly scoped to this result
				const content = item.markdown.replace(/\n/g, "\n  ");
				line += `\n  \`\`\`markdown\n  ${content}\n  \`\`\``;
			}
			return line;
		});
		parts.push(lines.join("\n"));
	}
	if (results.length === 0) parts.push("No results found.");
	if (truncated) parts.push(`_(Showing the first ${results.length} results. Refine the query for more.)_`);
	parts.push("Cite the relevant URLs above as markdown links in your answer.");
	return parts.join("\n\n");
}
/**
 * Normalize the raw Firecrawl API response into our standard result shape.
 *
 * @param data - the `data` field from the Firecrawl API response.
 * @returns the normalized results array.
 */
function normalizeResults(data) {
	if (!data || typeof data !== "object") return [];
	const results = [];
	for (const group of ["web", "news", "images"]) {
		const items = data[group];
		if (!Array.isArray(items)) continue;
		for (const item of items) {
			if (!item || !item.url) continue;
			const normalized = {
				url: item.url,
				title: item.title ?? "",
				snippet: (item.description ?? item.snippet ?? "").slice(0, MAX_SNIPPET_CHARS),
				group,
				position: item.position ?? 0,
				...(item.category !== void 0 && item.category !== null ? { category: item.category } : {}),
				...(item.date !== void 0 && item.date !== null ? { publishedAt: item.date } : {}),
				// Full content from scrapeOptions — only present when the caller
				// requested scrapeFormats. The free tier returns these keyless.
				...(typeof item.markdown === "string" && item.markdown.length > 0 ? { markdown: item.markdown.slice(0, MAX_MARKDOWN_CHARS) } : {}),
				...(Array.isArray(item.links) && item.links.length > 0 ? { links: item.links.map((link) => typeof link === "string" ? link : link.url ?? String(link)).filter(Boolean) } : {})
			};
			results.push(normalized);
		}
	}
	return results;
}
/**
 * Cap a snippet at a fixed length so a Firecrawl "Highlight" (which can be a
 * long page excerpt) never floods model context. A hard product constant, not
 * a tunable: snippets are auxiliary; the model follows the URL for content.
 */
const MAX_SNIPPET_CHARS = 320;
/**
 * Cap on per-result markdown content so one large scraped page cannot flood
 * model context. Full pages routinely exceed 10k chars; 6000 is a usable
 * middle ground for a single result, and the model can follow the URL for more.
 */
const MAX_MARKDOWN_CHARS = 6000;
/**
 * Build the fetch request body from validated user arguments.
 * @param args - the validated tool arguments.
 * @returns the JSON body for the Firecrawl API call.
 */
function buildRequestBody(args) {
	const body = {
		query: args.query,
		limit: args.limit ?? DEFAULT_MAX_RESULTS,
		// `highlights: false` returns each website's plain description/snippet
		// instead of query-relevant page excerpts, keeping tool output compact.
		highlights: false
	};
	if (Array.isArray(args.sources) && args.sources.length > 0) body.sources = args.sources;
	if (Array.isArray(args.categories) && args.categories.length > 0) body.categories = args.categories;
	if (Array.isArray(args.includeDomains) && args.includeDomains.length > 0) body.includeDomains = args.includeDomains;
	if (Array.isArray(args.excludeDomains) && args.excludeDomains.length > 0) body.excludeDomains = args.excludeDomains;
	if (args.location !== void 0 && args.location.length > 0) body.location = args.location;
	if (args.tbs !== void 0 && args.tbs.length > 0) body.tbs = args.tbs;
	if (args.safe !== void 0) body.safe = args.safe;
	// `scrape: true` is the convenience form of scrapeFormats: it requests full
	// page content as markdown. An explicit scrapeFormats array always wins.
	let formats;
	if (Array.isArray(args.scrapeFormats) && args.scrapeFormats.length > 0) formats = args.scrapeFormats;
	else if (args.scrape === true) formats = ["markdown"];
	if (formats !== void 0) {
		body.scrapeOptions = { formats };
	}
	return body;
}
/**
 * Validate value constraints the schema DSL cannot express: a non-blank `query`.
 * @param args - the schema-validated `firecrawl_search` arguments.
 * @returns the accepted arguments, passed through.
 */
function parseSearchArgs(args) {
	if (args.query.trim().length === 0) throw new Error("query must be a non-empty string");
	return args;
}
/**
 * Execute one firecrawl search: POST to the API, parse the response, and
 * normalize results.
 *
 * @param args - the validated user arguments.
 * @param endpoint - the Firecrawl search API endpoint.
 * @param signal - optional abort signal.
 * @returns the normalized search outcome.
 */
async function executeSearch(args, endpoint, signal) {
	const requestBody = buildRequestBody(args);
	let response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT
			},
			body: JSON.stringify(requestBody),
			...signal !== void 0 ? { signal } : {}
		});
	} catch (error) {
		if (signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError")) {
			throw new Error("Firecrawl search aborted");
		}
		throw new Error(`Firecrawl search request failed: ${String(error)}`);
	}
	if (!response.ok) {
		let message = `Firecrawl API error (HTTP ${response.status})`;
		try {
			const parsed = await response.json();
			if (typeof parsed.error === "string" && parsed.error.length > 0) message = parsed.error;
			else if (parsed.error?.message) message = parsed.error.message;
		} catch {
			// ignore parse errors in the error body
		}
		throw new Error(message);
	}
	let parsed;
	try {
		parsed = await response.json();
	} catch (error) {
		throw new Error(`Firecrawl returned an unparseable response: ${String(error)}`);
	}
	if (!parsed.success || !parsed.data) {
		throw new Error("Firecrawl returned an unsuccessful response");
	}
	const results = normalizeResults(parsed.data);
	const max = args.limit ?? DEFAULT_MAX_RESULTS;
	const truncated = results.length > max * (Array.isArray(args.sources) && args.sources.length > 0 ? args.sources.length : 1);
	return {
		results: truncated ? results.slice(0, max) : results,
		truncated: truncated
	};
}
/**
 * Project one normalized result into a plain object that omits every absent
 * optional field.
 * @param result - one normalized search result.
 * @returns the projected source.
 */
function projectResult(result) {
	return {
		url: result.url,
		...result.title !== void 0 && result.title.length > 0 ? { title: result.title } : {},
		...result.snippet !== void 0 && result.snippet.length > 0 ? { snippet: result.snippet } : {},
		group: result.group,
		position: result.position,
		...result.publishedAt !== void 0 && result.publishedAt.length > 0 ? { publishedAt: result.publishedAt } : {},
		...result.category !== void 0 && result.category.length > 0 ? { category: result.category } : {},
		...result.markdown !== void 0 && result.markdown.length > 0 ? { markdown: result.markdown } : {},
		...result.links !== void 0 && result.links.length > 0 ? { links: result.links } : {}
	};
}
/**
 * Pending-call presentation: a search card titled by the query.
 * @param args - the raw tool arguments.
 * @returns the generic card view shown while the call runs.
 */
function presentCall(args) {
	return {
		card: "generic",
		title: args.query,
		kind: "search",
		rawInput: args.query
	};
}
/**
 * Compute the replayable presentation meta from the canonical output value.
 * @param value - the tool's output value.
 * @returns the structured sources and truncation flag.
 */
function metaFromValue(value) {
	return {
		sources: value.results.map(projectResult),
		truncated: value.truncated
	};
}
/** Narrow opaque metadata to a structured shape; returns undefined on malformed data. */
function metaFromResult(meta) {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return void 0;
	const { sources, truncated } = meta;
	if (!Array.isArray(sources)) return void 0;
	if (typeof truncated !== "boolean") return void 0;
	return { sources, truncated };
}
/**
 * Completed-call presentation: a web search card carrying the structured sources.
 * @param args - the raw tool arguments; `query` becomes the result-state title.
 * @param result - the final model-facing tool result; `meta` carries the sources.
 * @returns the search result view, or undefined on failure.
 */
function presentResult(args, result) {
	if (result.isError) return void 0;
	const meta = metaFromResult(result.meta);
	if (meta === void 0) return void 0;
	return {
		card: "web",
		kind: "search",
		title: args.query,
		sources: meta.sources,
		truncated: meta.truncated
	};
}
/**
 * Register the `firecrawl_search` tool and its system-prompt guidance.
 *
 * @param ctx - context whose `tools` and `systemPrompt` registries receive
 *   the registrations; both are effect-scoped and unregister on plugin dispose.
 * @param endpoint - the Firecrawl API endpoint.
 * @param timeoutMs - the cooperative tool-call budget (ms).
 */
function applyToolFirecrawl(ctx, endpoint, timeoutMs) {
	ctx.systemPrompt.section({
		name: "tool:firecrawl_search",
		order: 112,
		text: "Use the firecrawl_search tool to discover current information on the web using the Firecrawl keyless free tier (no API key needed). It returns an optional answer plus a list of source URLs. Use the returned source snippets when available, and cite the relevant URLs as markdown links."
	});
	ctx.tools.register(defineTool({
		name: "firecrawl_search",
		description: "Search the web using Firecrawl (keyless free tier — no API key required). Returns an optional summary and a list of source URLs with titles, descriptions, and dates.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "The search query."
			},
			limit: {
				type: "integer",
				description: "Maximum results per source type (web/news/images). Default: 8."
			},
			sources: {
				type: "array",
				items: { type: "string", enum: SOURCES },
				description: "Source types to search: web, news, images. Default: [\"web\"]."
			},
			categories: {
				type: "array",
				items: { type: "string", enum: CATEGORIES },
				description: "Restrict search to specific categories: research, pdf, developer."
			},
			includeDomains: {
				type: "array",
				items: { type: "string" },
				description: "Only return results from these domains (e.g. [\"firecrawl.dev\"])."
			},
			excludeDomains: {
				type: "array",
				items: { type: "string" },
				description: "Exclude results from these domains."
			},
			location: {
				type: "string",
				description: "Location for localized results (e.g. \"Germany\")."
			},
			tbs: {
				type: "string",
				description: "Time filter: qdr:h (hour), qdr:d (day), qdr:w (week), qdr:m (month), qdr:y (year), sbd:1 (sort by date)."
			},
			safe: {
				type: "boolean",
				description: "Enable SafeSearch to filter explicit content."
			},
			scrape: {
				type: "boolean",
				description: "Request full page content (markdown) for each result. Shorthand for scrapeFormats: ['markdown']. Default: false."
			},
			scrapeFormats: {
				type: "array",
				items: { type: "string", enum: SCRAPE_FORMATS },
				description: "Scrape each result and return content in these formats: markdown, links, html, screenshot, rawHtml."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					results: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								url: { type: "string", required: true },
								title: { type: "string" },
								snippet: { type: "string" },
								group: { type: "string", required: true },
								position: { type: "integer", required: true },
								publishedAt: { type: "string" },
								category: { type: "string" },
								markdown: { type: "string" },
								links: { type: "array", items: { type: "string" } }
							}
						}
					},
					truncated: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatSearchResults(value.results, value.truncated)
			}],
			presentationMeta: (_args, value) => metaFromValue(value)
		},
		timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const input = parseSearchArgs(args);
			const outcome = await executeSearch(input, endpoint, exec.signal);
			return {
				results: outcome.results.map(projectResult),
				truncated: outcome.truncated
			};
		},
		presentCall: (args) => presentCall(args),
		presentResult: (args, result) => presentResult(args, result)
	}));
}
const Config = z.object({
	enabled: z.boolean().default(true),
	endpoint: z.string().default(DEFAULT_ENDPOINT),
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS)
});
/**
 * Register the firecrawl search tool.
 * @param ctx - the Cordis context.
 * @param config - configuration.
 */
function apply(ctx, config) {
	if (!config.enabled) return;
	applyToolFirecrawl(ctx, config.endpoint, config.timeoutMs);
}
export { Config, DEFAULT_TIMEOUT_MS, apply, applyToolFirecrawl, inject, name };