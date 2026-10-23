import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { DraftOffRoomExperience, formatDraftCountdown, remainingDraftMs } from "./draftOffRoom.js";
import type { DraftOffRoomActions } from "./draftOffRoom.js";
import type { SnapshotSuccess, PublicCommand } from "./draftOffClientTypes.js";
import type { DraftOffSessionState } from "./draftOffSession.js";
import { catalog, joinedState, startedState, changed, completeXi, participant } from "./draftOffRoomTestSupport.js";
import { projectDraftOffRoom } from "./draftOffRoomProjection.js";
const code = "0123456789AB";
function snapshot(domain = joinedState(), actor = "host"): SnapshotSuccess {
  const view = structuredClone(projectDraftOffRoom(catalog, domain, actor));
  if (view.round.deadlineAtMs !== undefined) Object.assign(view.round, { deadlineAtMs: 600020 });
  return { ok: true, roomCode: code, participantId: actor, settings: { draftMinutes: 10 }, serverTimeMs: 20, view };
}
function spun() { const state = startedState(); return changed(state, { type: "APPLY_DRAFT_COMMAND", participantId: "host", atMs: 20, expectedDraftRevision: participant(state, "host").draftState.revision, draftCommand: { type: "SPIN" } }); }
function roomState(value: SnapshotSuccess): DraftOffSessionState { return { snapshot: value, pending: false, error: null, accessUnavailable: false }; }
const noop = async () => undefined;
const actions: DraftOffRoomActions = { command: noop, retry: noop, resync: noop };
async function mount(value: SnapshotSuccess, small = false, command: DraftOffRoomActions["command"] = noop) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://127.0.0.1:5173" });
  const keys = ["window", "document", "HTMLElement", "requestAnimationFrame", "matchMedia", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(keys.map(key => [key, (globalThis as Record<string, unknown>)[key]]));
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: (cb: FrameRequestCallback) => { cb(0); return 1; }, IS_REACT_ACT_ENVIRONMENT: true,
    matchMedia: () => ({ matches: small, addEventListener() {}, removeEventListener() {} }) });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async (state: DraftOffSessionState) => { await act(async () => root.render(<DraftOffRoomExperience code={code} state={state} actions={{ ...actions, command }} />)); };
  await render(roomState(value));
  return { document: dom.window.document, render,
    async click(selector: string) { const button = dom.window.document.querySelector<HTMLButtonElement>(selector); assert.ok(button, selector); await act(async () => button.click()); },
    async close() { await act(async () => root.unmount()); Object.assign(globalThis, previous); dom.window.close(); } };
}

test("presentation clock clamps elapsed time and never changes authoritative phase", async () => {
  assert.equal(remainingDraftMs(undefined, 50, 10), null);
  assert.equal(remainingDraftMs(100, 20, -10), 80);
  assert.equal(remainingDraftMs(100, 20, 1000), 0);
  assert.equal(formatDraftCountdown(599001), "10:00"); assert.equal(formatDraftCountdown(1000), "00:01");
  const value = snapshot(startedState()); Object.assign(value.view.round, { deadlineAtMs: 19 });
  const ui = await mount(value);
  try {
    assert.match(ui.document.body.textContent!, /Checking final status with the server/);
    assert.equal(ui.document.querySelector<HTMLButtonElement>(".room-draft-actions button")!.disabled, true);
    assert.equal(ui.document.querySelector(".room-results"), null);
  } finally { await ui.close(); }
});

test("lobby exposes only supported host/member controls and public roster", () => {
  const html = renderToStaticMarkup(<DraftOffRoomExperience code={code} state={roomState(snapshot())} actions={actions} />);
  assert.match(html, /Start 10-minute draft/); assert.match(html, /Host/); assert.match(html, /Copy invite link/);
  assert.doesNotMatch(html, /Ready|Online|rating|draftRevision/);
  const member = renderToStaticMarkup(<DraftOffRoomExperience code={code} state={roomState(snapshot(joinedState(), "member"))} actions={actions} />);
  assert.match(member, /Leave lobby/); assert.doesNotMatch(member, /Start 10-minute draft/);
  const left = changed(joinedState(), { type: "LEAVE_COMPETITION", participantId: "member", atMs: 2 });
  assert.match(renderToStaticMarkup(<DraftOffRoomExperience code={code} state={roomState(snapshot(left, "member"))} actions={actions} />), /Rejoin lobby/);
});

test("desktop placement uses projected legality, survives public revisions and sends one intent", async () => {
  const value = snapshot(spun()), commands: PublicCommand["command"][] = [];
  let release!: () => void;
  const ui = await mount(value, false, async command => { commands.push(command); await new Promise<void>(resolve => { release = resolve; }); });
  try {
    await ui.click('.candidate-card:not([aria-disabled="true"])');
    const option = ui.document.querySelector<HTMLButtonElement>('.room-position-option:not(:disabled)')!;
    const label = option.getAttribute("aria-label");
    await act(async () => option.click());
    assert.equal(ui.document.querySelector(".room-confirm-pick")?.textContent?.startsWith("Confirm pick"), true);
    const newer = structuredClone(value); Object.assign(newer.view, { revision: value.view.revision + 4 });
    await ui.render(roomState(newer));
    assert.equal(ui.document.querySelector('[aria-pressed="true"].room-position-option')?.getAttribute("aria-label"), label);
    await ui.click(".room-confirm-pick"); await ui.click(".room-confirm-pick");
    assert.equal(commands.length, 1); assert.equal(commands[0]!.type, "LOCK_PLAYER");
    release(); await act(async () => Promise.resolve());
    const own = structuredClone(newer); assert.ok(own.view.myDraft); Object.assign(own.view.myDraft, { revision: own.view.myDraft.revision + 1 });
    await ui.render(roomState(own)); assert.equal(ui.document.querySelector(".room-confirm-pick"), null);
  } finally { await ui.close(); }
});

test("mobile has candidate → placement → confirm, own XI and inspection dialogs", async () => {
  const commands: PublicCommand["command"][] = [];
  const ui = await mount(snapshot(spun()), true, async command => { commands.push(command); });
  try {
    await ui.click('.candidate-card:not([aria-disabled="true"])');
    assert.equal(ui.document.querySelectorAll(".room-placement-sheet[open]").length, 1);
    assert.ok(ui.document.querySelector('.room-placement-sheet [role="timer"]'));
    await ui.click('.room-placement-sheet .room-position-option:not(:disabled)');
    await ui.click('.room-placement-sheet .room-confirm-pick');
    assert.equal(commands.length, 1); assert.equal(commands[0]!.type, "LOCK_PLAYER");
    await ui.click('.room-placement-sheet header button');
    const xiButton = [...ui.document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith("Your XI"))!;
    await act(async () => xiButton.click()); assert.match(ui.document.querySelector(".room-dialog[open]")!.textContent!, /Your locked XI/);
  } finally { await ui.close(); }
});

test("submission requires confirmation and server-submitted participants have no draft commands", async () => {
  const domain = completeXi(startedState(), "host"), commands: PublicCommand["command"][] = [];
  const ui = await mount(snapshot(domain), false, async command => { commands.push(command); });
  try {
    await ui.click('.room-draft-actions .primary-action'); assert.equal(commands.length, 0);
    const submit = [...ui.document.querySelectorAll<HTMLButtonElement>("dialog button")].find(button => button.textContent === "Submit and lock XI")!;
    await act(async () => submit.click()); assert.deepEqual(commands, [{ type: "SUBMIT" }]);
    const submitted = changed(domain, { type: "SUBMIT_XI", participantId: "host", atMs: 20, expectedDraftRevision: participant(domain, "host").draftState.revision });
    await ui.render(roomState(snapshot(submitted)));
    assert.match(ui.document.body.textContent!, /Your XI is locked in/);
    assert.equal(ui.document.querySelector(".room-draft-actions"), null);
    assert.equal(ui.document.querySelectorAll(".room-locked-player").length, 11);
    assert.ok([...ui.document.querySelectorAll(".draft-off-members li")].filter(row => row.textContent?.startsWith("Member")).every(row => row.textContent === "MemberDrafting"));
  } finally { await ui.close(); }
});

test("leaderboard preserves server order, tied ranks and contest outcomes without extra private payload", () => {
  const value = snapshot(); Object.assign(value.view, { phase: "COMPLETE", resolution: { trigger: "DEADLINE", contestStatus: "CONTESTED", resolvedAtMs: 100,
    eligibleParticipantIds: ["host", "member"], ineligibleParticipantIds: [], leaderboard: [
      { rank: 1, participantId: "member", displayName: "Member", played: 20, won: 12, lost: 8, points: 24, netRunRate: 0.123456 },
      { rank: 1, participantId: "host", displayName: "Host", played: 20, won: 12, lost: 8, points: 24, netRunRate: 0.123456 }] } });
  const html = renderToStaticMarkup(<DraftOffRoomExperience code={code} state={roomState(value)} actions={actions} />);
  const parsed = new JSDOM(html);
  assert.deepEqual([...parsed.window.document.querySelectorAll("tbody tr td:first-child")].map(cell => cell.textContent), ["1", "1"]);
  parsed.window.close(); assert.match(html, /\+0.123/);
  assert.ok(html.indexOf('scope="row">Member') < html.indexOf('scope="row">Host'));
  for (const status of ["UNCONTESTED", "NO_CONTEST"]) {
    Object.assign(value.view.resolution!, { contestStatus: status, leaderboard: [] });
    const output = renderToStaticMarkup(<DraftOffRoomExperience code={code} state={roomState(value)} actions={actions} />);
    assert.match(output, status === "UNCONTESTED" ? /uncontested result/ : /No eligible XIs/);
  }
});

test("uncertain intent blocks replacement actions and exposes exact retry recovery", async () => {
  const value = snapshot(startedState()), ui = await mount(value);
  try {
    await ui.render({ ...roomState(value), pending: true, pendingCommand: "SPIN", retryAvailable: true, error: "Response uncertain" });
    assert.equal(ui.document.querySelector<HTMLButtonElement>(".room-draft-actions button")!.disabled, true);
    assert.match(ui.document.querySelector(".draft-off-recovery")!.textContent!, /exact saved intent/);
    assert.ok([...ui.document.querySelectorAll("button")].some(button => button.textContent === "Retry saved action"));
    await ui.render({ ...roomState(value), accessUnavailable: true, error: "Room access unavailable" });
    assert.equal(ui.document.querySelector<HTMLButtonElement>(".room-draft-actions button")!.disabled, true);
    assert.ok(![...ui.document.querySelectorAll("button")].some(button => button.textContent === "Retry saved action"));
  } finally { await ui.close(); }
});
