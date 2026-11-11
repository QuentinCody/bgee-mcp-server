import type { SparqlFetchFn } from "@bio-mcp/shared/codemode/sparql-introspection";
import { shouldStage, stageToDoAndRespond } from "@bio-mcp/shared/staging/utils";
import { createBgeeSparqlFetch } from "./sparql";

export function createBgeeSession(namespace: DurableObjectNamespace, extra: unknown) {
  const observations: unknown[] = [];
  const read = createBgeeSparqlFetch();
  let failed = false;
  let calls = 0;
  const fetch: SparqlFetchFn = async (query, opts) => {
    if (++calls > 64) { failed = true; throw new Error("Bgee execution exceeds 64 native queries; split the program"); }
    try {
      const native = await read(query, opts) as Record<string, unknown>;
      let result: unknown = native;
      if (shouldStage(new TextEncoder().encode(JSON.stringify(native)).byteLength)) {
        result = await stageBgeeObservation(native, namespace, extra);
      }
      observations.push(result);
      return result;
    } catch (error) {
      failed = true;
      const failure = { error: error instanceof Error ? error.message : String(error), ...(error && typeof error === "object" && "status" in error ? { status: error.status } : {}), ...(error && typeof error === "object" && "data" in error ? { data: error.data } : {}) };
      if (shouldStage(new TextEncoder().encode(JSON.stringify(failure)).byteLength)) {
        const staged = await stageToDoAndRespond(failure, namespace, "bgee", undefined, { toolName: "bgee_execute", serverName: "bgee" }, "bgee", extra as Parameters<typeof stageToDoAndRespond>[6]);
        observations.push({ error: failure.error, __staged: true, data_access_id: staged.dataAccessId, _staging: { ...staged._staging, completeness: { complete: false } } });
      } else observations.push(failure);
      throw error;
    }
  };
  return { fetch, observations, failed: () => failed };
}

async function stageBgeeObservation(native: Record<string, unknown>, namespace: DurableObjectNamespace, extra: unknown) {
  const staged = await stageToDoAndRespond(native, namespace, "bgee", undefined, { toolName: "bgee_execute", serverName: "bgee" }, "bgee", extra as Parameters<typeof stageToDoAndRespond>[6]);
  const context = native._bgee as Record<string, unknown>;
  const bindings = (native.results as { bindings?: unknown[]; } | undefined)?.bindings;
  const completeness = { complete: false, ...(bindings ? { returned: bindings.length } : {}) };
  return {
    __staged: true, data_access_id: staged.dataAccessId, schema: staged.schema, tables_created: staged.tablesCreated, total_rows: staged.totalRows,
    _staging: { ...staged._staging, completeness }, _bgee: { endpoint: context.endpoint, requested_release: context.requested_release, graph: context.graph, observed_release: null, snapshot_verified: false, native_sha256: context.native_sha256 },
    message: "Complete native RDF envelope staged. Inspect get_schema; payloads retains all terms, query and response context."
  };
}
