import { createSparqlExecuteTool } from "@bio-mcp/shared/codemode/sparql-execute-tool";
import type { McpServer } from "@bio-mcp/shared/mcp";
import { createBgeeSession } from "../lib/session";
import { BGEE_SPARQL_ENDPOINT, createBgeeSparqlFetch } from "../lib/sparql";
import { bgeeResponse } from "../lib/tool-result";

interface CodeModeEnv {
	BGEE_DATA_DO: DurableObjectNamespace;
	CODE_MODE_LOADER: WorkerLoader;
}

const BGEE_PREAMBLE = `
// --- Bgee SPARQL notes ---
// Bgee is a database of gene expression patterns in healthy wild-type animals.
// The endpoint exposes the EasyBgee subset, not every experiment or processed value.
//
// Common patterns:
// - Gene expression in tissue:
//     PREFIX orth: <http://purl.org/net/orth#>
//     PREFIX genex: <http://purl.org/genex#>
//     PREFIX obo: <http://purl.obolibrary.org/obo/>
//     SELECT ?gene WHERE {
//       ?gene orth:organism/obo:RO_0002162 <http://purl.uniprot.org/taxonomy/9606> ;
//             genex:isExpressedIn obo:UBERON_0002107 .
//     } LIMIT 10
//
// - Anatomy lookup: prefer UBERON IRIs (e.g. obo:UBERON_0002107 for liver).
//
// - Reported absence uses genex:isAbsentIn or genex:AbsenceExpression.
//   ASK false or an empty result means no matching assertion, not proven biological absence.
// - Preserve gene and species IDs; matching symbols across species does not establish orthology.
// - Use bounded SELECT previews. Keep condition, quality and expression-score meanings separate.
// - No FROM clause selects latest. FROM <https://bgee.org/rdf_v15_1> automatically
//   selects https://www.bgee.org/sparql15_1/. The query is not rewritten.
//   Only this documented archive is supported; GRAPH, FROM NAMED, multiple FROM
//   clauses, prefixed graph names and Virtuoso DEFINE directives are rejected.
// - Use sparql.raw() to retain RDF term types and _bgee routing metadata.
//   requested_release is a route selection, not independently verified dataset content.
// - Bulk calls/processed values require their own release, condition and file provenance.
// - GET is the default; explicit POST remains available without fallback. Native POST
//   returned a Cloudflare challenge during October 4 validation. Query errors are retained.
// - Full raw RDF envelopes survive staging. source_observations preserves every read,
//   including for flattened query() and boolean ask() results. Inspect native_json in SQL.
//
// - Bgee is a wild-type, healthy expression source — for disease expression use other resources.
const bgeeQuery = sparql.query;
sparql.query = (query, opts) => bgeeQuery(query, Object.assign({method: "GET", timeoutMs: 45000}, opts || {}));
sparql.ask = async (query, opts) => {
  const result = await sparql.raw(query, opts);
  if (result && result.__staged) return result;
  if (!result || typeof result.boolean !== "boolean") throw new Error("Bgee ASK response lacks a boolean");
  return result.boolean;
};
`;

export async function registerCodeMode(server: McpServer, env: CodeModeEnv): Promise<void> {
	const makeTool = (sparqlFetch = createBgeeSparqlFetch()) => createSparqlExecuteTool({
		prefix: "bgee",
		apiName: "Bgee",
		sparqlFetch,
		endpointUrl: BGEE_SPARQL_ENDPOINT,
		doNamespace: env.BGEE_DATA_DO,
		loader: env.CODE_MODE_LOADER,
		// The server session stages full RDF before the shared proxy can flatten it.
		stagingThreshold: Number.MAX_SAFE_INTEGER,
		timeout: 90_000,
		preamble: BGEE_PREAMBLE,
		// Do not run speculative GRAPH/probe queries before the user's selected route.
		description: { endpointUrl: BGEE_SPARQL_ENDPOINT, graphs: [], predicates: [], classes: [], warnings: ["Endpoint shape is not exhaustively probed. Use the documented bounded expression recipes."] },
	});

	const executeTool = makeTool();
	await executeTool.register({tool: (...args: unknown[]) => {
		const [name, ...rest] = args;
		rest.pop();
		const respond = (input: unknown, extra: unknown) => bgeeResponse(async () => {
			const session = createBgeeSession(env.BGEE_DATA_DO, extra);
			let handler: ((args: unknown, extra: unknown) => ReturnType<Parameters<typeof bgeeResponse>[0]>) | undefined;
			await makeTool(session.fetch).register({ tool: (...values: unknown[]) => { handler = values[values.length - 1] as typeof handler; } });
			if (!handler) throw new Error("Bgee executor unavailable");
			const result = await handler(input, extra);
			return { ...result, ...(session.failed() ? { isError: true } : {}), structuredContent: { ...result.structuredContent,
				...(session.failed() ? { success: false } : {}), source_observations: session.observations } };
		}, env, String(name), extra, input);
		const register = server.tool.bind(server) as (...values: unknown[]) => void;
		register(name, ...rest, respond);
		register(`mcp_${String(name)}`, ...rest, respond);
	}});
}
