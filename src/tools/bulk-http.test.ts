/// <reference types="node" />
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { verifyCitationEnvelope } from "@bio-mcp/shared";
vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
import { MyMCP } from "../index";
import { fixture, recover } from "./staging-fixture";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const artifact = "https://www.bgee.org/ftp/current/download/calls/expr_calls/Esox_lucius_expr_advanced_all_conditions.tsv.gz";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function rpc(env: unknown, name: string, args: unknown) {
  const request = new Request("http://fixture/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-method": "tools/call", "mcp-name": name, "mcp-protocol-version": "2026-07-28" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) });
  const response = await MyMCP.serve("/mcp").fetch(request, env as never, { waitUntil() {} } as never);
  const wire = await response.text(); expect(response.status, wire).toBe(200); expect(Buffer.byteLength(wire)).toBeLessThan(30720);
  const result = JSON.parse(wire).result;
  expect(result).toMatchObject({ content: expect.any(Array), structuredContent: expect.any(Object) });
  if (!result.structuredContent._staging) {
    const checked = await verifyCitationEnvelope({ citation: result.structuredContent._meta.citation, structuredContent: result.structuredContent, toolArguments: args });
    expect(checked.verification).toMatchObject({ query: "verified", result: "verified", quarantined: false });
  }
  return result;
}
it.each([0, 50000])("retains pinned species HTML and complete manifests through both real HTTP aliases (padding %i)", async padding => {
  const f = await fixture();
  const html = `<html><h1>Esox lucius λ</h1><a href="${artifact}">source</a><p>${'"'.repeat(padding)}</p></html>`;
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => options.method === "HEAD" ? new Response(null, { headers: { "content-length": "12345", etag: '"pinned"' } }) : new Response(html, { headers: { "content-type": "text/html" } })));
  try {
    for (const prefix of ["", "mcp_"]) {
      for (const action of ["discover", "manifest"]) {
        const args = action === "discover" ? { action, species_id: 8010 } : { action, species_id: 8010, artifact_url: artifact, expected_html_sha256: hash(html) };
        const result = await rpc(f.env, prefix + "bgee_bulk_files", args);
        expect(result.isError).not.toBe(true);
        expect(Boolean(result.structuredContent._staging)).toBe(padding > 0);
        const full = result.structuredContent._staging ? await recover(f, result.structuredContent.data_access_id, prefix) : result;
        expect(full.structuredContent.data.source).toMatchObject({ html, html_sha256: hash(html), observed_release: null, genome_annotation: null });
        const checked = await verifyCitationEnvelope({ citation: full.structuredContent._meta.citation, structuredContent: full.structuredContent, toolArguments: args });
        expect(checked.verification).toMatchObject({ query: "verified", result: "verified" });
      }
    }
  } finally { f.close(); }
}, 30000);
it("preserves native discovery failures and pins errors with both aliases", async () => {
  const f = await fixture(); vi.stubGlobal("fetch", vi.fn(async () => new Response("challenge", { status: 403 })));
  try {
    for (const prefix of ["", "mcp_"]) {
      const result = await rpc(f.env, prefix + "bgee_bulk_files", { action: "discover", species_id: 8010 });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("403");
    }
  } finally { f.close(); }
});
