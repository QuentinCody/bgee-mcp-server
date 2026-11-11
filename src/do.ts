import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function table(keys: string[]): string {
  if (keys.includes("gene") || keys.includes("geneId")) return "sparql_genes";
  if (keys.includes("anat") || keys.includes("anatEntity")) return "sparql_anatomy";
  if (keys.includes("species") || keys.includes("taxon")) return "sparql_species";
  return "sparql_results";
}
function unpack(value: unknown): unknown {
  return record(value) && Array.isArray(value.content) && record(value.structuredContent) && "data" in value.structuredContent ? value.structuredContent.data : value;
}
function bindings(data: unknown): Record<string, unknown>[] | undefined {
  return record(data) && record(data.results) && Array.isArray(data.results.bindings) ? data.results.bindings : undefined;
}

export class BgeeDataDO extends RestStagingDO {
  protected getTabularData(value: unknown): unknown {
    const data = unpack(value);
    const native = bindings(data);
    if (native && record(data)) {
      const rows = native.map(binding => ({ ...Object.fromEntries(Object.entries(binding).map(([key, term]) => [key, record(term) ? term.value : null])), native_json: JSON.stringify(binding) }));
      return { [table(Object.keys(native[0] ?? {}))]: rows,
        rdf_context: [{ native_json: JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => key !== "results"))), results_context: JSON.stringify(Object.fromEntries(Object.entries(data.results as Record<string, unknown>).filter(([key]) => key !== "bindings"))) }] };
    }
    if (record(data) && typeof data.sql === "string" && Array.isArray(data.rows)) return { query_rows: data.rows.map(row => ({ native_json: JSON.stringify(row) })) };
    return data;
  }

  protected getSchemaHints(value: unknown): SchemaHints | undefined {
    const data = unpack(value);
    const rows = bindings(data) ?? (Array.isArray(data) ? data : undefined);
    if (!rows?.length || !record(rows[0])) return undefined;
    const keys = [...new Set(rows.flatMap(row => record(row) ? Object.keys(row) : []))];
    // RDF lexical values stay TEXT: "001", typed decimals and IDs are not coerced.
    return { ...(Array.isArray(data) ? { tableName: table(keys) } : {}), columnTypes: Object.fromEntries([...keys, "native_json", "results_context"].map(key => [key, "TEXT" as const])) };
  }
}
