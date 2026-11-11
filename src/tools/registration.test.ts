import {McpServer} from "@bio-mcp/shared/mcp";
import {createSparqlProxyTool} from "@bio-mcp/shared/tools/sparql-proxy";
import {afterEach, expect, it, vi} from "vitest";
import {BGEE_ARCHIVE} from "../lib/query-routing";
import {createBgeeSession} from "../lib/session";
import {registerCodeMode} from "./code-mode";
import {registerGetSchema} from "./get-schema";
import {registerQueryData} from "./query-data";
import {registerBulkFiles} from "./bulk-files";

const json = (data: unknown) => new Response(JSON.stringify(data), {headers: {"Content-Type": "application/json"}});
afterEach(() => vi.unstubAllGlobals());

it("registers all four tools with both names and preserves success/error result fields", async () => {
  const server = new McpServer({name: "fixture", version: "1"});
  await registerCodeMode(server, {CODE_MODE_LOADER: {get: () => ({})}} as unknown as Parameters<typeof registerCodeMode>[1]);
  registerGetSchema(server, {}); registerQueryData(server, {});
  registerBulkFiles(server, {});
  const tools = (server as unknown as {_registeredTools: Record<string, {handler: (args: unknown, extra: unknown) => Promise<unknown>}>})._registeredTools;
  expect(Object.keys(tools).sort()).toEqual(["bgee_bulk_files", "bgee_execute", "bgee_get_schema", "bgee_query_data", "mcp_bgee_bulk_files", "mcp_bgee_execute", "mcp_bgee_get_schema", "mcp_bgee_query_data"]);
  expect(await tools.bgee_get_schema.handler({}, {})).toMatchObject({content: expect.any(Array), structuredContent: expect.any(Object)});
  for (const prefix of ["", "mcp_"]) {
    expect(await tools[`${prefix}bgee_execute`].handler({code: ""}, {})).toMatchObject({isError: true, content: expect.any(Array), structuredContent: expect.any(Object)});
    expect(await tools[`${prefix}bgee_query_data`].handler({data_access_id: "fixture", sql: "SELECT 1"}, {})).toMatchObject({isError: true, content: expect.any(Array), structuredContent: expect.any(Object)});
    expect(await tools[`${prefix}bgee_bulk_files`].handler({action: "manifest", species_id: 8010}, {})).toMatchObject({isError: true, content: expect.any(Array), structuredContent: expect.any(Object)});
  }
});

it("stages the full native envelope before shared flattening while retaining archive context", async () => {
  const rows = Array.from({length: 100}, (_, i) => ({gene: {type: "uri", value: `https://example.org/gene/${i}`}, label: {type: "literal", value: "α".repeat(500)}}));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({head: {vars: ["gene", "label"]}, results: {bindings: rows}})));
  const stored: unknown[] = [];
  const namespace = {idFromName: (name: string) => name, get: () => ({fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/process") {
      stored.push((await request.json() as {data: unknown}).data);
      return json({success: true, tables_created: ["sparql_genes"], total_rows: 100});
    }
    return json({success: true, schema: {tables: {sparql_genes: {columns: [{name: "gene"}, {name: "label"}]}}}});
  }})} as unknown as DurableObjectNamespace;
  const proxy = createSparqlProxyTool({sparqlFetch: createBgeeSession(namespace,{}).fetch, doNamespace: namespace, stagingPrefix: "bgee", stagingThreshold: Number.MAX_SAFE_INTEGER});
  const result = await proxy.handler({query: `SELECT ?gene ?label FROM <${BGEE_ARCHIVE.graph}> {?gene ?p ?label} LIMIT 100`}, {sql: () => []});
  expect(result).toMatchObject({__staged: true, data_access_id: expect.any(String), _staging: expect.any(Object), _bgee: {requested_release: "15.1", graph: BGEE_ARCHIVE.graph, endpoint: BGEE_ARCHIVE.endpoint, snapshot_verified: false}});
  expect(JSON.parse(stored[0] as string)).toMatchObject({head:{vars:["gene","label"]},results:{bindings:rows},_bgee:{query:expect.any(String),native_sha256:expect.stringMatching(/^[a-f0-9]{64}$/)}});
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(100000);
});
