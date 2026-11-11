import type { McpServer } from "@bio-mcp/shared/mcp";
import { createGetSchemaHandler } from "@bio-mcp/shared/staging/utils";
import { z } from "zod";
import { type BgeeDataEnv, bgeeResponse } from "../lib/tool-result";

interface SchemaEnv {
	BGEE_DATA_DO?: unknown;
}

export function registerGetSchema(server: McpServer, env?: SchemaEnv): void {
	const handler = createGetSchemaHandler("BGEE_DATA_DO", "bgee");

	for (const name of ["bgee_get_schema", "mcp_bgee_get_schema"]) server.registerTool(
		name,
		{
			title: "Get Staged Bgee Result Schema",
			description:
				"Get schema information for staged Bgee SPARQL or bulk discovery/manifest results. Shows table structures and row counts. " +
				"If called without a data_access_id, lists all staged datasets available in this session.",
			inputSchema: {
				data_access_id: z.string().min(1).optional().describe(
					"Data access ID for the staged dataset. If omitted, lists all staged datasets in this session.",
				),
			},
		},
		async (args, extra) => {
			const runtimeEnv = env || (extra as { env?: SchemaEnv })?.env || {};
			return bgeeResponse(() => handler(
				args as Record<string, unknown>,
				runtimeEnv as Record<string, unknown>,
				(extra as Record<string, unknown>),
			), runtimeEnv as BgeeDataEnv, name, extra, args);
		},
	);
}
