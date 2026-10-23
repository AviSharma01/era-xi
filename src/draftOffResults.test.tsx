import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { DraftOffRoomExperience, type DraftOffRoomActions } from "./draftOffRoom.js";
import { ResultsClientError } from "./draftOffResultsClient.js";
import type { ResultsLoader } from "./draftOffResults.js";
import type { ResultsSuccess } from "./draftOffResultsTypes.js";
import { projectDraftOffRoom } from "./draftOffRoomProjection.js";
import { catalog, hostId, memberId, leftId, roomCode, resultsBody, resultsResolved, assertResultsAgainstState } from "./draftOffResultsTestSupport.js";
import type { DraftOffSessionState } from "./draftOffSession.js";
import { createDraftOffTransport } from "./draftOffClientTransport.js";
import { participant } from "./draftOffRoomTestSupport.js";
import { restoreDraftOffCompetition, serializeDraftOffCompetition } from "./draftOffCompetitionPersistence.js";
import { DraftOffRoomService } from "./draftOffRoomService.js";
import { InMemoryDraftOffRoomRepository } from "./draftOffRoomRepository.js";
import { ManualDraftOffClock } from "./draftOffRoomTestSupport.js";

function session(domain = resultsResolved(), viewer = hostId): DraftOffSessionState {
  return { pending:false,error:null,accessUnavailable:false,snapshot:{ok:true,roomCode,participantId:viewer,settings:{draftMinutes:10},serverTimeMs:100,
    view:projectDraftOffRoom(catalog,domain,viewer)} };
}
async function mount(initial: DraftOffSessionState, loader: ResultsLoader, retryAt = () => 0, subscribeCooldown?: (listener: () => void) => () => void) {
  const dom = new JSDOM('<div id="root"></div>', {url:"http://127.0.0.1:5173"});
  const keys=["window","document","HTMLElement","requestAnimationFrame","IS_REACT_ACT_ENVIRONMENT"];
  const previous=Object.fromEntries(keys.map(key=>[key,(globalThis as Record<string,unknown>)[key]]));
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open","");};
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,
    requestAnimationFrame:(fn:FrameRequestCallback)=>{fn(0);return 1;},IS_REACT_ACT_ENVIRONMENT:true});
  const root=createRoot(dom.window.document.getElementById("root")!);
  const actions:DraftOffRoomActions={command:async()=>{},retry:async()=>{},resync:async()=>{},loadResults:loader,resultsRetryAtMs:retryAt,subscribeResultsCooldown:subscribeCooldown};
  const render=async(state=initial, loadResults=loader)=>{await act(async()=>root.render(<DraftOffRoomExperience code={roomCode} state={state} actions={{...actions,loadResults}}/>));};
  await render();
  return {document:dom.window.document,render,
    async click(selector:string){const node=dom.window.document.querySelector<HTMLButtonElement>(selector);assert.ok(node,selector);await act(async()=>node.click());},
    async close(){await act(async()=>root.unmount());Object.assign(globalThis,previous);dom.window.close();}};
}

test("results screen retains leaderboard, lazily loads own XI, inspection, assessment and twenty fixtures", async()=>{
  const domain=resultsResolved(), calls:string[]=[];
  let release!:(value:ResultsSuccess)=>void;
  const ui=await mount(session(domain),async(id)=>{calls.push(id);return new Promise(resolve=>{release=resolve;});});
  try {
    assert.deepEqual(calls,[hostId]); assert.match(ui.document.body.textContent!,/Loading Results host/);
    assert.equal(ui.document.querySelectorAll(".room-results tbody tr").length,2);
    await act(async()=>release(resultsBody(domain)));
    assert.equal(ui.document.querySelectorAll(".room-revealed-player").length,11);
    assert.equal(ui.document.querySelectorAll(".room-campaign-matches > li").length,20);
    assert.match(ui.document.body.textContent!,/Team assessment|Bowling balance|overseas/);
    assert.equal(ui.document.querySelectorAll(".room-campaign .innings-row").length,40);
    await ui.click(".room-result-player-name"); assert.ok(ui.document.querySelector(".player-inspector[open]"));
    assert.match(ui.document.querySelector(".player-inspector")!.textContent!,/Player details · Slot 01/);
    await ui.click(".player-inspector button");
    const newer=structuredClone(session(domain)); Object.assign(newer.snapshot!.view,{revision:domain.revision+1});
    await ui.render(newer); assert.equal(calls.length,1);
    await ui.click(`[aria-label="View Results member results"]`);
    assert.deepEqual(calls,[hostId,memberId]); assert.equal(ui.document.querySelectorAll(".room-revealed-player").length,0);
    await act(async()=>release(resultsBody(domain,hostId,memberId)));
    assert.match(ui.document.querySelector("#participant-results-title")!.textContent!,/Results member/);
    const expectedPicks = [...participant(domain, memberId).draftState.picks].sort((a,b) => a.battingPosition-b.battingPosition);
    assert.deepEqual([...ui.document.querySelectorAll(".room-result-player-name strong")].map(node => node.textContent),
      expectedPicks.map(pick => catalog.getPlayer(pick.playerTeamSeasonId)!.canonicalDisplayName));
    const round = domain.rounds[0]!;
    assert.equal(round.phase, "RESOLVED"); if (round.phase !== "RESOLVED") return;
    const campaign = round.resolution.challengeResult!.campaigns.find(c => c.participantId === memberId)!;
    assert.match(ui.document.querySelector(".room-campaign-summary")!.textContent!, new RegExp(`${campaign.aggregate.won}–${campaign.aggregate.lost}`));
  }finally{await ui.close();}
});

test("incomplete locked entrants browse eligible entries; LEFT and no-contest viewers fetch nothing",async()=>{
  for(const [eligible,viewer,expected] of [[1,memberId,1],[1,leftId,0],[0,hostId,0]] as const){
    const domain=resultsResolved(eligible);let calls=0;
    const ui=await mount(session(domain,viewer),async(id)=>{calls++;return resultsBody(domain,viewer,id);});
    try{assert.equal(calls,expected);assert.equal(ui.document.querySelectorAll(".room-revealed-player").length,expected*11);
      if(viewer===memberId)assert.match(ui.document.body.textContent!,/incomplete at the deadline/);
      if(!expected)assert.equal(ui.document.querySelectorAll(".room-view-results").length,0);
    }finally{await ui.close();}
  }
});

test("selection changes abort obsolete requests and ignore late private results; auth failure clears details",async()=>{
  const domain=resultsResolved(), pending=new Map<string,{signal:AbortSignal;finish:(value:ResultsSuccess)=>void}>();
  const ui=await mount(session(domain),async(id,signal)=>new Promise(resolve=>pending.set(id,{signal:signal!,finish:resolve})));
  try{
    await ui.click(`[aria-label="View Results member results"]`);assert.equal(pending.get(hostId)!.signal.aborted,true);
    await act(async()=>pending.get(hostId)!.finish(resultsBody(domain)));assert.equal(ui.document.querySelectorAll(".room-revealed-player").length,0);
    await act(async()=>pending.get(memberId)!.finish(resultsBody(domain,hostId,memberId)));assert.equal(ui.document.querySelectorAll(".room-revealed-player").length,11);
    await ui.render({...session(domain),accessUnavailable:true,error:"Room access unavailable"});
    assert.equal(ui.document.querySelector("#participant-results"),null);assert.equal(pending.get(memberId)!.signal.aborted,true);
  }finally{await ui.close();}
});

test("new session loader hides old details and stale responses without adding a revision field",async()=>{
  const domain=resultsResolved();const ui=await mount(session(domain),async()=>resultsBody(domain));
  let release!:(value:ResultsSuccess)=>void;
  try{
    assert.equal(ui.document.querySelectorAll(".room-revealed-player").length,11);
    const next:ResultsLoader=async()=>new Promise(resolve=>{release=resolve;});
    await ui.render(session(domain),next);assert.equal(ui.document.querySelectorAll(".room-revealed-player").length,0);
    const bad=structuredClone(resultsBody(domain));Object.assign(bad,{roundId:"other-round"});
    await act(async()=>release(bad));assert.match(ui.document.body.textContent!,/could not be verified/);
  }finally{await ui.close();}
});

test("results failures retain leaderboard and expose retry; shared cooldown disables retry",async()=>{
  for(const code of ["RESULT_UNAVAILABLE","RESULTS_NOT_READY","TEMPORARY_UNAVAILABLE","INVALID_RESULTS_RESPONSE","RATE_LIMITED"]){
    let fail=true;const domain=resultsResolved();
    const deadline=Date.now()+60000;
    const ui=await mount(session(domain),async()=>{if(fail)throw new ResultsClientError(code);return resultsBody(domain);},()=>code==="RATE_LIMITED"?deadline:0);
    try{
      assert.equal(ui.document.querySelectorAll(".room-results tbody tr").length,2);assert.ok(ui.document.querySelector("#participant-results [role=alert]"));
      const retry=ui.document.querySelector<HTMLButtonElement>("#participant-results .secondary-action")!;
      assert.equal(retry.disabled,code==="RATE_LIMITED");
      if(!retry.disabled){fail=false;await ui.click("#participant-results .secondary-action");assert.equal(ui.document.querySelectorAll(".room-revealed-player").length,11);}
    }finally{await ui.close();}
  }
});

test("results retry observes another request's shared cooldown introduction, extension and exact expiry", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const replies: Array<(reply: Response) => void> = [];
  const transport = createDraftOffTransport({ fetch: async () => new Promise(resolve => replies.push(resolve)) });
  const domain = resultsResolved(); let fail = true, loads = 0;
  const ui = await mount(session(domain), async () => { loads++; if (fail) throw new Error("offline"); return resultsBody(domain); },
    transport.cooldownUntil, transport.subscribeCooldown);
  const retry = () => ui.document.querySelector<HTMLButtonElement>("#participant-results .secondary-action")!;
  try {
    assert.equal(retry().disabled, false); // The original results failure had no cooldown.
    const roomRead = transport.fetch("https://api.test/rooms/one");
    const inFlightRead = transport.fetch("https://api.test/rooms/two");
    await act(async () => { replies[0]!(Response.json({}, { status: 429, headers: { "Retry-After": "2" } })); await roomRead; });
    assert.equal(transport.cooldownUntil(), 3000);
    assert.equal(retry().textContent, "Retry in 2s"); assert.equal(retry().disabled, true);
    await act(async () => t.mock.timers.tick(1000));
    await act(async () => { replies[1]!(Response.json({}, { status: 429, headers: { "Retry-After": "4" } })); await inFlightRead; });
    assert.equal(transport.cooldownUntil(), 6000);
    assert.equal(retry().textContent, "Retry in 4s");
    await act(async () => t.mock.timers.tick(1000)); // Original deadline must not unlock retry.
    assert.equal(retry().disabled, true);
    await act(async () => t.mock.timers.tick(2999));
    assert.equal(retry().disabled, true);
    await act(async () => t.mock.timers.tick(1)); // No rerender/user action supplied by the test.
    assert.equal(Date.now(), 6000); assert.equal(retry().disabled, false); assert.equal(retry().textContent, "Retry results");
    assert.equal(loads, 1); // The clock never polls results or retries automatically.
    fail = false; await ui.click("#participant-results .secondary-action");
    assert.equal(loads, 2); assert.equal(ui.document.querySelectorAll(".room-revealed-player").length, 11);
  } finally { await ui.close(); transport.stop(); t.mock.timers.reset(); }
});

test("canonical restoration → results projection → presentation preserves Super Over wins and losses", async () => {
  // Fixed seed discovered once; no search, injected scores or canonical fixture edits at test runtime.
  const original = resultsResolved(2, "era-transition", "m53-super-over-50");
  const serialized = serializeDraftOffCompetition(original);
  const restored = restoreDraftOffCompetition(catalog, serialized);
  const repository = new InMemoryDraftOffRoomRepository();
  await repository.create(roomCode, { serializedCompetition: serialized, receipts: {} });
  const service = new DraftOffRoomService(catalog, repository, new ManualDraftOffClock());
  const loaded = new Map<string, ResultsSuccess>();
  const ui = await mount(session(restored), async targetId => {
    const body: ResultsSuccess = { ok: true, version: 1, roomCode,
      ...await service.readResults({ kind: "PARTICIPANT", participantId: hostId }, roomCode, targetId) };
    assertResultsAgainstState(body, original, targetId); loaded.set(targetId, body); return body;
  });
  try {
    for (const [targetId, sequence, outcome, scores] of [
      [hostId, 3, "WIN", ["169/4", "169/6"]], [memberId, 1, "LOSS", ["129/5", "129/5"]],
    ] as const) {
      if (targetId === memberId) await ui.click('[aria-label="View Results member results"]');
      const body = loaded.get(targetId)!, match = body.campaign.matches[sequence - 1]!;
      assert.equal(match.resultType, "super_over"); assert.equal(match.margin, null); assert.equal(match.outcome, outcome);
      assert.equal(match.firstInnings.runs, match.secondInnings.runs);
      assert.deepEqual([match.firstInnings.balls, match.secondInnings.balls], [120, 120]);
      const card = ui.document.querySelectorAll(".room-campaign-matches > li")[sequence - 1]!;
      assert.ok(card.querySelector(`.match-result-${outcome.toLowerCase()}`));
      assert.equal(card.querySelectorAll(".innings-row").length, 2);
      assert.deepEqual([...card.querySelectorAll(".innings-row b")].map(node => node.textContent), scores);
      const winner = outcome === "WIN" ? original.participants.find(p => p.participantId === targetId)!.displayName
        : `${match.opponent.teamName} ${match.opponent.seasonYear}`;
      assert.equal(card.querySelector(".match-verdict")!.textContent, `${winner} won the Super Over`);
      assert.doesNotMatch(card.textContent!, /won by|null/);
    }
  } finally { await ui.close(); service.dispose(); }
});
