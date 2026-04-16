import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSparqlExecuteTool } from "@bio-mcp/shared/codemode/sparql-execute-tool";
import { BGEE_SPARQL_ENDPOINT, createBgeeSparqlFetch } from "../lib/sparql";

interface CodeModeEnv {
	BGEE_DATA_DO: DurableObjectNamespace;
	CODE_MODE_LOADER: WorkerLoader;
}

const BGEE_PREAMBLE = `
// --- Bgee SPARQL notes ---
// Bgee is a database of gene expression patterns in healthy wild-type animals.
// Endpoint covers UBERON anatomy, GO molecular function, NCBI taxonomy, EFO species/strain.
//
// Common patterns:
// - Gene expression in tissue:
//     PREFIX up: <http://purl.uniprot.org/core/>
//     PREFIX obo: <http://purl.obolibrary.org/obo/>
//     SELECT ?gene WHERE { ?gene up:organism taxon:9606 ; up:tissue obo:UBERON_0002107 } LIMIT 10
//
// - Anatomy lookup: prefer UBERON IRIs (e.g. obo:UBERON_0002107 for liver).
//
// - Use ASK for boolean checks; SELECT with LIMIT for previews; CONSTRUCT only when you need triples.
//
// - Bgee is a wild-type, healthy expression source — for disease expression use other resources.
`;

export function registerCodeMode(server: McpServer, env: CodeModeEnv): void {
	const sparqlFetch = createBgeeSparqlFetch();

	const executeTool = createSparqlExecuteTool({
		prefix: "bgee",
		apiName: "Bgee",
		sparqlFetch,
		endpointUrl: BGEE_SPARQL_ENDPOINT,
		doNamespace: env.BGEE_DATA_DO,
		loader: env.CODE_MODE_LOADER,
		preamble: BGEE_PREAMBLE,
	});

	executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
