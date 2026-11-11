# bgee-mcp-server

MCP server wrapping the [Bgee SPARQL endpoint](https://www.bgee.org/sparql/) — a curated database of healthy wild-type animal gene expression.

## Tools

- `bgee_execute(code)` — run JavaScript in a V8 isolate with `sparql.query()`, `sparql.ask()`, `sparql.raw()`, and a pre-built `prefixHeader` for common ontology prefixes (UBERON, GO, EFO, OBI, SIO, UniProt, Ensembl, Bgee).
- `bgee_get_schema(data_access_id?)` — list staged SPARQL result tables, or describe one.
- `bgee_query_data(data_access_id, sql)` — SQL over staged results.
- `bgee_bulk_files(action, species_id, ...)` — discover public expression-call gzip TSV links and pin a selected download manifest for local import.

All four tools also register their `mcp_bgee_*` aliases. Complete responses above
30 KiB stage through the existing Durable Object, including composed results,
SQL, schema and errors. All eight aliases retain both MCP content fields and
verifiable citations on successful and failed responses.

Query helpers default to GET with a 45-second native request budget (an explicit
positive `timeoutMs` can be at most 60 seconds). Explicit POST is preserved without
fallback; native POST returned a Cloudflare HTTP 403 challenge on October 4.
Requests use the exact `application/sparql-results+json` Accept header: the tested
archive query returned 100 rows with that header but zero with a negotiated
media-type list, including when the user agent was held constant. The adapter
does not reinterpret empty responses as biological absence.

## SPARQL archetype

Bgee is the first SPARQL server in this fleet. It uses the shared
`createSparqlExecuteTool` factory at
`packages/mcp-shared/src/codemode/sparql-execute-tool.ts`.

## Endpoint

- Base: `https://www.bgee.org/sparql/`
- Docs: <https://www.bgee.org/support/tutorial-query-bgee-knowledge-graph-sparql>
- Original skill: `reference-repos/openai-plugins/plugins/life-science-research/skills/bgee-skill/`

## Local dev

```bash
./scripts/dev-servers.sh bgee
```

## Expression evidence recipes

The [official SPARQL tutorial](https://www.bgee.org/support/tutorial-query-bgee-knowledge-graph-sparql)
documents the EasyBgee subset. Use `orth:organism/obo:RO_0002162` for species,
`genex:isExpressedIn` for presence and `genex:isAbsentIn` for reported absence.
The Code Mode preamble now uses these predicates instead of the former incorrect
`up:organism`/`up:tissue` example.

Run this bounded preview through `bgee_execute`. It keeps the gene, species,
anatomy and assertion type together:

```javascript
const query = `
PREFIX orth: <http://purl.org/net/orth#>
PREFIX genex: <http://purl.org/genex#>
PREFIX obo: <http://purl.obolibrary.org/obo/>
PREFIX dcterms: <http://purl.org/dc/terms/>
SELECT DISTINCT ?gene ?geneId ?species ?anatomy ?assertion WHERE {
  VALUES (?geneId ?species) {
    ("ENSG00000130208" <http://purl.uniprot.org/taxonomy/9606>)
  }
  VALUES ?assertion { genex:isExpressedIn genex:isAbsentIn }
  ?gene a orth:Gene ; dcterms:identifier ?geneId ;
        orth:organism/obo:RO_0002162 ?species ; ?assertion ?anatomy .
  ?anatomy a genex:AnatomicalEntity .
} LIMIT 100`;
return await sparql.raw(query);
```

An empty result or false `ASK` does not establish biological absence. This
anatomy preview omits detailed conditions and quality. The latest endpoint must
not receive an archived `FROM` graph. The adapter recognizes the documented
15.1 graph and routes it to its matching archive endpoint. October 4 native and
local MCP reads verify 100 returned APOE assertions from each route. The latest
bounded page contains presence assertions; the archive page contains both
presence and absence assertions. These different pages are not a complete or
condition-matched comparison between releases.

For a cross-species comparison, first obtain independently supported ortholog
IDs and add their gene-ID/species pairs to `VALUES`. Retain every mapped gene,
the orthology source/release, relationship type and multiplicity. Matching symbols
do not establish orthology. Retain each species' original anatomy identifiers
and the evidence supporting any anatomical homology mapping; do not silently
equate condition labels. Treat this as a comparison of assertions, not a test
of conserved expression. Bgee's [comparative expression paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC7778977/)
describes the distinct roles of gene and anatomical homology.

An October 4 cross-source example uses the independently retrieved Ensembl
`ENSEMBL_ORTHOLOGUES` relationship between human `ENSG00000130208` and mouse
`ENSMUSG00000040564` (`ortholog_one2one`, taxonomy level Euarchontoglires).
The latest Bgee graph returns `genex:isExpressedIn` for both genes at
`UBERON_0002107` (liver), with original species IDs 9606 and 10090. The native
orthology response and query are retained in the dated acceptance artifacts.
The archive rejected the initial identifier-join query because its estimated
execution cost exceeded the provider's limit. Binding the exact gene IRIs
observed in the latest results, while rechecking their identifiers and species
in the archive query, returned the same two assertions. Preserve the cost error;
do not treat it as an empty biological result or retry an unbounded join.
This is a comparison of source assertions, not evidence of conserved expression
levels, matched experimental conditions or independent anatomical homology.

For that observed pair, the following archive query was accepted through native
HTTP and MCP. The gene IRIs are source observations, not a general rule for
constructing Bgee identifiers:

```javascript
return await sparql.raw(`
PREFIX orth: <http://purl.org/net/orth#>
PREFIX genex: <http://purl.org/genex#>
PREFIX obo: <http://purl.obolibrary.org/obo/>
PREFIX dcterms: <http://purl.org/dc/terms/>
SELECT ?gene ?geneId ?species ?anatomy ?assertion
FROM <https://bgee.org/rdf_v15_1> WHERE {
  VALUES (?gene ?geneId ?species) {
    (<http://omabrowser.org/ontology/oma#GENE_ENSG00000130208>
      "ENSG00000130208" <http://purl.uniprot.org/taxonomy/9606>)
    (<http://omabrowser.org/ontology/oma#GENE_ENSMUSG00000040564>
      "ENSMUSG00000040564" <http://purl.uniprot.org/taxonomy/10090>)
  }
  VALUES ?assertion { genex:isExpressedIn genex:isAbsentIn }
  ?gene dcterms:identifier ?geneId ;
        orth:organism/obo:RO_0002162 ?species ;
        ?assertion obo:UBERON_0002107 .
  BIND(obo:UBERON_0002107 AS ?anatomy)
} ORDER BY ?geneId ?assertion LIMIT 100`);
```

## Quality and bulk data

The [expression-call file specification](https://www.bgee.org/support/tutorial-expression-call-download-documentation)
provides call quality, FDR and expression score as separate columns. Keep them
separate: the score is not a confidence probability. Preserve condition columns,
per-data-type support and observed/propagated distinctions where supplied. Record
quality exclusions; a filtered-out call is not an absent call. Validate the real
download header before applying filters rather than assuming the SPARQL graph
contains every bulk field.

Use the provider's species/download pages to discover actual artifacts, rather
than constructing filenames. For example, the [Northern pike page](https://www.bgee.org/species/8010)
lists anatomy-only and all-condition calls, RNA-seq annotations and count/TPM
archives, alongside the Eluc_v4 genome annotation. These products answer different
questions. Bulk ingestion is now available through the [local Python workflow](scripts/README.md).
Use `bgee_bulk_files` with `action: "discover"` and the species ID, then select an
exact returned URL using `action: "manifest"` and `expected_artifacts_sha256`.
The link-list hash tolerates unrelated page-text changes while each observed
HTML page retains its own SHA-256; `expected_html_sha256` optionally requires the
entire decoded page text to match. The manifest binds a complete byte size and
strong ETag for conditional acquisition. It does not fetch expression records
inside the Worker. Processed RNA-seq tarballs remain a distinct product.

The importer verifies the acquired gzip SHA-256, complete gzip/UTF-8/TSV structure,
and required native headers before publishing a new local SQLite snapshot.
All string cells, duplicate occurrences, unknown extra columns and original
decoded records survive. Native condition scope is checked against the selected
anatomy/all-condition product; missing conditions stay unrepresented. Gene,
anatomy, expression, quality and condition filters are explicit literal matches,
with counts of excluded rows. FDR, score, rank, quality and per-data-type evidence
remain separate. No numeric coercion, implicit quality exclusion, deduplication
or cross-species equivalence is applied. Export verifies the complete decoded
source hash. Existing output paths are never overwritten.

The manifest retains the requested species page, retrieval time, observed links
and HTTP validators; SHA-256 identifies acquired bytes. Release and genome
annotation remain unknown when discovery does not establish them. An optional
caller-declared genome annotation is stored separately from observed metadata.
The mutable `/ftp/current/` path and a strong ETag are not a named-release guarantee.

The [February 12, 2026 provider notice](https://www.bgee.org/about/news) says
incorrectly processed expression values from SRP222001 were removed and corrected
data were planned for Bgee 16.0. Do not assume that a cached artifact includes
the correction, or that the announcement establishes a released 16.0 dataset.
The February 24 ELIXIR designation is resource news, not evidence of a new API.

## Archived 15.1 queries

The [provider tutorial](https://www.bgee.org/support/tutorial-query-bgee-knowledge-graph-sparql)
documents `https://www.bgee.org/sparql15_1/` with graph
`https://bgee.org/rdf_v15_1`. Use the existing `bgee_execute` tool:

```javascript
const result = await sparql.raw(`
PREFIX orth: <http://purl.org/net/orth#>
PREFIX genex: <http://purl.org/genex#>
PREFIX obo: <http://purl.obolibrary.org/obo/>
SELECT ?gene FROM <https://bgee.org/rdf_v15_1> WHERE {
  ?gene orth:organism/obo:RO_0002162 <http://purl.uniprot.org/taxonomy/9606> ;
        genex:isExpressedIn obo:UBERON_0002107 .
} LIMIT 10`);
return result;
```

With no dataset clause, queries continue to use the latest endpoint. Exactly
one explicit `FROM <https://bgee.org/rdf_v15_1>` selects the documented archive
automatically, without rewriting the query. Other graphs, `FROM NAMED`, multiple
dataset clauses, `GRAPH` and Virtuoso `DEFINE` directives are rejected to avoid
silently mixing releases. Prefixed graph names are not resolved by this router;
use the full graph IRI. Comments and string literals do not select an archive.

`sparql.raw()` retains complete native RDF envelopes inline and through staging,
including term types, language/datatype fields, unbound variables, ordering flags
and unknown fields. `_bgee` metadata retains the exact query, method, source URL,
selected endpoint, requested release/graph, status, byte count and retrieval time.
The selected route does not independently verify remote dataset contents:
`observed_release` remains null and `snapshot_verified` false. Large results
retain legacy `sparql_genes`/`sparql_anatomy`/`sparql_species`/`sparql_results`
tables with lexical values stored as TEXT and complete per-binding `native_json`.
`rdf_context` retains the remaining head, query, response and results context;
`payloads`/`content_chunks` retain the full source envelope. Inspect `get_schema`
before SQL and use bounded pages/substrings for large retrievals.

`structuredContent.source_observations` retains every source read or staged
reference, including for flattened `sparql.query()` and boolean `sparql.ask()`
results. ASK preserves false; malformed or unavailable responses fail rather
than becoming false. If the native envelope itself is staged, return the handle
and retrieve it rather than treating it as a boolean. Execution contexts remain
isolated between concurrent calls; a program is capped at 64 native queries.

`_bgee.native_sha256` hashes the canonical native envelope before `_bgee` metadata;
`response_sha256` hashes the native response bytes. Tool citations hash the
returned structured result or complete staged result using the exact caller
arguments. These are separate hash scopes. Full native error bodies survive
staging, including when a user program catches an upstream exception; the tool
still reports the failed observation. Redirects and partial HTTP responses fail
explicitly. Each response is bounded to 4 MiB with a bounded body read; narrow
queries that exceed it. No speculative graph-discovery query runs before the
user's selected route.

Reviewed October 4, 2026. Native latest/archive queries, both aliases, full RDF
and SQL recovery, true/false ASK, syntax errors and explicit POST failures pass
local live acceptance. Dated results and remaining limitations are recorded in
the [implementation tracker](../../docs/plans/2026-09-26-upstream-api-implementation.md).
October 5 adds bulk discovery/manifests and complete local expression-call imports.
Synthetic acceptance covers all four products, both aliases and every source
cell/decoded byte. Native species-page HTML parsing, HEAD validators, gzip bytes
and Workerd acceptance remain pending; shell discovery currently fails DNS.
No newly announced endpoint or unverified 15.2/16.0 archive has been inferred.

<!-- license-and-data-terms:start -->
## License and data terms

The code in this repository is licensed under the Apache License 2.0 (see `LICENSE`).
If you use it in your work, please cite it (see `CITATION.cff`). Citation is requested, not required.

The license covers the code only. Data that this server returns comes from Bgee and stays under the terms of that source: CC0.
You are responsible for your use of the data under those terms.
<!-- license-and-data-terms:end -->
