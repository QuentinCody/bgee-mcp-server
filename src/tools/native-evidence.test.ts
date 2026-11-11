import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));

import { canonicalJson, verifyCitationEnvelope } from "@bio-mcp/shared";
import { fixture, recover } from "./staging-fixture";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/sparql-results+json" } });
async function invoke(f: Awaited<ReturnType<typeof fixture>>, name: string, args: unknown, failed = false) {
  const result = await f.tools[name].handler(args, {});
  expect(result.isError === true, JSON.stringify(result).slice(0, 800)).toBe(failed);
  const sc = result.structuredContent;
  let original = sc;
  let full: Awaited<ReturnType<typeof recover>> | undefined;
  if (sc.staged) { full = await recover(f, sc.data_access_id, ""); original = full.structuredContent; }
  let data = original.data;
  if (data?.__staged) data = await recover(f, data.data_access_id, "");
  const proof = await verifyCitationEnvelope({ citation: sc._meta.citation, structuredContent: sc, toolArguments: args, ...(full ? { materialized: { value: full } } : {}) });
  expect(proof.verification).toMatchObject({ query: "verified", result: "verified" });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(30720);
  return { sc, original, data, id: original.data?.data_access_id ?? sc.data_access_id };
}
const query = 'SELECT ?gene ?label ?count ?optional FROM <https://bgee.org/rdf_v15_1> WHERE {?gene ?p ?label} LIMIT 2';
const native = { head: { vars: ["gene", "label", "count", "optional"], link: ["https://www.bgee.org"] }, results: { ordered: true, distinct: false, bindings: [
  { gene: { type: "uri", value: "https://example.org/gene/001" }, label: { type: "literal", value: "gène α😀".repeat(3000), "xml:lang": "fr" }, count: { type: "typed-literal", value: "001", datatype: "http://www.w3.org/2001/XMLSchema#integer" } },
  { gene: { type: "bnode", value: "node1" }, label: { type: "literal", value: "" }, optional: { type: "literal", value: "0.00000000000000000001", datatype: "http://www.w3.org/2001/XMLSchema#decimal" } },
] } };

it.each(["", "mcp_"])("preserves the complete RDF envelope, lexical values and native context through %s SQLite", async prefix => {
  const f = await fixture();
  vi.stubGlobal("fetch", vi.fn(async () => json(native)));
  try {
    const result = await invoke(f, `${prefix}bgee_execute`, { code: `return await sparql.raw(${JSON.stringify(query)});` });
    expect(result.data).toMatchObject(native);
    expect(result.data._bgee).toMatchObject({ method: "GET", requested_release: "15.1", query, snapshot_verified: false, complete: false });
    const { _bgee, ...provider } = result.data;
    expect(_bgee.native_sha256).toBe(createHash("sha256").update(canonicalJson(provider)).digest("hex"));
    expect(result.sc._meta.completeness.complete).toBe(false);
    const schema = await invoke(f, `${prefix}bgee_get_schema`, { data_access_id: result.id });
    expect(Object.keys(schema.data.schema.tables)).toEqual(expect.arrayContaining(["sparql_genes", "rdf_context", "payloads"]));
    const sql = await invoke(f, `${prefix}bgee_query_data`, { data_access_id: result.id, sql: 'SELECT gene,"count",typeof("count") AS count_type,optional,native_json FROM sparql_genes ORDER BY _rowid' });
    expect(sql.data.rows[0]).toMatchObject({ gene: native.results.bindings[0].gene.value, count: "001", count_type: "text", optional: null });
    expect(sql.data.rows.map((r: { native_json: string }) => JSON.parse(r.native_json))).toEqual(native.results.bindings);
    const context = await invoke(f, `${prefix}bgee_query_data`, { data_access_id: result.id, sql: "SELECT native_json,results_context FROM rdf_context" });
    expect(JSON.parse(context.data.rows[0].native_json)).toMatchObject({ head: native.head, _bgee: { native_sha256: _bgee.native_sha256 } });
    expect(JSON.parse(context.data.rows[0].results_context)).toEqual({ ordered: true, distinct: false });
  } finally { f.close(); }
});

it("retains native observations for flattened SELECT and false ASK without treating missing booleans as false", async () => {
  const f = await fixture();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ head: { vars: ["n"] }, results: { bindings: [{ n: { type: "literal", value: "001" } }] } })).mockResolvedValueOnce(json({ head: {}, boolean: false })).mockResolvedValueOnce(json({ head: {}, boolean: "false" })));
  try {
    const rows = await invoke(f, "bgee_execute", { code: 'return await sparql.query("SELECT ?n WHERE {?n ?p ?o} LIMIT 1");' });
    expect(rows.data).toEqual([{ n: "001" }]);
    expect(rows.original.source_observations[0].results.bindings[0].n.type).toBe("literal");
    const ask = await invoke(f, "mcp_bgee_execute", { code: 'return await sparql.ask("ASK {?s ?p ?o}");' });
    expect(ask.data).toBe(false);expect(ask.original.source_observations[0].boolean).toBe(false);
    const invalid = await invoke(f, "bgee_execute", { code: 'return await sparql.ask("ASK {?s ?p ?o}");' }, true);
    expect(invalid.original.source_observations[0].data.raw_body).toContain('"boolean":"false"');
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  } finally { f.close(); }
});

it("keeps full explicit POST failures even when Code Mode catches the exception", async () => {
  const f = await fixture();const body = `Cloudflare challenge ${"α".repeat(20000)}`;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 403, headers: { "Content-Type": "text/html" } })));
  try {
    const result = await invoke(f, "bgee_execute", { code: 'try {return await sparql.raw("ASK {?s ?p ?o}",{method:"POST"});}catch(e){return {caught:e.message};}' }, true);
    const observation = result.original.source_observations[0];
    const error = await recover(f, observation.data_access_id, "");
    expect(error).toMatchObject({ status: 403, data: { raw_body: body, receipt: { method: "POST", http_status: 403 } } });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

it("keeps per-execution source observations isolated across simultaneous tools", async () => {
  const f = await fixture();
  vi.stubGlobal("fetch", vi.fn(async url => json({ head: { vars: ["query"] }, results: { bindings: [{ query: { type: "literal", value: new URL(String(url)).searchParams.get("query") } }] } })));
  try {
    const results = await Promise.all(["one", "two"].map(label => invoke(f, "bgee_execute", { code: `return await sparql.raw('SELECT ?${label} WHERE {?s ?p ?o} LIMIT 1');` })));
    for (let i = 0; i < results.length; i++) { expect(results[i].original.source_observations).toHaveLength(1);expect(results[i].original.source_observations[0]._bgee.query).toContain(i ? "?two" : "?one"); }
  } finally { f.close(); }
});

it("provides verifiable success and error citations on every alias", async () => {
  const f = await fixture();
  try { for (const prefix of ["", "mcp_"]) {
    await invoke(f, `${prefix}bgee_execute`, { code: "" }, true);
    await invoke(f, `${prefix}bgee_query_data`, { data_access_id: "missing", sql: "SELECT * FROM missing" }, true);
    await invoke(f, `${prefix}bgee_get_schema`, { data_access_id: "missing" });
  } } finally { f.close(); }
});
