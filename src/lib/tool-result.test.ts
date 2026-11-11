import {verifyCitationEnvelope} from "@bio-mcp/shared";
import {beforeEach, expect, it, vi} from "vitest";
import {bgeeResponse} from "./tool-result";

const stage = vi.hoisted(() => vi.fn());
vi.mock("@bio-mcp/shared/staging/utils", () => ({shouldStage: (bytes: number) => bytes > 30 * 1024, stageToDoAndRespond: stage}));
beforeEach(() => { stage.mockReset().mockResolvedValue({dataAccessId: "fixture", _staging: {data_access_id: "fixture", tables_created: ["payloads"], total_rows: 1}}); });
const response = (text: string, failed = false) => ({content: [{type: "text" as const, text}], structuredContent: {success: !failed, data: {text}}});
it("preserves small complete responses and makes structured failures explicit", async () => {
  const small = response("small");
  const result=await bgeeResponse(async () => small, {}, "sql", {},{sql:"SELECT 1"});
  expect(result).toMatchObject(small);
  const proof=await verifyCitationEnvelope({citation:(result.structuredContent!._meta as any).citation,structuredContent:result.structuredContent,toolArguments:{sql:"SELECT 1"}});
  expect(proof.verification).toMatchObject({query:"verified",result:"verified"});
  expect(await bgeeResponse(async () => response("failure", true), {}, "sql", {})).toMatchObject({...response("failure", true), isError: true});
  expect(stage).not.toHaveBeenCalled();
});
it.each([false, true])("stages the whole multibyte response with error status %s and request scope", async failed => {
  const original = response("α".repeat(20000), failed);
  const env = {BGEE_DATA_DO: {} as DurableObjectNamespace};
  const scope = {sessionId: "test"};
  const result = await bgeeResponse(async () => original, env, "sql", scope);
  expect(stage.mock.calls[0][0]).toMatchObject({...original, ...(failed ? {isError: true} : {})});
  expect(stage.mock.calls[0][6]).toBe(scope);
  expect(result.structuredContent).toMatchObject({success: !failed, staged: true, data_access_id: "fixture",
    _staging: {data_access_id: "fixture", tables_created: ["payloads"], total_rows: 1}});
  const proof=await verifyCitationEnvelope({citation:(result.structuredContent!._meta as any).citation,structuredContent:result.structuredContent,toolArguments:{},materialized:{value:stage.mock.calls[0][0]}});
  expect(proof.verification).toMatchObject({query:"verified",result:"verified"});
  expect(result.isError === true).toBe(failed);
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(30000);
});
it("returns a bounded error if execution or staging fails", async () => {
  const failed = await bgeeResponse(async () => {throw new Error("native failure");}, {}, "sql", {});
  expect(failed).toMatchObject({structuredContent: {success: false, error: {code: "RESPONSE_ERROR", message: "native failure"}}, isError: true});
  stage.mockRejectedValue(new Error("private staging detail"));
  expect(await bgeeResponse(async () => response("x".repeat(40000)), {BGEE_DATA_DO: {} as DurableObjectNamespace}, "sql", {})).toMatchObject({isError:true,structuredContent:{success:false,error:{code:"RESPONSE_ERROR",message:"Bgee response could not be returned."},_meta:{citation:{result_hash:expect.any(String)}}}});
});
