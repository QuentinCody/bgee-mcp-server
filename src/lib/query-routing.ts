export const BGEE_SPARQL_ENDPOINT = "https://www.bgee.org/sparql/";
export const BGEE_ARCHIVE = {
  release: "15.1",
  endpoint: "https://www.bgee.org/sparql15_1/",
  graph: "https://bgee.org/rdf_v15_1",
} as const;

// Recognize dataset clauses without confusing IRIs, comments, variables or literals
// for keywords. This is routing, not a general SPARQL syntax validator.
function tokens(query: string): string[] {
  return (query.match(/#[^\r\n]*|"""(?:\\[\s\S]|(?!""")[\s\S])*"""|'''(?:\\[\s\S]|(?!''')[\s\S])*'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<[^<>\s]*>|[?$]?[\p{L}_][\p{L}\p{N}_:.-]*|:[\p{L}\p{N}_:.-]+|[^\s]/gu) ?? [])
    .filter(token => !token.startsWith("#") && !token.startsWith('"') && !token.startsWith("'"));
}

export function routeBgeeQuery(query: string) {
  if (typeof query !== "string" || !query.trim() || new TextEncoder().encode(query).byteLength > 128 * 1024) {
    throw new Error("Bgee query must contain 1–131072 UTF-8 bytes");
  }
  const words = tokens(query);
  const from = words.flatMap((word, index) => word.toUpperCase() === "FROM" ? [index] : []);
  if (words.some(word => ["GRAPH", "DEFINE"].includes(word.toUpperCase()) || word === "\\")) {
    throw new Error("Bgee routing supports the default latest graph or one explicit archive FROM IRI; GRAPH, DEFINE and escaped keywords are unsupported");
  }
  if (!from.length) return {endpoint: BGEE_SPARQL_ENDPOINT, requested_release: null, graph: null};
  if (from.length !== 1 || words[from[0] + 1] !== `<${BGEE_ARCHIVE.graph}>`) {
    throw new Error(`Use exactly FROM <${BGEE_ARCHIVE.graph}> for the documented ${BGEE_ARCHIVE.release} archive; other dataset clauses are unsupported`);
  }
  return {endpoint: BGEE_ARCHIVE.endpoint, requested_release: BGEE_ARCHIVE.release, graph: BGEE_ARCHIVE.graph};
}
