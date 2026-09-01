# @deepseek-ai/dsh-tool-firecrawl

Model-facing `firecrawl_search` tool using the Firecrawl keyless free tier.

## Usage

Add a row to any Cordis composition:

```yaml
- id: tool-firecrawl
  name: '@deepseek-ai/dsh-tool-firecrawl'
```

The plugin registers a `firecrawl_search` tool that agents can call to search
the web via the Firecrawl `/v2/search` endpoint. **No API key is required** —
the tool uses the Firecrawl keyless free tier (rate-limited).

## Parameters

| Parameter        | Type     | Required | Description |
|-----------------|----------|----------|-------------|
| `query`         | string   | yes      | The search query |
| `limit`         | integer  | no       | Max results per source type (default 8) |
| `sources`       | string[] | no       | `["web"]`, `["news"]`, `["images"]`, or combinations |
| `categories`    | string[] | no       | `["research"]`, `["pdf"]`, `["developer"]` |
| `includeDomains`| string[] | no       | Only return results from these domains |
| `excludeDomains`| string[] | no       | Exclude results from these domains |
| `location`      | string   | no       | Location for localized results (e.g. `"Germany"`) |
| `tbs`           | string   | no       | Time filter values: `qdr:h`, `qdr:d`, `qdr:w`, `qdr:m`, `qdr:y`, `sbd:1` |
| `safe`          | boolean  | no       | Enable SafeSearch |
| `scrape`        | boolean  | no       | Request full page content (markdown) for each result; shorthand for `scrapeFormats: ['markdown']` |
| `scrapeFormats` | string[] | no       | Scrape each result: `markdown`, `links`, `html`, `screenshot`, `rawHtml` |

## Config

```yaml
- id: tool-firecrawl
  name: '@deepseek-ai/dsh-tool-firecrawl'
  config:
    enabled: true
    endpoint: 'https://api.firecrawl.dev/v2/search'
    timeoutMs: 30000
```

## Scraping content

By default the tool returns clean snippets (`highlights: false`, capped at 320 chars). Pass `scrape: true` (or an explicit `scrapeFormats` array) to request full page content from each result — the keyless free tier supports this.

```yaml
# Model-facing call with scrape: true
firecrawl_search(query, scrape: true)
# Equivalent: scrapeFormats: ["markdown", "links"]
```

Each result then carries a `markdown` field (up to 6,000 chars) and a `links` array. The rendered output embeds the markdown in an indented fenced block so the model reads the actual page content.

## License

MIT