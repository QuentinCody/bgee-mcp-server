import type { McpServer } from "@bio-mcp/shared/mcp";
import { createCodeModeResponse } from "@bio-mcp/shared/codemode/response";
import { z } from "zod";
import { bulkManifest, discoverBulkFiles } from "../lib/bulk-files";
import { bgeeResponse, type BgeeDataEnv } from "../lib/tool-result";

export function registerBulkFiles(server: McpServer, env: BgeeDataEnv) {
  const schema = {
    title: "Discover and pin Bgee expression-call files",
    description: "Discover actual gzip TSV links on a Bgee species page, then select one exact URL with the discovery artifacts_sha256 to create a conditional-download manifest. An optional html_sha256 pin also requires byte-identical decoded page text. Keeps simple/advanced and anatomy/all-condition products separate. Complete byte verification and occurrence-preserving SQLite import use the local bgee_bulk.py workflow. No processed RNA-seq tarball, release inference or direct expression query is added.",
    inputSchema: {
      action: z.enum(["discover", "manifest"]), species_id: z.number().int().positive(),
      artifact_url: z.string().url().max(2000).optional(),
      expected_html_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      expected_artifacts_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    },
  };
  for (const name of ["bgee_bulk_files", "mcp_bgee_bulk_files"]) server.registerTool(name, schema, (args, extra) => bgeeResponse(async () => {
    if (args.action === "manifest" && (!args.artifact_url || (!args.expected_html_sha256 && !args.expected_artifacts_sha256))) throw new Error("Manifest requires artifact_url and a discovery artifacts_sha256 or html_sha256 pin");
    const data = args.action === "discover" ? await discoverBulkFiles(args.species_id, args.expected_html_sha256, args.expected_artifacts_sha256)
      : await bulkManifest(args.species_id, args.artifact_url!, args.expected_html_sha256, args.expected_artifacts_sha256);
    return createCodeModeResponse(data);
  }, env, name, extra, args));
}
