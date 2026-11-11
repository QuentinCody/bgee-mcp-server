import type { Completeness } from "@bio-mcp/shared";
export function bgeeCompleteness(): Completeness {
  return { complete: false, truncation: { reason: "unknown", detail: "One requested EasyBgee query, not exhaustive expression data or an immutable snapshot. LIMIT, empty bindings and false ASK do not establish biological absence.", remedy: "Keep exact query, requested graph, native RDF terms and source observations. Validate conditions, quality and independent orthology/anatomy mappings separately." } };
}
