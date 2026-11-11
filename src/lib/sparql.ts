import { hashCanonicalJson } from "@bio-mcp/shared";
import type { SparqlFetchFn } from "@bio-mcp/shared/codemode/sparql-introspection";
import { decodeResponseText, readResponseBytes } from "@bio-mcp/shared/http/response-reader";
import { BGEE_SPARQL_ENDPOINT, routeBgeeQuery } from "./query-routing";

export { BGEE_SPARQL_ENDPOINT };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
// The archive returned empty bindings for a negotiated list but real rows for
// this exact media type. Pin the documented result format instead of fallback.
const ACCEPT = "application/sparql-results+json";

function checkedJson(text: string): Record<string, unknown> {
  const data: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!record(data) || !record(data.head)) throw new Error("Invalid Bgee SPARQL envelope");
  if (typeof data.boolean === "boolean") return data;
  if (!Array.isArray(data.head.vars) || !data.head.vars.every(v => typeof v === "string") || !record(data.results) || !Array.isArray(data.results.bindings)) throw new Error("Bgee response lacks SELECT bindings or an ASK boolean");
  for (const binding of data.results.bindings) {
    if (!record(binding)) throw new Error("Invalid Bgee binding");
    for (const term of Object.values(binding)) {
      if (!record(term) || typeof term.type !== "string" || typeof term.value !== "string") throw new Error("Invalid Bgee RDF term");
    }
  }
  return data;
}

export function createBgeeSparqlFetch(options: { userAgent?: string } = {}): SparqlFetchFn {
  return async (query, opts = {}) => {
    const route = routeBgeeQuery(query);
    const method = opts.method ?? "GET";
    if (method !== "GET" && method !== "POST") throw new Error("Bgee supports GET or POST queries");
    const timeout = opts.timeoutMs ?? 45000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60000) throw new Error("Bgee timeout must be positive and at most 60000ms");
    const deadline = Date.now() + timeout;
    const controller = new AbortController();
    const { request, url } = prepareSparqlRequest(route, method, query);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unavailable = (message: string, status: number) => Object.assign(new Error(message), { status, data: { request, body_unavailable: true } });
    const timeoutFailure = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable("Bgee header deadline exceeded", 504)); }, timeout); });
    try {
      const response = await Promise.race([fetch(url, {
        method, headers: { Accept: ACCEPT, "User-Agent": options.userAgent ?? "bgee-mcp-server/0.1 (+bio-mcp-client)", ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
        body: method === "POST" ? new URLSearchParams({ query }) : undefined, signal: controller.signal, redirect: "manual",
      }).catch(() => { throw unavailable("Bgee network request failed", 502); }), timeoutFailure]);
      let bytes: Uint8Array;
      try { bytes = await readResponseBytes(response, { label: "Bgee", maxBytes: 4 * 1024 * 1024, timeoutMs: Math.min(10000, Math.max(1, deadline - Date.now())) }); }
      catch (error) { throw Object.assign(unavailable("Bgee response exceeds 4 MiB or could not be read within the body deadline", response.ok ? 502 : response.status), { cause: String(error) }); }
      const { data, receipt } = await decodeBgeeEvidence(bytes, request, response);
      return { ...data!, _bgee: { ...receipt, native_sha256: await hashCanonicalJson(data!), hash_scope: "bio-mcp-json-v1 canonical provider envelope before _bgee; response_sha256 hashes native bytes", complete: false } };
    } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  };
}

function prepareSparqlRequest(route: { endpoint: string; requested_release: null; graph: null; } | { endpoint: "https://www.bgee.org/sparql15_1/"; requested_release: "15.1"; graph: "https://bgee.org/rdf_v15_1"; }, method: "GET" | "POST", query: string) {
  const url = new URL(route.endpoint);
  if (method === "GET") { url.searchParams.set("query", query); url.searchParams.set("format", "json"); }
  const request = { ...route, query, method, source_url: url.href, observed_release: null, snapshot_verified: false };
  return { request, url };
}

async function decodeBgeeEvidence(bytes: Uint8Array<ArrayBufferLike>, request: { query: string; method: "GET" | "POST"; source_url: string; observed_release: null; snapshot_verified: boolean; endpoint: string; requested_release: null; graph: null; } | { query: string; method: "GET" | "POST"; source_url: string; observed_release: null; snapshot_verified: boolean; endpoint: "https://www.bgee.org/sparql15_1/"; requested_release: "15.1"; graph: "https://bgee.org/rdf_v15_1"; }, response: Response) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const receipt = {
    ...request, retrieved_at: new Date().toISOString(), http_status: response.status, content_type: response.headers.get("content-type"), bytes: bytes.length,
    response_sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""), retry_after: response.headers.get("retry-after")
  };
  let text: string;
  try { text = decodeResponseText(bytes, "Bgee"); }
  catch { throw Object.assign(new Error("Invalid Bgee UTF-8"), { status: response.ok ? 502 : response.status, data: { receipt, body_unavailable: true } }); }
  const invalid = (message: string, status = 502): never => { throw Object.assign(new Error(message), { status, data: { receipt, raw_body: text } }); };
  if (response.status !== 200 || response.headers.has("content-range")) invalid(`HTTP ${response.status} from Bgee SPARQL`, response.ok ? 502 : response.status);
  const contentType = (receipt.content_type ?? "").toLowerCase();
  let data: Record<string, unknown>;
  if (contentType.includes("json")) {
    try { data = checkedJson(text); } catch (error) { invalid(error instanceof Error ? error.message : "Invalid Bgee JSON"); }
  } else if (/^(text\/(plain|turtle|tab-separated-values)|application\/(rdf\+xml|n-triples|n-quads|trig))\b/.test(contentType)) {
    data = { text, content_type: contentType };
  } else invalid("Unsupported Bgee response media type");
  return { data: data!, receipt };
}
