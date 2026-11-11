import {afterEach, expect, it, vi} from "vitest";
import {BGEE_ARCHIVE, BGEE_SPARQL_ENDPOINT, routeBgeeQuery} from "./query-routing";
import {createBgeeSparqlFetch} from "./sparql";

const archiveQuery = `SELECT ?gene FROM <${BGEE_ARCHIVE.graph}> WHERE {?gene ?p ?o} LIMIT 2`;
const native = {head: {vars: ["gene", "label"]}, results: {bindings: [{gene: {type: "uri", value: "https://example.org/gene"}, label: {type: "literal", "xml:lang": "fr", value: "gène"}}]}};
const json = (data: unknown) => new Response(JSON.stringify(data), {headers: {"content-type": "application/sparql-results+json"}});
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();});

it.each(["GET", "POST"] as const)("routes %s archive requests without changing query bytes or RDF terms", async method => {
  const fetcher = vi.fn().mockResolvedValue(json(native)); vi.stubGlobal("fetch", fetcher);
  const result = await createBgeeSparqlFetch()(archiveQuery, {method});
  const [url, init] = fetcher.mock.calls[0];
  expect(new URL(String(url)).origin + new URL(String(url)).pathname).toBe(BGEE_ARCHIVE.endpoint);
  const sent = method === "GET" ? new URL(String(url)).searchParams : init.body as URLSearchParams;
  expect(sent.get("query")).toBe(archiveQuery);
  expect(init).toMatchObject({method, redirect: "manual"});
  expect(init.headers.Accept).toBe("application/sparql-results+json");
  expect(result).toMatchObject({...native, _bgee: {endpoint: BGEE_ARCHIVE.endpoint, requested_release: "15.1", graph: BGEE_ARCHIVE.graph, observed_release: null, snapshot_verified: false}});
});

it.each([
  'SELECT ?from WHERE {?from ?p ?o} LIMIT 1',
  'PREFIX : <https://example.org/> SELECT ?s WHERE {?s :FROM :GRAPH} LIMIT 1',
  'PREFIX ex: <http://example.org/FROM#GRAPH> SELECT ?s WHERE {?s ex:GRAPH "FROM <https://bgee.org/rdf_v15_1>"} LIMIT 1',
  "SELECT ?s WHERE {?s ?p '''FROM <https://bgee.org/rdf_v15_1> GRAPH'''} LIMIT 1",
  'SELECT ?s WHERE {?s ?p """GRAPH\\" FROM"""} LIMIT 1',
  "# FROM <https://bgee.org/rdf_v15_1>\nASK {?s ?p ?o}",
  "SELECT ?s WHERE {?s ?p ?o FILTER(?o < 3)} LIMIT 1",
])("keeps latest routing when dataset keywords occur only in data: %s", query => {
  expect(routeBgeeQuery(query)).toEqual({endpoint: BGEE_SPARQL_ENDPOINT, requested_release: null, graph: null});
});

it("recognizes lowercase FROM separated from its IRI by comments", () => {
  expect(routeBgeeQuery(`SELECT ?s from # archive\n <${BGEE_ARCHIVE.graph}> {?s ?p ?o} LIMIT 1`).endpoint).toBe(BGEE_ARCHIVE.endpoint);
});

it.each([
  "SELECT ?s FROM <https://bgee.org/rdf_v16> {?s ?p ?o}",
  `SELECT ?s FROM NAMED <${BGEE_ARCHIVE.graph}> {GRAPH ?g {?s ?p ?o}}`,
  `${archiveQuery} FROM <https://example.org/graph>`,
  "PREFIX archive: <https://bgee.org/> SELECT ?s FROM archive:rdf_v15_1 {?s ?p ?o}",
  "SELECT ?s { GRAPH ?g {?s ?p ?o}}",
  'DEFINE input:default-graph-uri <https://bgee.org/rdf_v15_1> SELECT ?s {?s ?p ?o}',
  "SELECT ?s \\u0046ROM <https://bgee.org/rdf_v15_1> {?s ?p ?o}",
  "", "α".repeat(65537),
])("rejects unsupported/ambiguous dataset selection before fetching %#", async query => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(createBgeeSparqlFetch()(query)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps false ASK results and latest release uncertainty", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({head: {}, boolean: false})));
  expect(await createBgeeSparqlFetch()("ASK {?s ?p ?o}")).toMatchObject({boolean: false, _bgee: {requested_release: null, graph: null}});
});

it.each([302, 404, 429, 500])("reports HTTP %s without following redirects or treating errors as empty results", async status => {
  const fetcher = vi.fn().mockResolvedValue(new Response("upstream detail", {status, headers: {Location: BGEE_SPARQL_ENDPOINT}}));
  vi.stubGlobal("fetch", fetcher);
  await expect(createBgeeSparqlFetch()(archiveQuery)).rejects.toMatchObject({status, message: `HTTP ${status} from Bgee SPARQL`});
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("bounds response bytes and rejects corrupt UTF-8 and invalid JSON", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response("α".repeat(2 * 1024 * 1024 + 1)))
    .mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28])))
    .mockResolvedValueOnce(new Response("bad", {headers: {"content-type": "application/json"}})));
  await expect(createBgeeSparqlFetch()(archiveQuery)).rejects.toThrow("4 MiB");
  await expect(createBgeeSparqlFetch()(archiveQuery)).rejects.toThrow();
  await expect(createBgeeSparqlFetch()(archiveQuery)).rejects.toThrow();
});

it.each([206, 200])("rejects partial HTTP %s responses with the complete native body retained", async status => {
  const raw=JSON.stringify(native);
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(raw,{status,headers:{"Content-Type":"application/json","Content-Range":"bytes 0-9/100"}})));
  await expect(createBgeeSparqlFetch()(archiveQuery)).rejects.toMatchObject({status:502,data:{raw_body:raw,receipt:{http_status:status,requested_release:"15.1"}}});
});

it("retains native error bodies and byte receipts without waiting for cancellation",async()=>{
  const body="native error α".repeat(3000);
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(body,{status:429,headers:{"Retry-After":"7"}})));
  await expect(createBgeeSparqlFetch()(archiveQuery)).rejects.toMatchObject({status:429,data:{raw_body:body,receipt:{bytes:new TextEncoder().encode(body).length,retry_after:"7",response_sha256:expect.stringMatching(/^[a-f0-9]{64}$/)}}});
});

it("times out fetch even if it ignores AbortSignal",async()=>{
  vi.useFakeTimers();vi.stubGlobal("fetch",vi.fn(()=>new Promise(()=>{})));
  const result=createBgeeSparqlFetch()(archiveQuery,{timeoutMs:20});
  const assertion=expect(result).rejects.toMatchObject({status:504,data:{body_unavailable:true,request:{query:archiveQuery}}});
  await vi.advanceTimersByTimeAsync(21);await assertion;
});

it("times out stalled response bodies with nonresolving cancel",async()=>{
  vi.useFakeTimers();const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"head":'));},cancel(){return new Promise(()=>{});}});
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(body,{headers:{"Content-Type":"application/json"}})));
  const result=createBgeeSparqlFetch()(archiveQuery,{timeoutMs:30});const assertion=expect(result).rejects.toMatchObject({data:{body_unavailable:true}});
  await vi.advanceTimersByTimeAsync(31);await assertion;
});

it.each([{head:{},boolean:"false"},{head:{vars:["s"]},results:{bindings:[{s:{type:"uri",value:3}}]}},{detail:"native error"}])("rejects malformed native result %# without fabricating empty bindings",async payload=>{
  vi.stubGlobal("fetch",vi.fn(async()=>json(payload)));
  await expect(createBgeeSparqlFetch()(archiveQuery)).rejects.toMatchObject({status:502,data:{raw_body:JSON.stringify(payload)}});
});
