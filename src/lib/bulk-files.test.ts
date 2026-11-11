/// <reference types="node" />
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { bulkManifest, discoverBulkFiles, expressionLinks } from "./bulk-files";

export const pageUrl = "https://www.bgee.org/species/8010";
export const artifactUrl = "https://www.bgee.org/ftp/current/download/calls/expr_calls/Esox_lucius_expr_advanced_all_conditions.tsv.gz";
const html = `<html><h1>Esox lucius</h1><a href="${artifactUrl}">misleading display filename</a></html>`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function upstream(body = html, head: Record<string, string> = {}) {
  const fetcher = vi.fn(async (_url: unknown, options: RequestInit = {}) => options.method === "HEAD"
    ? new Response(null, { headers: { "content-length": "12345", etag: '"fixture"', ...head } })
    : new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
it("derives all four products only from exact provider hrefs, preserving scope and ignoring labels", () => {
  const names = ["simple", "advanced", "simple_all_conditions", "advanced_all_conditions"];
  const markup = names.map(name => `<a href='/ftp/current/download/calls/expr_calls/Esox_lucius_expr_${name}.tsv.gz'>wrong label</a>`).join("");
  const links = expressionLinks(markup + markup, pageUrl);
  expect(links).toHaveLength(4);
  expect(links.map(link => [link.detail, link.condition_scope])).toEqual([["advanced", "anatomy"], ["advanced", "all_conditions"], ["simple", "anatomy"], ["simple", "all_conditions"]]);
});
it.each([
  '<script>"<a href="' + artifactUrl + '">"</script>',
  '<!-- <a href="' + artifactUrl + '"> -->',
  '<a href="https://evil.invalid/ftp/Esox_lucius_expr_simple.tsv.gz">',
  '<a href="http://www.bgee.org/ftp/Esox_lucius_expr_simple.tsv.gz">',
  '<a href="https://user@www.bgee.org/ftp/Esox_lucius_expr_simple.tsv.gz">',
  '<a href="https://www.bgee.org:8443/ftp/Esox_lucius_expr_simple.tsv.gz">',
  '<a href="/ftp/Esox_lucius_expr_simple.tsv.gz?redirect=1">',
  '<a href="/ftp/%2e%2e/Esox_lucius_expr_simple.tsv.gz">',
  '<a href="/ftp/Esox_lucius_RNA-Seq_read_counts_TPM.tar.gz">',
])("rejects scripts/comments, non-provider, ambiguous URLs and distinct tar products %#", markup => {
  expect(() => expressionLinks(markup, pageUrl)).toThrow("no unambiguous");
});
it("rejects a mixed-species page and invalid species identifiers", async () => {
  expect(() => expressionLinks(html + '<a href="/ftp/Homo_sapiens_expr_simple.tsv.gz">', pageUrl)).toThrow("mixes");
  await expect(discoverBulkFiles(0)).rejects.toThrow("positive");
});
it("pins the retained HTML independently of parser output and requires exact selected membership", async () => {
  const fetcher = upstream();
  const found = await discoverBulkFiles(8010);
  expect(found.source).toMatchObject({ html, html_sha256: hash(html), response_sha256: hash(html), observed_release: null, genome_annotation: null });
  const selected = await bulkManifest(8010, artifactUrl, found.source.html_sha256);
  expect(selected.artifact).toMatchObject({ url: artifactUrl, bytes: 12345, etag: '"fixture"', condition_scope: "all_conditions", detail: "advanced" });
  expect(fetcher.mock.calls.every(([, options]) => options?.redirect === "manual")).toBe(true);
  await expect(bulkManifest(8010, artifactUrl.replace("advanced", "simple"), found.source.html_sha256)).rejects.toThrow("exact URL");
  await expect(discoverBulkFiles(8010, "0".repeat(64))).rejects.toThrow("changed");
});
it.each<Record<string, string>>([{ etag: 'W/"weak"' }, { etag: "" }, { "content-length": "0" }, { "content-length": "1.5" }, { "content-encoding": "gzip" }])("rejects unpinnable HEAD validators %#", async headers => {
  upstream(html, headers);
  await expect(bulkManifest(8010, artifactUrl, hash(html))).rejects.toThrow();
});
it("rejects challenges, redirects, partial responses, malformed UTF-8 and oversized pages", async () => {
  for (const response of [new Response("challenge", { status: 403 }), new Response(null, { status: 302 }),
    new Response(html, { headers: { "content-range": "bytes 0-10/50" } }),
    new Response(html, { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([255]), { headers: { "content-type": "text/html" } }),
    new Response("x".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "text/html" } })]) {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(discoverBulkFiles(8010)).rejects.toThrow();
  }
});
it("bounds an upstream that never sends headers", async () => {
  vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  const pending = expect(discoverBulkFiles(8010)).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(15000); await pending;
});
it("pins the download projection across irrelevant page changes while retaining each observed page hash", async () => {
  upstream();
  const found = await discoverBulkFiles(8010);
  upstream(html + "<!-- a changing page timestamp -->");
  const selected = await bulkManifest(8010, artifactUrl, undefined, found.source.artifacts_sha256);
  expect(selected.source.artifacts_sha256).toBe(found.source.artifacts_sha256);
  expect(selected.source.html_sha256).not.toBe(found.source.html_sha256);
  await expect(bulkManifest(8010, artifactUrl, found.source.html_sha256)).rejects.toThrow("changed");
  upstream(html.replace("advanced_all_conditions", "simple"));
  await expect(bulkManifest(8010, artifactUrl, undefined, found.source.artifacts_sha256)).rejects.toThrow("links changed");
});
