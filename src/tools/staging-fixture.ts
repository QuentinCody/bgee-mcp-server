/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { DynamicWorkerExecutor } from "@bio-mcp/shared/codemode/execute-tool";
import { McpServer } from "@bio-mcp/shared/mcp";
import { expect, vi } from "vitest";
import { BgeeDataDO } from "../do";
import { registerCodeMode } from "./code-mode";
import { registerGetSchema } from "./get-schema";
import { registerQueryData } from "./query-data";
import { registerBulkFiles } from "./bulk-files";

function createStore() {
  const database = new DatabaseSync(":memory:");
  let ready = Promise.resolve();
  const exec = (query: string, ...values: any[]) => {
    const rows = database.prepare(query).all(...values);
    const iterator = rows[Symbol.iterator]();
    return { toArray: () => rows, one: () => rows[0], next: () => iterator.next(), [Symbol.iterator]: () => iterator };
  };
  const transactionSync = <T>(run: () => T): T => {
    database.exec("BEGIN");
    try { const result = run(); database.exec("COMMIT"); return result; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  };
  const ctx = { blockConcurrencyWhile: (run: () => Promise<void>) => { ready = run(); return ready; }, storage: { sql: { exec }, transactionSync } };
  const instance = new BgeeDataDO(ctx as unknown as DurableObjectState, {} as Cloudflare.Env);
  return { database, instance, ready };
}

export async function fixture() {
  // Replay the generated JavaScript and API helpers; only the Cloudflare isolate is replaced.
  vi.spyOn(DynamicWorkerExecutor.prototype, "execute").mockImplementation(async (code, functions) => {
    const staged: Array<Record<string, unknown>> = [];
    try {
      const run = new Function("codemode", "__stagedResults", "console", `return (${code})();`);
      const result = await run(functions, staged, { warn() {}, log() {} });
      return { result: JSON.parse(JSON.stringify(result)), __stagedResults: staged };
    } catch (error) { return { error: String((error as Error).message), __stagedResults: staged }; }
  });
  const stores = new Map<string, ReturnType<typeof createStore>>();
  const namespace = { idFromName: (name: string) => name, get: (id: string) => ({ fetch: async (request: Request) => {
    let store = stores.get(id);
    if (!store) { store = createStore(); stores.set(id, store); }
    await store.ready;
    return store.instance.fetch(request);
  } }) };
  const env = { BGEE_DATA_DO: namespace, CODE_MODE_LOADER: { get: () => ({}) } } as unknown as Parameters<typeof registerCodeMode>[1];
  const server = new McpServer({ name: "fixture", version: "1" });
  await registerCodeMode(server, env); registerQueryData(server, env); registerGetSchema(server, env);
  registerBulkFiles(server, env);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<any> }> })._registeredTools;
  return { env, tools, close: () => { for (const store of stores.values()) store.database.close(); } };
}

/** Read the actual lossless payload via bounded SQL calls, including chunk storage. */
export async function recover(f: Awaited<ReturnType<typeof fixture>>, id: string, prefix: string) {
  const rows = async (sql: string) => {
    const output = await f.tools[`${prefix}bgee_query_data`].handler({ data_access_id: id, sql }, {});
    expect(output.isError, JSON.stringify(output)).not.toBe(true);
    expect(output.structuredContent.staged).not.toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(output)).byteLength).toBeLessThan(30720);
    return output.structuredContent.data.rows;
  };
  const text = async (table: string, column: string, where: string) => {
    const [{ n }] = await rows(`SELECT length(${column}) AS n FROM ${table} WHERE ${where}`);
    let result = "";
    for (let start = 1; start <= n; start += 1000) {
      const [row] = await rows(`SELECT substr(${column}, ${start}, 1000) AS part FROM ${table} WHERE ${where}`);
      result += row.part;
    }
    return result;
  };
  let raw = await text("payloads", "root_json", "id = 1");
  if (raw.startsWith("__CHUNKED__:")) {
    const chunk = raw.slice("__CHUNKED__:".length);
    expect(chunk).toMatch(/^chunk_[a-f0-9]{32}$/);
    const parts = await rows(`SELECT chunk_index FROM content_chunks WHERE content_id = '${chunk}' ORDER BY chunk_index`);
    raw = "";
    for (const part of parts) raw += await text("content_chunks", "chunk_data", `content_id = '${chunk}' AND chunk_index = ${part.chunk_index}`);
  }
  const decoded = JSON.parse(raw);
  return typeof decoded === "string" ? JSON.parse(decoded) : decoded;
}
