# bgee-mcp-server

MCP server wrapping the [Bgee SPARQL endpoint](https://www.bgee.org/sparql/) — a curated database of healthy wild-type animal gene expression.

## Tools

- `bgee_execute(code)` — run JavaScript in a V8 isolate with `sparql.query()`, `sparql.ask()`, `sparql.raw()`, and a pre-built `prefixHeader` for common ontology prefixes (UBERON, GO, EFO, OBI, SIO, UniProt, Ensembl, Bgee).
- `bgee_get_schema(data_access_id?)` — list staged SPARQL result tables, or describe one.
- `bgee_query_data(data_access_id, sql)` — SQL over staged results.

## SPARQL archetype

Bgee is the first SPARQL server in this fleet. It uses the shared
`createSparqlExecuteTool` factory at
`packages/mcp-shared/src/codemode/sparql-execute-tool.ts`.

## Endpoint

- Base: `https://www.bgee.org/sparql/`
- Docs: <https://www.bgee.org/support/tutorial-tagcloud-sparql>
- Original skill: `reference-repos/openai-plugins/plugins/life-science-research/skills/bgee-skill/`

## Local dev

```bash
./scripts/dev-servers.sh bgee   # after the server is wired into config/server-manifest.json
```
