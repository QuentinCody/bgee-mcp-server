import type { McpServer } from "@bio-mcp/shared/mcp";
import { createQueryDataHandler } from "@bio-mcp/shared/staging/utils";
import { z } from "zod";
import { type BgeeDataEnv, bgeeResponse } from "../lib/tool-result";

interface QueryEnv {
	BGEE_DATA_DO?: unknown;
}

export function registerQueryData(server: McpServer, env?: QueryEnv): void {
	const handler = createQueryDataHandler("BGEE_DATA_DO", "bgee");

	for (const name of ["bgee_query_data", "mcp_bgee_query_data"]) server.registerTool(
		name,
		{
			title: "Query Staged Bgee Results",
			description:
				"Query staged Bgee SPARQL or bulk discovery/manifest results using SQL and the returned data_access_id. Imported expression-call files live in the separately created local SQLite snapshot.",
			inputSchema: {
				data_access_id: z.string().min(1).describe("Data access ID for the staged dataset"),
				sql: z.string().min(1).describe("SQL query to execute against the staged data"),
				limit: z
					.number()
					.int()
					.positive()
					.max(10_000)
					.optional()
					.describe("Maximum number of rows to return (default: 100)"),
			},
		},
		async (args, extra) => {
			const runtimeEnv = env || (extra as { env?: QueryEnv })?.env || {};
			return bgeeResponse(() => handler(args as Record<string, unknown>, runtimeEnv as Record<string, unknown>), runtimeEnv as BgeeDataEnv, name, extra, args);
		},
	);
}
