import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canonicalSha256 } from "./eraDraftCanonical.js";
import type { EraDraftCatalog, EraDraftPlayerRecord } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { evaluateFutureCompletion, evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import { countDraftTiers } from "./eraDraftTierCaps.js";
import { STANDARD_DRAFT_OFF_TIER_CAPS as caps } from "./draftOffRules.js";
import { createDraftOffCompetition, reduceDraftOffCompetition } from "./draftOffCompetition.js";
import { assertDraftOffCompetitionState } from "./draftOffCompetitionInvariants.js";
import { canonicalDraftOffCompetitionStateHash, restoreDraftOffCompetition, serializeDraftOffCompetition } from "./draftOffCompetitionPersistence.js";
import { projectDraftOffPublicRoom, projectDraftOffRoom } from "./draftOffRoomProjection.js";
import { projectEraDraftPublicState } from "./eraDraftProjection.js";
import { selectNormalSpinTeamSeason } from "./eraDraftRng.js";
import { replayEraDraftState } from "./eraDraftReplay.js";
import { parseRoomSnapshot } from "./draftOffRealtimeClient.js";
import { CandidateGallery } from "./eraDraftPlayerPresentation.js";
import { catalog, baseState, changed, participant, host, member, roomInput, success } from "./draftOffRoomTestSupport.js";
import { DraftOffRoomService } from "./draftOffRoomService.js";
import { InMemoryDraftOffRoomRepository, FakeDraftOffClock } from "./draftOffRoomRepository.js";
import { ERA_IDS, type EraId } from "./teamEvaluationV2.js";
import type { QualityTier } from "./playerQualityContract.js";
import type { EraDraftCommand, EraDraftPick, EraDraftState } from "./eraDraftTypes.js";
import type { DraftOffCompetitionState, DraftOffDraftCommand } from "./draftOffCompetitionTypes.js";

type Spec = { id?: string; tier?: QualityTier; overseas?: boolean; keeper?: boolean; team?: number };
function synthetic(specs: readonly Spec[]): EraDraftCatalog {
  const teams = catalog.getTeamSeasonsForEra("era-foundation").slice(0, 3);
  const template = catalog.getCandidatesForTeamSeason(teams[0]!.teamSeasonId)[0]!;
  const players = specs.map((spec, index): EraDraftPlayerRecord => {
    const team = teams[spec.team ?? 0]!;
    const playerId = spec.id ?? `p${index}`, pts = `test:${index}`;
    return { ...template, ...team, playerId, playerTeamSeasonId: pts, canonicalDisplayName: playerId,
      rosterStatus: spec.overseas ? "OVERSEAS" : "INDIAN",
      eligibility: { ...template.eligibility, playerTeamSeasonId: pts, playerId, seasonId: team.seasonId, teamId: team.teamId },
      quality: { ...template.quality, overall: { ...template.quality.overall, qualityTier: spec.tier ?? "B" } } };
  });
  const keepers = [...new Set(specs.flatMap((spec, index) => spec.keeper ? [players[index]!.playerId] : []))];
  const byPts = new Map(players.map(player => [player.playerTeamSeasonId, player]));
  const overrides: Partial<EraDraftCatalog> = {
    fingerprint: canonicalSha256(specs), getCompletionCostIndex: undefined,
    getTeamSeasonsForEra: () => teams,
    getPlayer: id => byPts.get(id), getEligibilityRow: id => byPts.get(id)?.eligibility,
    getCandidatesForTeamSeason: id => players.filter(player => player.teamSeasonId === id),
    getKeeperCapablePlayerIds: () => keepers,
    getPlayerVariantsForEra: (_era, id) => players.filter(player => player.playerId === id),
  };
  return new Proxy({} as EraDraftCatalog, { get(_target, key) {
    if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
    const value = Reflect.get(catalog, key); return typeof value === "function" ? value.bind(catalog) : value;
  } });
}
function pick(c: EraDraftCatalog, index: number, position: number): EraDraftPick {
  const player = c.getPlayer(`test:${index}`)!;
  return { pickNumber: position, playerTeamSeasonId: player.playerTeamSeasonId, playerId: player.playerId,
    seasonId: player.seasonId, teamId: player.teamId, franchiseId: player.franchiseId,
    teamSeasonId: player.teamSeasonId, battingPosition: position as EraDraftPick["battingPosition"] };
}
const fillers = (n = 12): Spec[] => Array.from({ length: n }, (_, i) => ({ keeper: i === 0 }));
function step(c: EraDraftCatalog, state: EraDraftState, command: EraDraftCommand, capped = true) {
  const result = reduceEraDraft(c, state, command, capped ? caps : undefined);
  assert.ok(result.ok, result.ok ? "" : result.error.message); return result.state;
}
function draftApply(state: DraftOffCompetitionState, id: string, draftCommand: DraftOffDraftCommand) {
  return changed(state, { type: "APPLY_DRAFT_COMMAND", participantId: id, atMs: 20,
    expectedDraftRevision: participant(state, id).draftState.revision, draftCommand });
}
function start(format: "VARIED" | "MIRROR", eraId: EraId = ERA_IDS[0]!, seed = "caps") {
  let state = createDraftOffCompetition(catalog, { ...baseState().genesis, format, tierCaps: { ...caps },
    initialRound: { ...baseState().genesis.initialRound, eraId, challengeSeed: seed } });
  state = changed(state, { type: "JOIN_COMPETITION", participantId: "member", displayName: "Member", atMs: 1 });
  return changed(state, { type: "START_ROUND", actorParticipantId: "host", roundId: "round-1", atMs: 10, deadlineAtMs: 1000 });
}

test("Standard boundaries use the selected player-season tier, with no B/C/D limits", () => {
  for (const [s, a, tier, expected] of [
    [2, 3, "S", []], [3, 0, "S", ["S_TIER_LIMIT"]], [3, 2, "A", []],
    [0, 6, "A", ["SA_TIER_LIMIT"]], [0, 6, "S", ["SA_TIER_LIMIT"]],
    [2, 4, "S", ["SA_TIER_LIMIT"]], [3, 3, "S", ["S_TIER_LIMIT", "SA_TIER_LIMIT"]],
    [3, 3, "A", ["SA_TIER_LIMIT"]], [3, 3, "B", []], [3, 3, "C", []], [3, 3, "D", []],
  ] as const) {
    const c = synthetic([...Array.from({ length: s }, () => ({ tier: "S" as const })),
      ...Array.from({ length: a }, () => ({ tier: "A" as const })), { tier }, ...fillers()]);
    const picks = Array.from({ length: s + a }, (_, i) => pick(c, i, i + 1));
    const input = { playerTeamSeasonId: `test:${s + a}`, battingPosition: s + a + 1 };
    const context = { eraId: "era-foundation" as const, picks, activeTeamSeasonId: c.getPlayer(input.playerTeamSeasonId)!.teamSeasonId };
    assert.deepEqual(evaluateSelectionLegality(c, { ...context, tierCaps: caps }, input).reasons.map(r => r.code), expected);
    assert.equal(evaluateSelectionLegality(c, context, input).available, true, "Uncapped path remains unchanged");
  }
});

test("LOCK_PLAYER rejection preserves every draft field; capped-only dead spins recover and respin stays viable", () => {
  const c = synthetic([{ tier: "S" }, { tier: "S" }, { tier: "S" }, { tier: "S", team: 1 },
    ...fillers().map(spec => ({ ...spec, team: 2 }))]);
  const seed = Array.from({ length: 10000 }, (_, n) => `recovery-${n}`).find(seed =>
    [0, 1, 2].every(n => selectNormalSpinTeamSeason(c, seed, "era-foundation", n).teamSeasonId === c.getPlayer("test:0")!.teamSeasonId)
    && selectNormalSpinTeamSeason(c, seed, "era-foundation", 3).teamSeasonId === c.getPlayer("test:3")!.teamSeasonId);
  assert.ok(seed);
  let state: EraDraftState = step(c, createEraDraftGame({ catalog: c, rootSeed: seed }), { type: "CHOOSE_ERA", eraId: "era-foundation" });
  for (let i = 0; i < 3; i++) {
    state = step(c, state, { type: "SPIN" });
    state = step(c, state, { type: "LOCK_PLAYER", playerTeamSeasonId: `test:${i}`, battingPosition: i + 1 });
  }
  assert.equal(state.picks.length, 3);
  state = step(c, state, { type: "SPIN" }); assert.equal(state.phase, "AWAITING_PICK");
  if (state.phase !== "AWAITING_PICK") throw new Error("Expected spin");
  assert.equal(state.currentSpin.teamSeasonId, c.getPlayer("test:4")!.teamSeasonId);
  const before = state;
  // Wrong-spin and cap reasons are both returned, without changing RNG/history/revision.
  const denied = reduceEraDraft(c, state, { type: "LOCK_PLAYER", playerTeamSeasonId: "test:3", battingPosition: 4 }, caps);
  assert.equal(denied.ok, false); assert.equal(denied.state, before);
  if (!denied.ok) assert.ok(denied.error.reasons!.some(r => r.code === "S_TIER_LIMIT"));
  const respun = reduceEraDraft(c, state, { type: "RESPIN" }, caps);
  assert.equal(respun.ok, false, "Only the discarded team has viable lower-tier picks"); assert.equal(respun.state, before);
  assert.equal(respun.state.respin.status, "AVAILABLE");
  assert.deepEqual(replayEraDraftState(c, state, caps), state);
  // At least one recovery event must have skipped an otherwise nonempty elite-only team.
  assert.ok(state.history.some(e => (e.command === "SPIN" || e.command === "RESPIN") && e.skippedDeadTeamSeasonIds.length > 0));
});

test("future completion couples remaining tiers, keeper, overseas and canonical uniqueness", () => {
  const cases: { specs: Spec[]; drafted: number; feasible: boolean; minimum?: number | null }[] = [
    { specs: [...Array.from({ length: 3 }, () => ({ tier: "S" as const })), ...fillers(8), { tier: "S", keeper: true }], drafted: 3, feasible: true },
    { specs: [...Array.from({ length: 3 }, () => ({ tier: "S" as const })), ...Array.from({ length: 7 }, () => ({})), { tier: "S", keeper: true }], drafted: 3, feasible: false },
    { specs: [...Array.from({ length: 6 }, () => ({ tier: "A" as const })), ...Array.from({ length: 4 }, () => ({})), { tier: "A", keeper: true }], drafted: 6, feasible: false },
    { specs: [...Array.from({ length: 4 }, () => ({ overseas: true })), ...Array.from({ length: 6 }, () => ({})), { overseas: true, keeper: true }], drafted: 4, feasible: false, minimum: 1 },
    // This keeper's Indian S version and overseas B version cannot be combined into an Indian B version.
    { specs: [...Array.from({ length: 3 }, () => ({ tier: "S" as const })), { overseas: true }, ...Array.from({ length: 3 }, () => ({ overseas: true })), ...Array.from({ length: 3 }, () => ({})),
      { id: "keeper", keeper: true, tier: "S" }, { id: "keeper", keeper: true, overseas: true }], drafted: 7, feasible: false, minimum: 1 },
    // An actual Indian B keeper alternative makes the same state feasible.
    { specs: [...Array.from({ length: 3 }, () => ({ tier: "S" as const })), ...Array.from({ length: 4 }, () => ({ overseas: true })), ...Array.from({ length: 3 }, () => ({})),
      { id: "keeper", keeper: true, tier: "S" }, { id: "keeper", keeper: true }], drafted: 7, feasible: true, minimum: 0 },
    { specs: [...fillers(10), { id: "p1" }], drafted: 0, feasible: false },
  ];
  for (const { specs, drafted, feasible, minimum } of cases) {
    const c = synthetic(specs), picks = Array.from({ length: drafted }, (_, i) => pick(c, i, i + 1));
    const result = evaluateFutureCompletion(c, "era-foundation", picks, caps);
    assert.equal(result.feasible, feasible, JSON.stringify(specs));
    if (minimum !== undefined) assert.equal(result.minimumOverseasNeeded, minimum);
  }
  const c = synthetic([...Array.from({ length: 3 }, () => ({ tier: "S" as const })), ...Array.from({ length: 6 }, () => ({})),
    { keeper: true, tier: "A" }, { tier: "A" }, { tier: "A" }]);
  const picks = Array.from({ length: 9 }, (_, i) => pick(c, i, i + 1));
  assert.equal(evaluateFutureCompletion(c, "era-foundation", picks, { maxS: 3, maxSA: 4 }).feasible, false, "two fillers compete for one remaining elite slot including the keeper");
});

test("selection reserves the last S allowance for a remaining keeper instead of allowing a future trap", () => {
  const c = synthetic([{ tier: "S" }, { tier: "S" }, ...Array.from({ length: 7 }, () => ({})),
    { tier: "S" }, { tier: "S", keeper: true }, {}]);
  const picks = Array.from({ length: 9 }, (_, i) => pick(c, i, i + 1));
  const context = { eraId: "era-foundation" as const, picks, tierCaps: caps, activeTeamSeasonId: c.getPlayer("test:9")!.teamSeasonId };
  assert.equal(evaluateFutureCompletion(c, "era-foundation", picks, caps).feasible, true);
  const input = { playerTeamSeasonId: "test:9", battingPosition: 10 };
  assert.deepEqual(evaluateSelectionLegality(c, context, input).reasons.map(r => r.code), ["FUTURE_XI_IMPOSSIBLE"]);
  assert.equal(evaluateSelectionLegality(c, { ...context, tierCaps: undefined }, input).available, true);
  assert.equal(evaluateSelectionLegality(c, context, { ...input, playerTeamSeasonId: "test:10" }).available, true);
});

// Small independent exhaustive oracle exercises resource coupling, variants and keeper obligation.
test("exact feasibility agrees with exhaustive distinct-player search on 160 deterministic scarce catalogs", () => {
  let seed = 92;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 65536) % n; };
  let feasibleRuns = 0;
  for (let run = 0; run < 160; run++) {
    const specs: Spec[] = Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, tier: ["S", "A", "B"][random(3)] as QualityTier, overseas: random(3) === 0, keeper: random(8) === 0 }));
    for (let i = 0; i < 6; i++) specs.push({ id: `r${random(4)}`, tier: ["S", "A", "B"][random(3)] as QualityTier, overseas: random(2) === 0, keeper: random(5) === 0 });
    const c = synthetic(specs), picks = Array.from({ length: 8 }, (_, i) => pick(c, i, i + 1));
    const keeperIds = new Set(c.getKeeperCapablePlayerIds("era-foundation"));
    const initial = countDraftTiers(c, picks), overseas = specs.slice(0, 8).filter(s => s.overseas).length;
    let possible = false;
    for (let i = 8; i < specs.length; i++) for (let j = i + 1; j < specs.length; j++) for (let k = j + 1; k < specs.length; k++) {
      const selected = [i, j, k], ids = selected.map(index => specs[index]!.id!);
      if (new Set(ids).size !== 3) continue;
      const s = initial.s + selected.filter(index => specs[index]!.tier === "S").length;
      const sa = initial.sa + selected.filter(index => ["S", "A"].includes(specs[index]!.tier!)).length;
      if (s <= caps.maxS && sa <= caps.maxSA && overseas + selected.filter(index => specs[index]!.overseas).length <= 4
        && [...picks.map(p => p.playerId), ...ids].some(id => keeperIds.has(id))) possible = true;
    }
    feasibleRuns += Number(possible);
    assert.equal(evaluateFutureCompletion(c, "era-foundation", picks, caps).feasible, possible, `oracle run ${run}`);
  }
  assert.ok(feasibleRuns >= 10 && feasibleRuns < 150, `Oracle must include feasible and impossible cases: ${feasibleRuns}`);
});

for (const eraId of ERA_IDS) for (const format of ["VARIED", "MIRROR"] as const) test(`${eraId}/${format}: 12 seeded capped competitions finish legally with late respins`, () => {
  for (let seed = 0; seed < 12; seed++) {
    let state = start(format, eraId, `caps:${seed}`);
    for (const id of ["host", "member"]) for (let n = 0; n < 11; n++) {
      state = draftApply(state, id, { type: "SPIN" });
      if (n === 6 + seed % 5) state = draftApply(state, id, { type: "RESPIN" });
      const view = projectDraftOffRoom(catalog, state, id).myDraft;
      assert.equal(view?.phase, "AWAITING_PICK"); if (view?.phase !== "AWAITING_PICK") throw new Error("Expected candidates");
      const choices = view.candidates.filter(c => c.available);
      assert.ok(choices.length);
      // Deliberately consume elite capacity early, alternating S-first and A-first strategies.
      choices.sort((a, b) => {
        const order = seed % 2 ? ["A", "S", "B", "C", "D"] : ["S", "A", "B", "C", "D"];
        return order.indexOf(catalog.getPlayer(a.playerTeamSeasonId)!.quality.overall.qualityTier) - order.indexOf(catalog.getPlayer(b.playerTeamSeasonId)!.quality.overall.qualityTier);
      });
      const choice = choices[seed % 3 === 2 ? (seed + n) % choices.length : 0]!;
      state = draftApply(state, id, { type: "LOCK_PLAYER", playerTeamSeasonId: choice.playerTeamSeasonId, battingPosition: choice.positions.find(p => p.available)!.battingPosition });
      const counts = countDraftTiers(catalog, participant(state, id).draftState.picks);
      assert.ok(counts.s <= 3 && counts.sa <= 6);
    }
    for (const id of ["host", "member"]) {
      const draft = participant(state, id).draftState;
      assert.equal(draft.phase, "XI_COMPLETE"); assert.equal(new Set(draft.picks.map(p => p.playerId)).size, 11);
      assert.equal(evaluateFutureCompletion(catalog, eraId, draft.picks, caps).feasible, true);
    }
    // Every format/era includes both manual and automatic finalization, plus full canonical replay.
    if (seed === 0) {
      state = changed(state, { type: "SUBMIT_XI", participantId: "host", expectedDraftRevision: participant(state, "host").draftState.revision, atMs: 30 });
      state = changed(state, { type: "FINALIZE_ROUND", roundId: "round-1", atMs: 1000 });
      assert.equal(state.phase, "COMPLETE");
      assert.deepEqual(restoreDraftOffCompetition(catalog, serializeDraftOffCompetition(state)), state);
    }
  }
});

test("v3 genesis pins effective values, rejects version mixing and tampering; v1/v2 retain absent caps", () => {
  const state = start("VARIED");
  const saved = JSON.parse(serializeDraftOffCompetition(state));
  assert.match(saved.saveVersion, /\/v3$/); assert.match(state.engineVersion, /\/v3$/);
  assert.deepEqual(saved.genesis.tierCaps, { maxS: 3, maxSA: 6 });
  for (const mutate of [
    (row: typeof saved) => { delete row.genesis.tierCaps; },
    (row: typeof saved) => { row.genesis.tierCaps.maxS = 4; },
    (row: typeof saved) => { row.genesis.tierCaps.maxSA = -1; },
    (row: typeof saved) => { row.genesis.tierCaps.extra = 1; },
    (row: typeof saved) => { row.saveVersion = "ipl-draft-off-competition-save/v2"; },
    (row: typeof saved) => { row.engineVersion = "ipl-draft-off-competition-engine/v2"; },
    (row: typeof saved) => { row.stateSchemaVersion = "ipl-draft-off-competition-state/v2"; },
  ]) { const row = structuredClone(saved); mutate(row); assert.throws(() => restoreDraftOffCompetition(catalog, JSON.stringify(row))); }
  const custom = createDraftOffCompetition(catalog, { ...baseState().genesis, format: "MIRROR", tierCaps: { maxS: 1, maxSA: 2 } });
  assert.deepEqual(restoreDraftOffCompetition(catalog, serializeDraftOffCompetition(custom)).genesis.tierCaps, { maxS: 1, maxSA: 2 }, "Replay reads stored values instead of today's preset");
  for (const format of [undefined, "VARIED", "MIRROR"] as const) {
    const old = createDraftOffCompetition(catalog, { ...baseState().genesis, ...(format ? { format } : {}) });
    assert.equal(Object.hasOwn(restoreDraftOffCompetition(catalog, serializeDraftOffCompetition(old)).genesis, "tierCaps"), false);
    assert.equal(Object.hasOwn(projectDraftOffPublicRoom(old).round, "tierCaps"), false);
  }
  assert.throws(() => assertDraftOffCompetitionState(catalog, { ...state, engineVersion: "ipl-draft-off-competition-engine/v2" }));
});

test("historical v1/v2 rooms replay and continue to complete XIs beyond the new caps", () => {
  for (const format of [undefined, "VARIED", "MIRROR"] as const) {
    let state = createDraftOffCompetition(catalog, { ...baseState().genesis, ...(format ? { format } : {}) });
    state = changed(state, { type: "JOIN_COMPETITION", participantId: "member", displayName: "Member", atMs: 1 });
    state = changed(state, { type: "START_ROUND", actorParticipantId: "host", roundId: "round-1", atMs: 10, deadlineAtMs: 1000 });
    for (let n = 0; n < 11; n++) {
      state = restoreDraftOffCompetition(catalog, serializeDraftOffCompetition(state));
      state = draftApply(state, "host", { type: "SPIN" });
      const view = projectDraftOffRoom(catalog, state, "host").myDraft;
      if (view?.phase !== "AWAITING_PICK") throw new Error("Expected candidates");
      const tiers = ["S", "A", "B", "C", "D"];
      const choice = view.candidates.filter(c => c.available).sort((a, b) => tiers.indexOf(catalog.getPlayer(a.playerTeamSeasonId)!.quality.overall.qualityTier) - tiers.indexOf(catalog.getPlayer(b.playerTeamSeasonId)!.quality.overall.qualityTier))[0]!;
      state = draftApply(state, "host", { type: "LOCK_PLAYER", playerTeamSeasonId: choice.playerTeamSeasonId, battingPosition: choice.positions.find(p => p.available)!.battingPosition });
    }
    assert.equal(participant(state, "host").draftState.phase, "XI_COMPLETE");
    const counts = countDraftTiers(catalog, participant(state, "host").draftState.picks);
    assert.ok(counts.s > caps.maxS || counts.sa > caps.maxSA, JSON.stringify(counts));
    assert.deepEqual(restoreDraftOffCompetition(catalog, serializeDraftOffCompetition(state)), state);
  }
});

test("v3 public rules are whitelisted; candidate reasons work in existing UI without leaking numeric ratings", () => {
  let state = start("MIRROR");
  let blocked = false;
  for (let n = 0; n < 10 && !blocked; n++) {
    state = draftApply(state, "host", { type: "SPIN" });
    const projected = projectDraftOffRoom(catalog, state, "host");
    const message = { version: 3, type: "ROOM_SNAPSHOT", serverTimeMs: 20, view: projectDraftOffPublicRoom(state) };
    assert.deepEqual(parseRoomSnapshot(JSON.stringify(message), state.competitionId).view.round.tierCaps, caps);
    for (const bad of [
      { ...message, version: 2 },
      { ...message, view: { ...message.view, myDraft: projected.myDraft } },
      { ...message, view: { ...message.view, round: { ...message.view.round, tierCaps: { maxS: 3 } } } },
    ]) assert.throws(() => parseRoomSnapshot(JSON.stringify(bad), state.competitionId));
    assert.equal(projected.myDraft?.phase, "AWAITING_PICK"); if (projected.myDraft?.phase !== "AWAITING_PICK") throw new Error("Expected candidates");
    const candidate = projected.myDraft.candidates.find(c => c.positions.some(p => p.reasons.some(r => r.code === "S_TIER_LIMIT" || r.code === "SA_TIER_LIMIT")));
    if (candidate) {
      blocked = true;
      assert.equal(candidate.available, false);
      const html = renderToStaticMarkup(createElement(CandidateGallery, { view: projected.myDraft, selectedId: null, onSelect() {}, onUnavailable() {} }));
      assert.ok(html.includes("Standard Draft-Off allows at most")); assert.ok(html.includes('aria-disabled="true"'));
      const before = canonicalDraftOffCompetitionStateHash(state);
      const result = reduceDraftOffCompetition(catalog, state, { type: "APPLY_DRAFT_COMMAND", participantId: "host", atMs: 20,
        expectedDraftRevision: participant(state, "host").draftState.revision, draftCommand: { type: "LOCK_PLAYER", playerTeamSeasonId: candidate.playerTeamSeasonId, battingPosition: getOpenBattingPositions(participant(state, "host").draftState.picks)[0]! } });
      assert.equal(result.ok, false); assert.equal(result.state, state); assert.equal(canonicalDraftOffCompetitionStateHash(state), before);
    } else {
      const legal = projected.myDraft.candidates.filter(c => c.available).sort((a, b) => {
        const tiers = ["S", "A", "B", "C", "D"]; return tiers.indexOf(catalog.getPlayer(a.playerTeamSeasonId)!.quality.overall.qualityTier) - tiers.indexOf(catalog.getPlayer(b.playerTeamSeasonId)!.quality.overall.qualityTier);
      })[0]!;
      state = draftApply(state, "host", { type: "LOCK_PLAYER", playerTeamSeasonId: legal.playerTeamSeasonId, battingPosition: legal.positions.find(p => p.available)!.battingPosition });
    }
    for (const key of ["myDraft", "rootSeed", "picks", "qualityTier", "overallRating", "history", "rngCounters"]) assert.ok(!JSON.stringify(message.view).includes(`"${key}"`));
  }
  assert.equal(blocked, true);
});

test("service persistence/reconnect/retries and overdue recovery all retain the room's effective rules", async () => {
  const repository = new InMemoryDraftOffRoomRepository(), clock = new FakeDraftOffClock(20);
  let service = new DraftOffRoomService(catalog, repository, clock);
  await service.createRoom(host, { ...roomInput, format: "VARIED", tierCaps: caps });
  success(await service.execute(member, { roomId: "room", commandId: "join", expectedRoomRevision: 0, command: { type: "JOIN", displayName: "Member" } }));
  success(await service.execute(host, { roomId: "room", commandId: "start", expectedRoomRevision: 1, command: { type: "START", roundId: "round-1", deadlineAtMs: 1000 } }));
  const envelope = { roomId: "room", commandId: "spin", expectedDraftRevision: 1, command: { type: "SPIN" as const } };
  const spun = success(await service.execute(host, envelope));
  service.dispose(); service = new DraftOffRoomService(catalog, repository, clock); await service.resumeRoom("room");
  assert.deepEqual(await service.execute(host, envelope), spun);
  assert.deepEqual((await service.readRoom(host, "room")).round.tierCaps, caps);
  const before = await service.readRoom(host, "room");
  assert.equal((await service.readRoom(member, "room")).myDraft!.revision, 1);
  assert.equal(before.participants.find(p => p.participantId === "host")!.lockedPickCount, 0);
  service.dispose(); await clock.advanceTo(1000);
  service = new DraftOffRoomService(catalog, repository, clock);
  await service.resumeRoom("room");
  const expired = await service.readRoom(host, "room");
  assert.equal(expired.phase, "COMPLETE"); assert.deepEqual(expired.round.tierCaps, caps);
  assert.equal(expired.resolution!.contestStatus, "NO_CONTEST");
  assert.deepEqual(await service.execute(host, envelope), spun, "Historical receipt stays byte-identical after deadline");
  service.dispose();
});
