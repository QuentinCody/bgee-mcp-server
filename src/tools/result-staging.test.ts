import { hashCanonicalJson } from "@bio-mcp/shared";
import { DynamicWorkerExecutor } from "@bio-mcp/shared/codemode/execute-tool";
import { McpServer } from "@bio-mcp/shared/mcp";
import { afterEach, expect, it, vi } from "vitest";
import { bgeeResponse } from "../lib/tool-result";
import { registerCodeMode } from "./code-mode";
import { registerGetSchema } from "./get-schema";
import { registerQueryData } from "./query-data";

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const stored: unknown[] = [];
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/process") {
      const { data } = await request.json() as { data: unknown };
      stored.push(typeof data === "string" ? JSON.parse(data) : data);
      return Response.json({ success: true, tables_created: ["payloads"], total_rows: 1 });
    }
    if (path === "/query") return Response.json({ success: true, results: [{ native_text: "α".repeat(22000) }], row_count: 1 });
    return Response.json({ success: true, schema: { tables: { rows: { columns: [{ name: "text", description: "α".repeat(22000) }] } } } });
  } }) };
  const env = { BGEE_DATA_DO: namespace, CODE_MODE_LOADER: { get: () => ({}) } } as unknown as Parameters<typeof registerCodeMode>[1];
  const server = new McpServer({ name: "fixture", version: "1" });
  await registerCodeMode(server, env); registerQueryData(server, env); registerGetSchema(server, env);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<Record<string, unknown>> }> })._registeredTools;
  return { stored, env, tools };
}

it.each(["", "mcp_"])("stages a composed isolate result below 100KB through %s execution", async prefix => {
  const { tools, stored } = await fixture();
  const native = { observations: [{ source: "fixture", text: "α".repeat(22000), values: [0, null, "0001"] }] };
  // Only V8 is replaced; final result handling, citation, registration and staging are real.
  vi.spyOn(DynamicWorkerExecutor.prototype, "execute").mockResolvedValue({ result: native });
  const result = await tools[`${prefix}bgee_execute`].handler({ code: "return composed;" }, {});
  expect(result).toMatchObject({ content: expect.any(Array), structuredContent: { success: true, staged: true, _staging: expect.any(Object), _meta: { citation: { result_hash: expect.any(String) } } } });
  expect(stored).toContainEqual(expect.objectContaining({ structuredContent: expect.objectContaining({ data: native }) }));
  const complete = stored.find(value => (value as { structuredContent?: { data?: unknown } }).structuredContent?.data !== undefined);
  expect(result).toMatchObject({ structuredContent: { _meta: { citation: { result_scope: "staged:full_result", result_hash: await hashCanonicalJson(complete) } } } });
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(30000);
});

it.each(["bgee_query_data", "mcp_bgee_query_data", "bgee_get_schema", "mcp_bgee_get_schema"])("keeps complete large SQL/schema output recoverable through %s", async name => {
  const { tools, stored } = await fixture();
  const result = await tools[name].handler({ data_access_id: "fixture", sql: "SELECT native_text FROM rows" }, {});
  expect(result).toMatchObject({ content: expect.any(Array), structuredContent: { success: true, staged: true, _staging: expect.any(Object) } });
  expect(JSON.stringify(stored)).toContain("α".repeat(22000));
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(30000);
});

it("retains failure state and full error evidence when staging", async () => {
  const { env, stored } = await fixture();
  const original = { content: [{ type: "text" as const, text: "error evidence" }], structuredContent: { success: false, error: { message: "α".repeat(22000) } } };
  expect(await bgeeResponse(async () => original, env, "bgee_execute", {})).toMatchObject({ isError: true, structuredContent: { success: false, staged: true } });
  expect(stored).toContainEqual(expect.objectContaining({ ...original, isError: true,
    structuredContent: expect.objectContaining({ success: false, error: original.structuredContent.error, _meta: expect.objectContaining({ citation: expect.any(Object) }) }) }));
});

it("fails explicitly when an oversized response cannot be staged", async () => {
  expect(await bgeeResponse(async () => ({ content: [{ type: "text", text: "α".repeat(22000) }] }), {}, "bgee_execute", {})).toMatchObject({ isError: true, content: expect.any(Array), structuredContent: { success: false, error: { code: "RESPONSE_ERROR" } } });
});
