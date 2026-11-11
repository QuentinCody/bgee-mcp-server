import { buildCitation, type Completeness, mergeCompleteness } from "@bio-mcp/shared";
import { shouldStage, stageToDoAndRespond } from "@bio-mcp/shared/staging/utils";
import { bgeeCompleteness } from "./completeness";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

type Result = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean; [key: string]: unknown };
export type BgeeDataEnv = { BGEE_DATA_DO?: unknown };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const SDK_RESERVE_BYTES = 1024;
const source = { id: "bgee", name: "Bgee", url: "https://www.bgee.org", license: "CC0 1.0" };

async function cite(structured: Record<string, unknown>, toolName: string, query: unknown) {
  const meta = record(structured._meta) ? structured._meta : {};
  if (record(meta.citation)) return structured;
  const { _meta: _metadata, ...root } = structured;
  const citation = await buildCitation({ source, server: "bgee", tool: toolName.replace(/^mcp_/, ""), query,
    queryScope: "tool_arguments", result: root, resultScope: "structured_content:root_without_meta", retrievedAt: new Date().toISOString() });
  return { ...structured, _meta: { ...meta, citation } };
}

export async function bgeeResponse(work: () => Promise<Result>, env: BgeeDataEnv, toolName: string, extra: unknown, query: unknown = {}): Promise<Result> {
  try {
    const original: Result = await work().catch(error => {
      return requestFailure(error);
    });
    let structured = original.structuredContent ?? { success: original.isError !== true };
    const meta = record(structured._meta) ? structured._meta : {};
    const existing: Completeness | undefined = record(meta.completeness) && typeof meta.completeness.complete === "boolean"
      ? { ...meta.completeness, complete: meta.completeness.complete } : undefined;
    const completeness = mergeCompleteness(existing, toolName.endsWith("bgee_execute") ? bgeeCompleteness() : undefined);
    if (completeness) structured = { ...structured, _meta: { ...meta, completeness },
      ...(record(structured._staging) ? { _staging: { ...structured._staging, completeness } } : {}) };
    const apiError = structured.data && typeof structured.data === "object" && "__api_error" in structured.data && structured.data.__api_error === true;
    const failed = original.isError === true || structured.success === false || apiError || Boolean(structured.program_error) || structured.disposition === "partial";
    const result = { ...original, structuredContent: await cite(failed ? { ...structured, success: false } : structured, toolName, query), ...(failed ? { isError: true } : {}) };
    if (!shouldStage(bytes(result) + SDK_RESERVE_BYTES)) return result;
    return await stageResponse(env, result, toolName, extra, query, completeness, failed);
  } catch {
    const message = "Bgee response could not be returned.";
    const data = { success: false, error: { code: "RESPONSE_ERROR", message } };
    const citation = await buildCitation({ source, server: "bgee", tool: toolName.replace(/^mcp_/, ""),
      query, queryScope: "tool_arguments", retrievedAt: new Date().toISOString(), result: data, resultScope: "structured_content:root_without_meta" });
    return { content: [{ type: "text", text: message }], structuredContent: { ...data, _meta: { citation } }, isError: true };
  }
}

function requestFailure(error: unknown) : Result {
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  const message = error instanceof Error ? error.message.slice(0, 500) : "Bgee request failed.";
  return {
    content: [{ type: "text" as const, text: message }], isError: true,
    structuredContent: {
      success: false, error: { code: status ? "API_ERROR" : "RESPONSE_ERROR", message, status },
      ...(error && typeof error === "object" && "data" in error ? { data: error.data } : {})
    }
  };
}

async function stageResponse(env: BgeeDataEnv, result: Result, toolName: string, extra: unknown, query: unknown, completeness: Completeness | undefined, failed: unknown) : Promise<Result> {
  if (!env.BGEE_DATA_DO) throw new Error("Missing staging storage");
  const staged = await stageToDoAndRespond(result, env.BGEE_DATA_DO as Parameters<typeof stageToDoAndRespond>[1], "bgee", undefined,
    { toolName, serverName: "bgee" }, "bgee", extra as Parameters<typeof stageToDoAndRespond>[6]);
  const citation = await buildCitation({
    source, server: "bgee", tool: toolName.replace(/^mcp_/, ""),
    query, queryScope: "tool_arguments", retrievedAt: new Date().toISOString(), result, resultScope: "staged:full_result", dataAccessId: staged.dataAccessId
  });
  const combined = mergeCompleteness(completeness, staged._staging.completeness);
  const structuredContent = {
    success: !failed, staged: true, data: undefined, data_access_id: staged.dataAccessId,
    _staging: { ...staged._staging, ...(combined ? { completeness: combined } : {}) }, _meta: { citation, ...(combined ? { completeness: combined } : {}) }
  };
  if (bytes(structuredContent) > 100000) throw new Error("Staging metadata exceeds transport limit");
  const response = { content: [{ type: "text" as const, text: "Response staged. Use bgee_query_data; payloads retains the complete original response." }], structuredContent, ...(failed ? { isError: true } : {}) };
  if (shouldStage(bytes(response) + SDK_RESERVE_BYTES)) throw new Error("Staging metadata exceeds inline limit");
  return response;
}
