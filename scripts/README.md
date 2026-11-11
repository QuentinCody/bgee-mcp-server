# Bgee expression-call snapshots

This standard-library workflow imports one complete provider gzip TSV into a new local SQLite database. It keeps anatomy-only/all-condition and simple/advanced products separate. Processed RNA-seq tarballs remain outside this importer.

1. Call `bgee_bulk_files` with `{"action":"discover","species_id":8010}`. Use actual returned links rather than constructing filenames.
2. Call the same tool with `action: "manifest"`, the same `species_id`, one exact `artifact_url`, and `expected_artifacts_sha256` from `source.artifacts_sha256`. An optional `expected_html_sha256` also requires the entire decoded page to match. Save the returned complete **data object** as `manifest.json`. Recover staged responses through `bgee_query_data` if necessary.
3. Fetch, retain its reported SHA-256, inspect the native header, then import:

```bash
python3 servers/bgee-mcp-server/scripts/bgee_bulk.py fetch manifest.json source.tsv.gz
python3 servers/bgee-mcp-server/scripts/bgee_bulk.py inspect source.tsv.gz
python3 servers/bgee-mcp-server/scripts/bgee_bulk.py import manifest.json source.tsv.gz calls.sqlite \
  --sha256 THE_EXACT_ACQUIRED_SHA256
```

The manifest retains source HTML and its hash, actual selected href, requested species, filename-derived product scope, positive byte size and strong ETag. Python rechecks source membership and hashes. Acquisition sends `If-Match` and requires complete HTTP 200 with the same ETag and exact byte count; redirects, partial responses and HTTP content encoding are rejected. ETag is a request validator, not a checksum. Missing/weak validators require resolving discovery rather than fabricating values. No provider-published SHA-256 is asserted.

Import requires UTF-8, one header record, consistent TSV widths and unambiguous documented core headers. All-condition files additionally require stage/sex/strain columns; advanced files require observed/self/descendant evidence columns. Unknown columns are retained. Quoted tabs/newlines, duplicate records, extra repeated header labels, empty cells, numeric spellings, BOM and CRLF survive. Invalid headers, malformed/truncated gzip or TSV, invalid UTF-8, changed hashes and exceeded budgets leave no published partial database.

Defaults: 128 MiB compressed, 8 GiB decoded, 4 MiB per TSV record and ten million data records. Inspect is a partial preview; full import consumes the entire stream and rechecks compressed bytes before exclusive publication. Limits are configurable admission budgets, not demonstrated maximum-size performance. Existing output paths are protected.

Query literal identifiers and explicit filters:

```bash
python3 servers/bgee-mcp-server/scripts/bgee_bulk.py query calls.sqlite \
  --gene ACTUAL_GENE_ID --anatomy UBERON:0002107 --quality 'gold quality' --limit 100
python3 servers/bgee-mcp-server/scripts/bgee_bulk.py query calls.sqlite \
  --gene ACTUAL_GENE_ID --expression absent --stage ACTUAL_STAGE_ID --sex female
```

Filters are `--gene`, `--anatomy`, `--expression`, `--quality`, `--stage`, `--sex` and `--strain`. Supply a gene or anatomy. Values are exact case-sensitive strings; no filter is implicit. Anatomy-only snapshots reject stage/sex/strain queries. Results include ordered cells, original records, hashes, provenance, base/filtered/excluded counts and continuation offsets. Duplicate occurrences survive pagination. Pages contain at most 1000 rows and 8 MiB of row JSON, plus provenance. Missing or excluded calls do not establish absence. FDR, expression score, rank and call quality are distinct; score is not a confidence probability.

SQLite `source_records` retains header record 0, one-based data-record numbers, indexed literal fields, ordered `cells_json` and exact decoded `raw_record` bytes. `metadata` retains the complete manifest, layout, hashes and counts. Query trusts the local snapshot; export checks all stored source records against the decoded hash:

```bash
python3 servers/bgee-mcp-server/scripts/bgee_bulk.py export calls.sqlite restored.tsv
```

Export matches original **decoded** TSV bytes; acquired gzip remains separately pinned. Release/genome annotation stay unknown unless separately established. Optional `--declared-genome-annotation` records a caller statement separately, not provider verification. Do not infer SRP222001 correction status or cross-species/condition equivalence without independent evidence.

Run `python3 -m unittest discover -s servers/bgee-mcp-server/scripts -p 'test_*.py' -v` for local tests.

Provider references: [expression-call fields](https://www.bgee.org/support/tutorial-expression-call-download-documentation), [species downloads](https://www.bgee.org/species/8010), [data-quality notices](https://www.bgee.org/about/news).
