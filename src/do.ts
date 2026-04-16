import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

/**
 * Bgee staging DO. Bgee responses come from SPARQL — when a SELECT result is
 * staged, the proxy already flattens bindings into plain rows of
 * { variable: value } shape. We classify by the variables observed.
 */
export class BgeeDataDO extends RestStagingDO {
	protected getSchemaHints(data: unknown): SchemaHints | undefined {
		if (!Array.isArray(data) || data.length === 0) return undefined;
		const sample = data[0];
		if (!sample || typeof sample !== "object") return undefined;

		const keys = Object.keys(sample);
		if (keys.includes("gene") || keys.includes("geneId")) {
			return { tableName: "sparql_genes", indexes: ["gene", "geneId"].filter((k) => keys.includes(k)) };
		}
		if (keys.includes("anat") || keys.includes("anatEntity")) {
			return { tableName: "sparql_anatomy", indexes: ["anat", "anatEntity"].filter((k) => keys.includes(k)) };
		}
		if (keys.includes("species") || keys.includes("taxon")) {
			return { tableName: "sparql_species", indexes: ["species", "taxon"].filter((k) => keys.includes(k)) };
		}
		return { tableName: "sparql_results" };
	}
}
