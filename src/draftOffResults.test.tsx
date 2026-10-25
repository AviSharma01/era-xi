import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { DraftOffRoomExperience, type DraftOffRoomActions } from "./draftOffRoom.js";
import { ResultsClientError } from "./draftOffResultsClient.js";
import type { DraftOffCampaignResult } from "./draftOffTypes.js";
import type { ResultsLoader } from "./draftOffResults.js";
import type { ResultsSuccess } from "./draftOffResultsTypes.js";
import { projectDraftOffRoom } from "./draftOffRoomProjection.js";
import { catalog, hostId, memberId, leftId, roomCode, resultsBody, resultsLobby, resultsStarted, resultsResolved, assertResultsAgainstState } from "./draftOffResultsTestSupport.js";
import type { DraftOffSessionState } from "./draftOffSession.js";
import { createDraftOffTransport } from "./draftOffClientTransport.js";
import { changed, completeXi, participant } from "./draftOffRoomTestSupport.js";
import { restoreDraftOffCompetition, serializeDraftOffCompetition } from "./draftOffCompetitionPersistence.js";
import { DraftOffRoomService } from "./draftOffRoomService.js";
import { InMemoryDraftOffRoomRepository } from "./draftOffRoomRepository.js";
import { createDraftOffSession } from "./draftOffSession.js";
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
    async choose(label:string, value:string){const select=[...dom.window.document.querySelectorAll("label")].find(node=>node.textContent?.startsWith(label))?.querySelector("select");assert.ok(select,label);await act(async()=>{select.value=value;select.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});},
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
    const campaign: DraftOffCampaignResult = round.resolution.challengeResult!.campaigns.find(c => c.participantId === memberId)!;
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

const compareButton = '[aria-label="Results views"] button:nth-child(2)';
const comparisonRow = (document: Document, section: string, label: string) => [...document.querySelectorAll(`#${section} .room-comparison-row`)].find(row => row.querySelector('h4')?.textContent === label)!;

function assertComparisonIdentity(document: Document, expected: readonly [ResultsSuccess, ResultsSuccess]) {
  for(const [side, body] of expected.entries()) {
    const label=`${side===0?'A':'B'} · ${body.displayName}`;
    for(const section of ['comparison-players','comparison-teams','comparison-campaign']) {
      for(const row of document.querySelectorAll(`#${section} .room-comparison-row`)) {
        assert.equal(row.querySelectorAll('.room-comparison-label')[side]!.textContent,label);
      }
    }
    assert.deepEqual([...document.querySelectorAll('.room-comparison-players > li')].map(row=>row.querySelectorAll('.room-comparison-player strong')[side]!.textContent),body.players.map(player=>player.playerName));
    assert.equal(comparisonRow(document,'comparison-teams','Overall strength').querySelectorAll('.room-comparison-value > strong')[side]!.textContent,body.evaluation.strength.overall.toFixed(1));
    assert.equal(comparisonRow(document,'comparison-campaign','Wins').querySelectorAll('.room-comparison-value > strong')[side]!.textContent,String(body.campaign.aggregate.won));
    assert.equal(document.querySelectorAll('.room-fixture-legend p')[side]!.textContent,label);
    for(const [n,row] of [...document.querySelectorAll('.room-comparison-fixtures > li')].entries()) {
      const match=body.campaign.matches[n];
      assert.equal(row.querySelectorAll('.room-fixture-outcome')[side]!.getAttribute('aria-label'),`${label}: ${match.outcome}${match.resultType==='super_over'?', Super Over':''}`);
      assert.equal(row.querySelectorAll('.room-comparison-match-pair > div > .room-comparison-label')[side]!.textContent,label);
      assert.equal(row.querySelectorAll('.match-outcome')[side]!.textContent,match.outcome);
    }
  }
}

test("two-XI comparison preserves independently derived orders, evaluations, aggregates and all shared fixtures", async () => {
  const domain = resultsResolved(2, "era-transition", "m53-super-over-50");
  const bodies = new Map([hostId, memberId].map(id => [id, resultsBody(domain, hostId, id)]));
  bodies.forEach((body, id) => assertResultsAgainstState(body, domain, id));
  const ui = await mount(session(domain), async id => bodies.get(id)!);
  try {
    await ui.click(compareButton);
    assert.match(ui.document.querySelector('#xi-comparison')!.textContent!, /independently faced|did not play each other/);
    assertComparisonIdentity(ui.document,[bodies.get(hostId)!,bodies.get(memberId)!]);
    const players = ui.document.querySelectorAll('.room-comparison-players > li'); assert.equal(players.length, 11);
    const round = domain.rounds[0]!; assert.equal(round.phase, 'RESOLVED'); if (round.phase !== 'RESOLVED') return;
    for (const [i, id] of [hostId, memberId].entries()) {
      const picks = [...participant(domain, id).draftState.picks].sort((a,b) => a.battingPosition-b.battingPosition);
      const campaign: DraftOffCampaignResult = round.resolution.challengeResult!.campaigns.find(c => c.participantId === id)!;
      const rank = round.resolution.leaderboard.find(row => row.participantId === id)!.rank;
      assert.ok(comparisonRow(ui.document,'comparison-campaign','Final rank').querySelectorAll('.room-comparison-value > strong')[i]!.textContent!.startsWith(`Rank ${rank}`));
      for (const [n, row] of [...players].entries()) {
        assert.equal(row.getAttribute('data-position'), String(n+1));
        const cell = row.querySelectorAll('.room-comparison-player')[i]!;
        assert.equal(cell.querySelector('strong')!.textContent, catalog.getPlayer(picks[n].playerTeamSeasonId)!.canonicalDisplayName);
        assert.ok(cell.textContent!.includes(campaign.evaluation.players.find(p => p.position === n+1)!.quality.overall.overallRating.toFixed(1)));
      }
      for (const [label, expected] of [['Overall strength',campaign.evaluation.adjustedStrength.overall],['Batting strength',campaign.evaluation.adjustedStrength.batting],['Bowling strength',campaign.evaluation.adjustedStrength.bowling]] as const) {
        assert.equal(comparisonRow(ui.document, 'comparison-teams', label).querySelectorAll('.room-comparison-value > strong')[i]!.textContent, expected.toFixed(1));
      }
      for (const [label, expected] of [['Wins',campaign.aggregate.won],['Losses',campaign.aggregate.lost],['Points',campaign.aggregate.points]] as const) {
        assert.equal(comparisonRow(ui.document, 'comparison-campaign', label).querySelectorAll('.room-comparison-value > strong')[i]!.textContent, String(expected));
      }
    }
    for(const [i,id] of [hostId,memberId].entries()) {
      const body=bodies.get(id)!, c=body.evaluation.construction;
      const text=(label:string)=>comparisonRow(ui.document,'comparison-teams',label).querySelectorAll('.room-comparison-value')[i]!.textContent!;
      assert.ok(text('Quality mix').includes((['S','A','B','C','D'] as const).map(tier=>`${tier} × ${body.evaluation.tierCounts[tier]}`).join(' · ')));
      assert.ok(text('Bowling balance').includes(`${c.deployedBowlingUnits.toFixed(1)} / ${c.requiredBowlingUnits} units · ${c.frontlineBowlers} frontline · ${c.supportBowlers} support`));
      assert.ok(text('Team construction').includes(`${c.overseasCount} / ${c.overseasLimit} overseas · Wicketkeeper confirmed`));
      const nrr=body.campaign.aggregate.netRunRate;
      assert.equal(comparisonRow(ui.document,'comparison-campaign','Net run rate').querySelectorAll('.room-comparison-value > strong')[i]!.textContent,`${nrr>=0?'+':''}${nrr.toFixed(3)}`);
    }
    const fixtures = ui.document.querySelectorAll('.room-comparison-fixtures > li'); assert.equal(fixtures.length,20);
    assert.ok(new Set(bodies.get(hostId)!.campaign.matches.map(m => m.opponent.profileId)).size < 20);
    for (const [n, row] of [...fixtures].entries()) {
      assert.equal(row.getAttribute('data-sequence'), String(n+1));
      for (const [i, id] of [hostId, memberId].entries()) {
        const expected = bodies.get(id)!.campaign.matches[n], card = row.querySelectorAll('.match-result')[i]!;
        assert.ok(row.querySelector('.room-fixture-summary-title')!.textContent!.includes(`${expected.opponent.teamName} ${expected.opponent.seasonYear}`));
        assert.equal(card.querySelector('.match-outcome')!.textContent,expected.outcome);
        assert.deepEqual([...card.querySelectorAll('.innings-row b')].map(node => node.textContent),[expected.firstInnings,expected.secondInnings].map(inn => `${inn.runs}/${inn.wickets}`));
        assert.deepEqual([...card.querySelectorAll('.innings-row > div small')].map(node => node.textContent),[expected.firstInnings,expected.secondInnings].map(inn => `${Math.floor(inn.balls/6)}.${inn.balls%6} overs${inn.allOut?' · all out':''}`));
        if (expected.resultType === 'super_over') {
          const winner = expected.outcome === 'WIN' ? bodies.get(id)!.displayName : `${expected.opponent.teamName} ${expected.opponent.seasonYear}`;
          assert.equal(card.querySelector('.match-verdict')!.textContent, `${winner} won the Super Over`);
          assert.doesNotMatch(card.textContent!, /won by|null/);
        }
      }
    }
    const inspect = ui.document.querySelector<HTMLButtonElement>('.room-comparison-player button')!;
    inspect.focus(); await act(async () => inspect.click());
    assert.equal(ui.document.activeElement?.getAttribute('aria-label'), 'Close player details');
    await ui.click('.player-inspector button'); assert.equal(ui.document.activeElement, inspect);
    await ui.click('.room-comparison-selectors button');
    assertComparisonIdentity(ui.document,[bodies.get(memberId)!,bodies.get(hostId)!]);
  } finally { await ui.close(); }
});

test("comparison selection uses only eligible entrants, switches a third entry and swaps without duplicate XIs", async () => {
  const thirdId = 'p_'+'4'.repeat(32);
  let domain = changed(resultsLobby(), {type:'JOIN_COMPETITION',participantId:thirdId,displayName:'A very long participant name '.repeat(2),atMs:4});
  const incompleteId = 'p_'+'5'.repeat(32);
  domain = changed(domain,{type:'JOIN_COMPETITION',participantId:incompleteId,displayName:'Incomplete entrant',atMs:5});
  domain = changed(domain,{type:'START_ROUND',actorParticipantId:hostId,roundId:'r1',atMs:10,deadlineAtMs:100});
  for (const id of [hostId,memberId,thirdId]) domain=completeXi(domain,id);
  domain=changed(domain,{type:'FINALIZE_ROUND',roundId:'r1',atMs:100});
  const calls:string[]=[];
  const ui=await mount(session(domain,incompleteId),async id=>{calls.push(id);return resultsBody(domain,incompleteId,id);});
  try {
    assert.match(ui.document.body.textContent!,/Your XI was incomplete/);
    await ui.click(compareButton);
    assert.equal(ui.document.querySelectorAll('.room-comparison-selectors select').length,2);
    for(const select of ui.document.querySelectorAll('select')) {
      assert.equal(select.options.length,3);assert.ok(![...select.options].some(o=>o.value===leftId));
      assert.equal([...select.options].filter(o=>o.disabled).length,1);
    }
    await ui.choose('XI B',thirdId);
    assert.equal(ui.document.querySelectorAll<HTMLSelectElement>('select')[1].value,thirdId);
    assert.ok(calls.includes(thirdId));
    assertComparisonIdentity(ui.document,[resultsBody(domain,incompleteId,hostId),resultsBody(domain,incompleteId,thirdId)]);
    const swap=[...ui.document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Swap XIs')!;
    await act(async()=>swap.click());
    assert.deepEqual([...ui.document.querySelectorAll('select')].map(select=>select.value),[thirdId,hostId]);
    assertComparisonIdentity(ui.document,[resultsBody(domain,incompleteId,thirdId),resultsBody(domain,incompleteId,hostId)]);
    assert.match(ui.document.querySelector('#xi-comparison')!.textContent!,/Shared rank/); // identical canonical XIs have exact ties
    await ui.click('[aria-label="Results views"] button:first-child');
    assert.equal(ui.document.querySelector('#xi-comparison'),null);assert.equal(ui.document.querySelectorAll('.room-revealed-player').length,11);
  }finally{await ui.close();}
});

test("comparison reuses the real authenticated session cache across modes and swaps", async () => {
  const domain=resultsResolved(), initial=session(domain), calls:string[]=[];
  const transport=createDraftOffTransport({fetch:async(url)=>{
    if(String(url).includes('/results/')){const id=String(url).split('/').at(-1)!;calls.push(id);return Response.json(resultsBody(domain,hostId,id));}
    return Response.json(String(url).endsWith('/socket-tickets')?{ok:true,ticket:'T'.repeat(43),expiresAtMs:Date.now()+30000}:initial.snapshot);
  }});
  const client=createDraftOffSession({apiOrigin:'https://api.test',roomCode,credential:{participantId:hostId,reconnectCredential:'A'.repeat(43)},
    journalStorage:{getItem:()=>null,setItem(){},removeItem(){}},transport,onChange(){},realtime:{events:{addEventListener(){},removeEventListener(){}},createSocket:()=>({protocol:'draft-off.v1',close(){}}) as unknown as WebSocket}});
  await client.start();const ui=await mount(initial,client.loadResults);
  try{
    await ui.click(compareButton);assert.deepEqual(calls,[hostId,memberId]);
    await ui.click('.room-comparison-selectors button');assert.deepEqual(calls,[hostId,memberId]);
    await ui.click('[aria-label="Results views"] button:first-child');
    await ui.click(compareButton);assert.deepEqual(calls,[hostId,memberId]);
  }finally{await ui.close();client.stop();}
});

test("comparison ignores aborted selection/session replies and clears both XIs and inspection on access loss", async () => {
  const domain=resultsResolved(), pending:Array<{id:string;signal:AbortSignal;finish:(body:ResultsSuccess)=>void}>=[];
  const loader:ResultsLoader=async(id,signal)=>new Promise(resolve=>pending.push({id,signal:signal!,finish:resolve}));
  const ui=await mount(session(domain),loader);
  try{
    await ui.click(compareButton);assert.equal(pending[0].signal.aborted,true);
    await ui.click('.room-comparison-selectors button');
    assert.equal(pending[1].signal.aborted,true);assert.equal(pending[2].signal.aborted,true);
    await act(async()=>{for(const p of pending.slice(0,3))p.finish(resultsBody(domain,hostId,p.id));});
    assert.equal(ui.document.querySelectorAll('.room-comparison-players > li').length,0);
    await act(async()=>{for(const p of pending.slice(3))p.finish(resultsBody(domain,hostId,p.id));});
    assert.equal(ui.document.querySelectorAll('.room-comparison-players > li').length,11);
    await ui.click('.room-comparison-player button');assert.ok(ui.document.querySelector('dialog[open]'));
    await ui.render({...session(domain),accessUnavailable:true});
    assert.equal(ui.document.querySelector('#xi-comparison'),null);assert.equal(ui.document.querySelector('dialog'),null);
    assert.equal(ui.document.querySelectorAll('.room-results tbody tr').length,2);
    assert.ok(pending.every(p=>p.signal.aborted));
  }finally{await ui.close();}
});

test("comparison failures identify the participant, preserve leaderboard and retry only the failed load", async () => {
  const domain=resultsResolved(), calls:string[]=[];let fail=true;
  const ui=await mount(session(domain),async id=>{calls.push(id);if(id===memberId&&fail)throw new Error('offline');return resultsBody(domain,hostId,id);});
  try{
    await ui.click(compareButton);assert.match(ui.document.querySelector('#xi-comparison [role=alert]')!.textContent!,/Results member/);
    assert.equal(ui.document.querySelectorAll('.room-comparison-players > li').length,0);
    assert.equal(ui.document.querySelectorAll('.room-results tbody tr').length,2);
    const count=calls.filter(id=>id===hostId).length;fail=false;
    await ui.click('#xi-comparison .secondary-action');
    assert.equal(calls.filter(id=>id===hostId).length,count);assert.equal(ui.document.querySelectorAll('.room-comparison-players > li').length,11);
    // Replacing the authenticated loader hides both prior results immediately.
    let finish!:(body:ResultsSuccess)=>void;
    await ui.render(session(domain),async()=>new Promise(resolve=>{finish=resolve;}));
    assert.equal(ui.document.querySelectorAll('.room-comparison-players > li').length,0);
    const wrong=structuredClone(resultsBody(domain));Object.assign(wrong,{roundId:'wrong-round'});
    await act(async()=>finish(wrong));assert.match(ui.document.querySelector('#xi-comparison [role=alert]')!.textContent!,/could not be verified/);
  }finally{await ui.close();}
});

test("comparison is unavailable before resolution or with fewer than two eligible results",async()=>{
  let calls=0;
  const active=await mount(session(resultsStarted()),async()=>{calls++;throw new Error('Must not load');});
  try{assert.equal(active.document.querySelector(compareButton),null);assert.equal(calls,0);}finally{await active.close();}
  for(const eligible of [0,1]){
    const domain=resultsResolved(eligible),ui=await mount(session(domain),async id=>resultsBody(domain,hostId,id));
    try{const button=ui.document.querySelector<HTMLButtonElement>(compareButton);assert.ok(!button||button.disabled);assert.equal(ui.document.querySelector('#xi-comparison'),null);}finally{await ui.close();}
  }
});

test("comparison fails closed on mismatched shared fixture identity instead of pairing recurring opponents",async()=>{
  const domain=resultsResolved();
  const ui=await mount(session(domain),async id=>{
    const body=structuredClone(resultsBody(domain,hostId,id));
    if(id===memberId)Object.assign(body.campaign.matches[0].opponent,{profileId:'another-valid-profile'});
    return body;
  });
  try{await ui.click(compareButton);assert.match(ui.document.querySelector('#xi-comparison [role=alert]')!.textContent!,/could not be aligned/);assert.equal(ui.document.querySelectorAll('.room-comparison-fixtures > li').length,0);}finally{await ui.close();}
});

test("fixture overview starts compact, expands independently and preserves Super Over context",async()=>{
  const domain=resultsResolved(2,'era-transition','m53-super-over-50'),calls:string[]=[];
  const ui=await mount(session(domain),async id=>{calls.push(id);return resultsBody(domain,hostId,id);});
  try {
    await ui.click(compareButton);
    const fixtures=[...ui.document.querySelectorAll<HTMLDetailsElement>('.room-comparison-fixture')];
    assert.equal(fixtures.length,20);assert.ok(fixtures.every(detail=>!detail.open));
    assert.equal(ui.document.querySelectorAll('.room-fixture-outcome').length,40);
    const first=fixtures[0], third=fixtures[2];
    assert.match(first.querySelectorAll('.room-fixture-outcome')[1]!.textContent!,/LOSS.*Super Over/);
    assert.match(third.querySelector('.room-fixture-outcome')!.textContent!,/WIN.*Super Over/);
    const before=calls.length;
    await ui.click('.room-comparison-fixture summary');assert.equal(first.open,true);assert.equal(third.open,false);
    assert.equal(first.querySelectorAll('.innings-row').length,4);
    assert.match(first.querySelectorAll('.match-verdict')[1]!.textContent!,/won the Super Over/);
    await ui.click('.room-comparison-fixture summary');assert.equal(first.open,false);
    assert.equal(calls.length,before); // Disclosure never refetches or simulates.
  }finally{await ui.close();}
});
