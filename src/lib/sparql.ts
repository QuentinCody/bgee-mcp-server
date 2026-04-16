/**
 * Bgee SPARQL adapter — wraps the public Bgee SPARQL endpoint behind a
 * SparqlFetchFn that the shared SPARQL Code Mode tool can call.
 *
 * Endpoint: https://www.bgee.org/sparql/
 *
 * No auth, no API keys. We send `Accept: application/sparql-results+json`
 * and parse the JSON envelope. Falls back to text for non-JSON responses.
 */

import type { SparqlFetchFn } from "@bio-mcp/shared/codemode/sparql-introspection";

export const BGEE_SPARQL_ENDPOINT = "https://www.bgee.org/sparql/";

const ACCEPT_HEADER =
	"application/sparql-results+json, application/json;q=0.9, text/tab-separated-values;q=0.8, text/plain;q=0.5";
const USER_AGENT = "bgee-mcp-server/0.1 (+bio-mcp-client)";

interface BgeeSparqlOptions {
	endpoint?: string;
	userAgent?: string;
}

export function createBgeeSparqlFetch(options: BgeeSparqlOptions = {}): SparqlFetchFn {
	const endpoint = options.endpoint ?? BGEE_SPARQL_ENDPOINT;
	const ua = options.userAgent ?? USER_AGENT;

	return async (query, opts = {}) => {
		const method = opts.method ?? "POST";
		const timeoutMs = opts.timeoutMs ?? 60_000;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			let response: Response;
			if (method === "GET") {
				const url = new URL(endpoint);
				url.searchParams.set("query", query);
				url.searchParams.set("format", "json");
				response = await fetch(url, {
					method: "GET",
					headers: { Accept: ACCEPT_HEADER, "User-Agent": ua },
					signal: controller.signal,
				});
			} else {
				const body = new URLSearchParams({ query });
				response = await fetch(endpoint, {
					method: "POST",
					headers: {
						Accept: ACCEPT_HEADER,
						"Content-Type": "application/x-www-form-urlencoded",
						"User-Agent": ua,
					},
					body,
					signal: controller.signal,
				});
			}

			if (!response.ok) {
				const errorText = await response.text().catch(() => response.statusText);
				const err = new Error(`HTTP ${response.status} from Bgee SPARQL: ${errorText.slice(0, 240)}`);
				(err as Error & { status: number }).status = response.status;
				throw err;
			}

			const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
			if (contentType.includes("json")) return await response.json();
			const text = await response.text();
			return { text, content_type: contentType };
		} finally {
			clearTimeout(timer);
		}
	};
}
