import { decodeResponseText, readResponseBytes } from "@bio-mcp/shared/http/response-reader";

const ORIGIN = "https://www.bgee.org";
const hash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
const pattern = /^([A-Za-z][A-Za-z0-9_-]*)_expr_(simple|advanced)(_all_conditions)?\.tsv\.gz$/;
function entity(value: string) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, encoded => {
    const names: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    if (names[encoded.toLowerCase()]) return names[encoded.toLowerCase()];
    const code = encoded[2].toLowerCase() === "x" ? Number.parseInt(encoded.slice(3, -1), 16) : Number(encoded.slice(2, -1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}
export function expressionLinks(html: string, sourceUrl: string) {
  const sanitized = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const links = new Map<string, { url: string; filename: string; condition_scope: "anatomy" | "all_conditions"; detail: "simple" | "advanced" }>();
  for (const anchor of sanitized.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gis)) {
    const href = entity(anchor[2]);
    if (/[%\\\s]/.test(href) || /^https:\/\/[^/]*:\d+(?:\/|$)/i.test(href)) continue;
    let url: URL;
    try { url = new URL(href, sourceUrl); } catch { continue; }
    if (url.protocol !== "https:" || !["www.bgee.org", "bgee.org"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !url.pathname.startsWith("/ftp/")) continue;
    const filename = url.pathname.split("/").pop()!;
    const match = pattern.exec(filename);
    if (match) links.set(url.href, { url: url.href, filename, condition_scope: match[3] ? "all_conditions" : "anatomy", detail: match[2] as "simple" | "advanced" });
  }
  if (!links.size || links.size > 16) throw new Error("Species page has no unambiguous bounded expression-call download links");
  const speciesNames = new Set([...links.values()].map(link => pattern.exec(link.filename)![1]));
  if (speciesNames.size !== 1) throw new Error("Species page mixes download filename species; inspect the provider page");
  return [...links.values()].sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}
async function request<T>(url: string, method: "GET" | "HEAD", read: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Bgee bulk metadata deadline exceeded")); }, 15000); });
  try {
    return await Promise.race([(async () => {
      const response = await fetch(url, { method, headers: { Accept: method === "GET" ? "text/html" : "*/*", "Accept-Encoding": "identity", "User-Agent": "bio-mcp-bgee-bulk/1.0" }, redirect: "manual", signal: controller.signal });
      if (response.status !== 200 || response.headers.has("content-range")) throw new Error("Bgee bulk metadata requires complete HTTP 200; received " + response.status);
      return read(response);
    })(), deadline]);
  } finally { clearTimeout(timer); controller.abort(); }
}
export async function discoverBulkFiles(speciesId: number, expectedHash?: string, expectedArtifactsHash?: string) {
  if (!Number.isSafeInteger(speciesId) || speciesId <= 0) throw new Error("Use a positive NCBI species identifier");
  const url = ORIGIN + "/species/" + speciesId;
  return request(url, "GET", async response => {
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) throw new Error("Bgee species page did not return HTML");
    const bytes = await readResponseBytes(response, { label: "Bgee species page", maxBytes: 2 * 1024 * 1024, timeoutMs: 10000 });
    const html = decodeResponseText(bytes, "Bgee species page");
    const htmlHash = await hash(new TextEncoder().encode(html));
    if (expectedHash && expectedHash.toLowerCase() !== htmlHash) throw new Error("Bgee species page changed since discovery");
    const artifacts = expressionLinks(html, url);
    const artifactsHash = await hash(new TextEncoder().encode(JSON.stringify({ source_url: url, requested_species_id: speciesId, artifacts })));
    if (expectedArtifactsHash && expectedArtifactsHash.toLowerCase() !== artifactsHash) throw new Error("Bgee expression download links changed since discovery");
    return { format_version: "bgee-bulk-discovery-1" as const,
      source: { url, requested_species_id: speciesId, retrieved_at: new Date().toISOString(), html, html_sha256: htmlHash, response_sha256: await hash(bytes), artifacts_sha256: artifactsHash, observed_release: null, genome_annotation: null },
      artifacts,
      scope: "Links observed on the requested species page; filename scope is a discovery label. Inspect native headers before import. Page/URL does not pin a Bgee release or genome annotation.",
    };
  });
}
export async function bulkManifest(speciesId: number, url: string, expectedHash?: string, expectedArtifactsHash?: string) {
  if ((!expectedHash && !expectedArtifactsHash) || [expectedHash, expectedArtifactsHash].some(value => value !== undefined && !/^[a-f0-9]{64}$/i.test(value))) throw new Error("Supply a discovery artifacts_sha256 or strict html_sha256 pin");
  const discovery = await discoverBulkFiles(speciesId, expectedHash, expectedArtifactsHash);
  const artifact = discovery.artifacts.find(item => item.url === url);
  if (!artifact) throw new Error("Select an exact URL returned by this pinned species page");
  return request(url, "HEAD", async response => {
    const length = response.headers.get("content-length");
    const etag = response.headers.get("etag");
    if (!length || !/^[1-9]\d*$/.test(length) || !Number.isSafeInteger(Number(length))) throw new Error("Bgee artifact requires an exact positive byte size");
    if (!etag || !/^"[^"\r\n]+"$/.test(etag)) throw new Error("Bgee artifact requires a strong ETag for conditional acquisition");
    if ((response.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity") throw new Error("Artifact HTTP encoding must preserve original gzip bytes");
    return { format_version: "bgee-bulk-manifest-1", source: discovery.source,
      artifact: { ...artifact, bytes: Number(length), etag, last_modified: response.headers.get("last-modified"), compression: "gzip" },
      scope: "Pinned source page and HTTP validators; ETag is not a checksum. Complete transferred gzip bytes require SHA-256 and full import verification. No release, schema or quality-correction inference.",
    };
  });
}
