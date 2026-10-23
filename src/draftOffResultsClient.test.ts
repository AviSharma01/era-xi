import assert from "node:assert/strict";
import test from "node:test";
import { parseDraftOffResults, fetchDraftOffResults } from "./draftOffResultsClient.js";
import { createDraftOffSession } from "./draftOffSession.js";
import { createDraftOffTransport } from "./draftOffClientTransport.js";
import { projectDraftOffRoom } from "./draftOffRoomProjection.js";
import type { SnapshotSuccess } from "./draftOffClientTypes.js";
import { catalog, hostId, memberId, roomCode, resultsBody, resultsResolved, assertResultsAgainstState } from "./draftOffResultsTestSupport.js";

const state = resultsResolved(), body = resultsBody(state);
const plain = () => JSON.parse(JSON.stringify(body));
const noopEvents = { addEventListener() {}, removeEventListener() {} };
const storage = () => { const rows = new Map<string,string>(); return { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key,value); }, removeItem: (key: string) => { rows.delete(key); } }; };
function setup(result: (url: string, init?: RequestInit) => Promise<Response>, transportOptions: { now?: () => number } = {}) {
  let snapshot: SnapshotSuccess = { ok: true, roomCode, participantId: hostId, settings: { draftMinutes: 10 }, serverTimeMs: 100,
    view: projectDraftOffRoom(catalog, state, hostId) };
  let calls = 0;
  const transport = createDraftOffTransport({ ...transportOptions, fetch: async (url, init) => {
    if (String(url).includes("/results/")) { calls++; return result(String(url), init); }
    return Response.json(String(url).endsWith("/socket-tickets") ? { ok: true, ticket: "T".repeat(43), expiresAtMs: Date.now()+30000 } : snapshot);
  } });
  const client = createDraftOffSession({ apiOrigin: "https://api.test", roomCode, credential: { participantId: hostId, reconnectCredential: "A".repeat(43) },
    journalStorage: storage(), transport, onChange() {}, realtime: { events: noopEvents, createSocket: () => ({ protocol: "draft-off.v1", close() {} }) as unknown as WebSocket } });
  return { client, calls: () => calls, setSnapshot: (value: SnapshotSuccess) => { snapshot=value; }, snapshot: () => snapshot };
}

test("strict results parser rejects extra nested fields, invalid values, omissions and identity mismatches", () => {
  assert.deepEqual(parseDraftOffResults(plain(), body), body);
  const changes: Array<(value: any) => void> = [
    v => { v.roomRevision=99; }, v => { v.players[0].internalScore=90; },
    v => { v.players[0].historicalStats.currentSeason.batting.secret="x"; },
    v => { v.evaluation.construction.rawCapacity=5; }, v => { v.campaign.aggregate.seed="hidden"; },
    v => { v.campaign.matches[0].opponent.xi=[]; }, v => { v.campaign.matches[0].firstInnings.teamId="user"; },
    v => { delete v.players[0].battingRating; }, v => { v.players.pop(); }, v => { v.campaign.matches.pop(); },
    v => { v.players.reverse(); }, v => { v.players[0].rosterStatus="UNKNOWN"; },
    v => { v.players[0].playerId=v.players[1].playerId; }, v => { v.players[0].battingRating=Infinity; },
    v => { v.players[0].bowlingRating=0; }, v => { v.evaluation.strength.overall=NaN; },
    v => { v.evaluation.fitCounts.UNKNOWN++; }, v => { v.evaluation.tierCounts.S++; },
    v => { v.campaign.matches[1].sequence=1; }, v => { v.campaign.matches[1].matchId=v.campaign.matches[0].matchId; },
    v => { v.campaign.matches[0].firstInnings.side=v.campaign.matches[0].secondInnings.side; },
    v => { v.campaign.matches[0].firstInnings.allOut=!v.campaign.matches[0].firstInnings.allOut; },
    v => { v.campaign.matches[0].resultType="tie"; }, v => { v.campaign.matches[0].margin=null; },
    v => { v.campaign.aggregate.netRunRate=Infinity; }, v => { v.displayName="😀".repeat(65); },
    v => { v.players[0].historicalStats.eraBest.batting=[]; },
  ];
  for (const mutate of changes) { const value=plain(); mutate(value); assert.throws(() => parseDraftOffResults(value, body), /INVALID_RESULTS_RESPONSE/); }
  for (const field of ["roomCode", "roundId", "participantId", "roundOrdinal", "eraId"] as const) {
    assert.throws(() => parseDraftOffResults(plain(), { ...body, [field]: "wrong" }), /INVALID_RESULTS_RESPONSE/);
  }
});

test("null ratings/statistics and regulation ties preserve the approved wire semantics", () => {
  const value=plain(); value.players[0].battingRating=null; value.players[0].bowlingRating=null;
  value.players[0].historicalStats.currentSeason.batting.average=null;
  value.players[0].historicalStats.eraBest={ batting:null, bowling:null };
  const m=value.campaign.matches[0]; m.resultType="super_over"; m.margin=null; m.firstInnings.runs=100; m.secondInnings.runs=100;
  assert.equal(parseDraftOffResults(value, body).campaign.matches[0]!.margin, null);
  const bad=JSON.parse(JSON.stringify(value)); bad.campaign.matches[0].margin=0;
  assert.throws(() => parseDraftOffResults(bad, body), /INVALID_RESULTS_RESPONSE/);
});

test("session results are lazy, deduplicated, cached and matched to authoritative leaderboard without a revision field", async () => {
  let release!: (value: Response) => void;
  const fixture=setup(async (url, init) => {
    assert.ok(url.endsWith(`/results/${hostId}`)); assert.equal(init!.headers && new Headers(init!.headers).get("Authorization"), `Bearer ${"A".repeat(43)}`);
    assert.equal(init!.credentials, "omit"); assert.equal(init!.cache,"no-store"); assert.equal(init!.body,undefined);
    return new Promise(resolve => { release=resolve; });
  });
  try {
    await fixture.client.start(); assert.equal(fixture.calls(),0);
    const first=fixture.client.loadResults(hostId), second=fixture.client.loadResults(hostId);
    assert.equal(first,second); assert.equal(fixture.calls(),1); release(Response.json(body));
    assert.deepEqual(await first,body); await fixture.client.loadResults(hostId); assert.equal(fixture.calls(),1);
    assert.ok(!Object.hasOwn(await second,"roomRevision"));
    const previous=fixture.snapshot(); fixture.setSnapshot({ ...previous, view: { ...previous.view, revision: previous.view.revision+1 } });
    await fixture.client.resync(); await fixture.client.loadResults(hostId); assert.equal(fixture.calls(),1);
  } finally { fixture.client.stop(); }
  await assert.rejects(fixture.client.loadResults(hostId), /AUTHENTICATION_FAILED/);
});

test("selected and cached responses belong to distinct authoritative submissions/campaigns", async () => {
  const requested: string[] = [];
  const fixture = setup(async url => {
    const targetId = url.split("/").at(-1)!; requested.push(targetId);
    return Response.json(resultsBody(state, hostId, targetId));
  });
  try {
    await fixture.client.start();
    for (const targetId of [hostId, memberId, hostId, memberId]) {
      assertResultsAgainstState(await fixture.client.loadResults(targetId), state, targetId);
    }
    assert.deepEqual(requested, [hostId, memberId]);
  } finally { fixture.client.stop(); }
  const wrong = structuredClone(body);
  Object.assign(wrong, { participantId: memberId, displayName: state.participants.find(p => p.participantId === memberId)!.displayName });
  parseDraftOffResults(wrong, { ...body, participantId: memberId }); // Shape/identity alone cannot catch the wrong campaign.
  const swapped = setup(async () => Response.json(wrong));
  try { await swapped.client.start(); await assert.rejects(swapped.client.loadResults(memberId), /INVALID_RESULTS_RESPONSE/); }
  finally { swapped.client.stop(); }
});

test("session rejects stale, unverified and post-stop replies and preserves command journal independence", async () => {
  for (const mutate of [(v:any) => { v.roundId="other"; }, (v:any) => { v.participantId=memberId; }, (v:any) => { v.campaign.aggregate.netRunRate+=1; }]) {
    const value=plain(); mutate(value); const fixture=setup(async () => Response.json(value));
    try { await fixture.client.start(); await assert.rejects(fixture.client.loadResults(hostId), /INVALID_RESULTS_RESPONSE/); assert.equal(fixture.client.getState().pending,false); }
    finally { fixture.client.stop(); }
  }
  let release!: (reply: Response) => void;
  const fixture=setup(async () => new Promise(resolve => { release=resolve; }));
  await fixture.client.start(); const pending=fixture.client.loadResults(hostId);
  const rejected=assert.rejects(pending); fixture.client.stop(); release(Response.json(body)); await rejected;
});

test("results 401 removes access, 409 resyncs, and 429 shares cooldown with room reads", async () => {
  for (const [status, code] of [[401,"AUTHENTICATION_FAILED"],[404,"RESULT_UNAVAILABLE"],[409,"RESULTS_NOT_READY"],[503,"TEMPORARY_UNAVAILABLE"]] as const) {
    const fixture=setup(async () => Response.json({ ok:false,error:{code,message:"Request rejected."} },{status}));
    try { await fixture.client.start(); await assert.rejects(fixture.client.loadResults(hostId), new RegExp(code));
      assert.equal(fixture.client.getState().accessUnavailable,status===401);
    } finally { fixture.client.stop(); }
  }
  let now=1000;
  const fixture=setup(async () => Response.json({ok:false,error:{code:"RATE_LIMITED",message:"Request limit reached."}},{status:429,headers:{"Retry-After":"2"}}), { now:()=>now });
  try { await fixture.client.start(); await assert.rejects(fixture.client.loadResults(hostId),/RATE_LIMITED/);
    assert.equal(fixture.client.resultsRetryAtMs(),3000); await assert.rejects(fixture.client.loadResults(memberId),/COOLDOWN/);
    assert.equal(fixture.calls(),1); now=3000; await assert.rejects(fixture.client.loadResults(hostId),/RATE_LIMITED/); assert.equal(fixture.calls(),2);
  } finally { fixture.client.stop(); }
});

test("results requests retain existing declared/streamed body bounds and cancellation", async () => {
  for (const send of [async () => new Response("x",{headers:{"Content-Length":"200"}}), async () => new Response("x".repeat(200))]) {
    const transport=createDraftOffTransport({maxBytes:100,fetch:send});
    try { await assert.rejects(fetchDraftOffResults({apiOrigin:"https://api.test",identity:body,credential:"A".repeat(43),transport:transport.fetch}),/SIZE|TOO_LARGE/); }
    finally { transport.stop(); }
  }
  const fixture=setup(async () => new Promise(() => {}));
  try { await fixture.client.start(); const cancel=new AbortController(); const pending=fixture.client.loadResults(hostId,cancel.signal); cancel.abort(); await assert.rejects(pending,/ABORTED/); }
  finally { fixture.client.stop(); }
});
