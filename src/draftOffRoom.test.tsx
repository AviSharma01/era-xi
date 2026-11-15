import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { DraftOffRoomExperience, draftClockState, formatDraftCountdown, remainingDraftMs } from "./draftOffRoom.js";
import type { DraftOffRoomActions } from "./draftOffRoom.js";
import type { SnapshotSuccess, PublicCommand } from "./draftOffClientTypes.js";
import type { DraftOffSessionState } from "./draftOffSession.js";
import { catalog, joinedState, startedState, changed, completeXi, participant } from "./draftOffRoomTestSupport.js";
import { projectDraftOffRoom } from "./draftOffRoomProjection.js";
import { draftOf, participantId, roomApply, roomLobby, startRoom } from "./evaluationV3TestSupport.js";
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
    assert.equal(ui.document.querySelector<HTMLButtonElement>(".drafting-primary")!.disabled, true);
    assert.equal(ui.document.querySelector(".room-results"), null);
  } finally { await ui.close(); }
});

test("access loss removes the private workspace and open player inspection", async () => {
  const ui = await mount(snapshot(spun()));
  try {
    await ui.click('.squad-row:not([aria-disabled="true"])');
    assert.ok(ui.document.querySelector('.xi-slot-active'));
    await ui.render({ snapshot: null, pending: false, error: 'Saved room access changed. Reload to restore access.', accessUnavailable: true });
    assert.match(ui.document.body.textContent!, /Room access unavailable/);
    assert.equal(ui.document.querySelector('.squad-row'), null);
    assert.equal(ui.document.querySelector('.xi-slot-active'), null);
    assert.equal(ui.document.querySelector('dialog'), null);
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

test("existing roster displays authoritative pick counts with drafting, submitted and incomplete statuses", () => {
  const value = snapshot(startedState());
  Object.assign(value.view.participants[0]!, { lockedPickCount: 7, roundStatus: "DRAFTING" });
  Object.assign(value.view.participants[1]!, { lockedPickCount: 11, roundStatus: "SUBMITTED" });
  const render = () => renderToStaticMarkup(<DraftOffRoomExperience code={code} state={roomState(value)} actions={actions} />);
  assert.match(render(), /7\/11 · Drafting/);
  assert.match(render(), /11\/11 · Submitted/);
  Object.assign(value.view.participants[1]!, { lockedPickCount: 10, roundStatus: "INELIGIBLE" });
  assert.match(render(), /10\/11 · Incomplete/);
  const legacy = value.view.participants.map(({ lockedPickCount: _progress, ...row }) => row);
  Object.assign(value.view, { participants: legacy });
  assert.doesNotMatch(render(), /undefined|NaN|\/11 ·/);
});

test("newer public roster renders without replacing or confirming the authenticated private draft", () => {
  const value = snapshot(startedState());
  const { myDraft: _private, ...view } = structuredClone(value.view);
  Object.assign(view, { revision: value.view.revision + 5 });
  Object.assign(view.participants[0]!, { lockedPickCount: 11, roundStatus: "SUBMITTED" });
  Object.assign(view.participants[1]!, { lockedPickCount: 7 });
  const state = { ...roomState(value), publicSnapshot: { version: 1 as const, type: "ROOM_SNAPSHOT" as const, serverTimeMs: 25, view } };
  const html = renderToStaticMarkup(<DraftOffRoomExperience code={code} state={state} actions={actions} />);
  assert.match(html, /7\/11 · Drafting/);
  assert.match(html, /11\/11 · Submitted/);
  assert.doesNotMatch(html, /Submission confirmed/);
  assert.match(html, /0 \/ 11 locked/);
  assert.equal(value.view.myDraft!.phase, "AWAITING_SPIN");
});

test("format stays visible in lobby, play and results, with historical rooms identified as Mirror", () => {
  for (const format of ["VARIED", "MIRROR", undefined] as const) {
    for (const domain of [joinedState(), startedState(), changed(startedState(), { type: "FINALIZE_ROUND", roundId: "round-1", atMs: 100 })]) {
      const value = snapshot(domain);
      if (format) Object.assign(value.view.round, { format });
      const html = renderToStaticMarkup(<DraftOffRoomExperience code={code} state={roomState(value)} actions={actions} />);
      assert.match(html, format === "VARIED" ? /Varied Draft/ : /Mirror Draft/);
      assert.doesNotMatch(html, /<select[^>]*format/i);
      if (domain.phase === "LOBBY" && format === "VARIED") assert.match(html, /Opportunities can be unequal/);
    }
  }
});

test("desktop placement uses projected legality, survives public revisions and sends one intent", async () => {
  const value = snapshot(spun()), commands: PublicCommand["command"][] = [];
  let release!: () => void;
  const ui = await mount(value, false, async command => { commands.push(command); await new Promise<void>(resolve => { release = resolve; }); });
  try {
    await ui.click('.squad-row:not([aria-disabled="true"])');
    const option = ui.document.querySelector<HTMLButtonElement>('.xi-slot-active:not(:disabled)')!;
    const position = option.closest<HTMLElement>(".xi-slot")!.dataset.position!;
    await act(async () => option.click());
    assert.match(ui.document.querySelector(".drafting-lock")!.textContent!, /^Lock in \d\d$/);
    const newer = structuredClone(value); Object.assign(newer.view, { revision: value.view.revision + 4 });
    await ui.render(roomState(newer));
    const slot = ui.document.querySelector(`.xi-slot[data-position="${position}"]`)!;
    assert.match(slot.querySelector(".xi-slot-preview")!.getAttribute("aria-label")!, new RegExp(`, [SABCD] tier, .*position ${position}, preview, `));
    assert.ok(slot.querySelector(".player-card-state-preview .player-card-state-edge"));
    await ui.click(".drafting-lock"); await ui.click(".drafting-lock");
    assert.equal(commands.length, 1); assert.equal(commands[0]!.type, "LOCK_PLAYER");
    await ui.render({ ...roomState(newer), pending: true, pendingCommand: "LOCK_PLAYER" });
    const pendingCard = ui.document.querySelector(".xi-board .player-card-state-pending")!;
    assert.match(pendingCard.textContent!, /Locking…/);
    assert.equal(ui.document.querySelector(".xi-board .player-card-state-edge"), null, "no ivory edge until the server confirms");
    assert.match(pendingCard.getAttribute("aria-label")!, new RegExp(`position ${position}, locking, waiting for the server, `));
    assert.ok([...ui.document.querySelectorAll(".xi-open-slot")].every(button => button.getAttribute("aria-label")!.endsWith("Waiting for server…")));
    assert.equal(ui.document.querySelector(".xi-slot-preview"), null);
    assert.equal(ui.document.querySelector(".drafting-lock")!.textContent, "Waiting for server…");
    await ui.render(roomState(newer));
    release(); await act(async () => Promise.resolve());
    const own = structuredClone(newer); assert.ok(own.view.myDraft); Object.assign(own.view.myDraft, { revision: own.view.myDraft.revision + 1 });
    await ui.render(roomState(own)); assert.equal(ui.document.querySelector(".drafting-lock"), null);
  } finally { await ui.close(); }
});

test("mobile follows the step: squad, flash, placing with a button lock, and back without leaving", async () => {
  const commands: PublicCommand["command"][] = [];
  const ui = await mount(snapshot(spun()), true, async command => { commands.push(command); });
  const view = ui.document.defaultView!;
  try {
    assert.ok(ui.document.querySelector(".xi-strip"));
    assert.equal(ui.document.querySelector(".xi-board"), null, "choosing shows the list, not the full XI");
    await ui.click('.squad-row:not([aria-disabled="true"])');
    assert.ok(ui.document.querySelector(".squad-flash .selected-player-detail h3"), "the card expands in the list");
    await ui.click('.squad-flash .quiet-button');
    assert.ok(ui.document.querySelector('.player-inspector[open] [role="timer"]'));
    await ui.click('.player-inspector button');
    await ui.click(".drafting-place");
    assert.equal(ui.document.querySelectorAll(".xi-slot").length, 11);
    assert.equal(ui.document.querySelector<HTMLButtonElement>(".drafting-lock")!.disabled, true, "lock waits for a slot");
    assert.match(ui.document.querySelector(".drafting-bar")!.textContent!, /Change player/);

    await act(async () => view.dispatchEvent(new view.PopStateEvent("popstate")));
    assert.equal(ui.document.querySelector(".xi-board"), null, "back steps to the squad");
    assert.ok(ui.document.querySelector(".squad-flash"), "and keeps the selected player");
    assert.equal(ui.document.activeElement, ui.document.querySelector(".drafting-place"), "focus returns to where the step began");
    await ui.click(".drafting-place");

    await ui.click(".xi-slot-active:not(:disabled)");
    assert.match(ui.document.querySelector(".drafting-bar")!.textContent!, /Tap Lock to confirm/);
    assert.doesNotMatch(ui.document.querySelector(".xi-board")!.textContent!, /click/i, "no click on touch");
    assert.equal(ui.document.activeElement, ui.document.querySelector(".drafting-lock"));
    const previewed = ui.document.querySelector<HTMLElement>(".xi-slot-preview")!;
    assert.notEqual(previewed.tagName, "BUTTON", "phones lock by button only");
    await act(async () => previewed.click());
    assert.equal(commands.length, 0);
    await ui.click(".drafting-lock");
    assert.equal(commands.length, 1); assert.equal(commands[0]!.type, "LOCK_PLAYER");
  } finally { await ui.close(); }
});

test("mobile dismisses the flash on a swipe down or a tap on its row, and swaps on another row", async () => {
  const ui = await mount(snapshot(spun()), true);
  const view = ui.document.defaultView!;
  try {
    const rows = () => [...ui.document.querySelectorAll<HTMLButtonElement>('.squad-row:not([aria-disabled="true"])')];
    await act(async () => rows()[0]!.click());
    const firstName = ui.document.querySelector(".squad-flash h3")!.textContent;
    await act(async () => rows()[1]!.click());
    assert.notEqual(ui.document.querySelector(".squad-flash h3")!.textContent, firstName);
    assert.equal(ui.document.querySelectorAll(".squad-flash").length, 1);
    await act(async () => rows()[1]!.click());
    assert.equal(ui.document.querySelector(".squad-flash"), null);
    await act(async () => rows()[0]!.click());
    const card = ui.document.querySelector(".squad-flash-card")!;
    const touch = (type: string, clientY: number) => {
      const event = new view.Event(type, { bubbles: true }) as Event & Record<string, unknown>;
      const point = [{ clientX: 100, clientY }];
      event.touches = type === "touchend" ? [] : point; event.changedTouches = point;
      card.dispatchEvent(event);
    };
    await act(async () => { touch("touchstart", 100); touch("touchend", 130); });
    assert.ok(ui.document.querySelector(".squad-flash"), "a short drag does nothing");
    await act(async () => { touch("touchstart", 100); touch("touchend", 200); });
    assert.equal(ui.document.querySelector(".squad-flash"), null);
    assert.equal(ui.document.activeElement, rows()[0], "focus returns to the row");
  } finally { await ui.close(); }
});

test("submission requires confirmation and server-submitted participants have no draft commands", async () => {
  const domain = completeXi(startedState(), "host"), commands: PublicCommand["command"][] = [];
  const ui = await mount(snapshot(domain), false, async command => { commands.push(command); });
  try {
    await ui.click('.drafting-primary'); assert.equal(commands.length, 0);
    assert.ok(ui.document.querySelector('.room-dialog[open] [role="timer"]'));
    const submit = [...ui.document.querySelectorAll<HTMLButtonElement>("dialog button")].find(button => button.textContent === "Submit and lock XI")!;
    await act(async () => submit.click()); assert.deepEqual(commands, [{ type: "SUBMIT" }]);
    const submitted = changed(domain, { type: "SUBMIT_XI", participantId: "host", atMs: 20, expectedDraftRevision: participant(domain, "host").draftState.revision });
    await ui.render(roomState(snapshot(submitted)));
    assert.match(ui.document.body.textContent!, /Your XI is locked in/);
    assert.equal(ui.document.querySelector(".drafting"), null);
    assert.equal(ui.document.querySelectorAll(".room-locked-player").length, 11);
    await ui.click('.room-locked-player');
    assert.ok(ui.document.querySelector('.player-inspector[open] [role="timer"]'));
    await ui.click('.player-inspector button');
    assert.ok([...ui.document.querySelectorAll(".draft-off-members li")].filter(row => row.textContent?.startsWith("Member")).every(row => row.textContent === "Member0/11 · Drafting"));
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
    assert.equal(ui.document.querySelector<HTMLButtonElement>(".drafting-primary")!.disabled, true);
    assert.match(ui.document.querySelector(".draft-off-recovery")!.textContent!, /exact saved intent/);
    assert.ok([...ui.document.querySelectorAll("button")].some(button => button.textContent === "Retry saved action"));
    await ui.render({ ...roomState(value), accessUnavailable: true, error: "Room access unavailable" });
    assert.equal(ui.document.querySelector<HTMLButtonElement>(".drafting-primary")!.disabled, true);
    assert.ok(![...ui.document.querySelectorAll("button")].some(button => button.textContent === "Retry saved action"));
  } finally { await ui.close(); }
});

test("mobile pending placement and server deadline stay explicit in the placing step", async () => {
  const value=snapshot(spun()),ui=await mount(value,true,()=>new Promise<void>(()=>undefined));
  try {
    await ui.click('.squad-row:not([aria-disabled="true"])');
    const selected=ui.document.querySelector('.squad-flash .selected-player-detail h3')!.textContent;
    await ui.click('.drafting-place');
    assert.equal(ui.document.querySelector('.drafting-bar .player-card-name')!.textContent,selected);
    assert.equal(ui.document.querySelectorAll('.xi-board .xi-slot').length,11);
    await ui.click('.xi-slot-active:not(:disabled)');
    await ui.click('.drafting-lock');
    await ui.render({...roomState(value),pending:true,pendingCommand:'LOCK_PLAYER'});
    assert.equal(ui.document.querySelector('.drafting-bar .player-card-name')!.textContent,selected);
    assert.equal(ui.document.querySelector('.drafting-lock')!.textContent,'Waiting for server…');
    assert.match(ui.document.querySelector('.xi-board .player-card-state-pending')!.textContent!,/Locking…/);
    assert.equal(ui.document.querySelector('.xi-board .player-card-state-edge'),null);
    assert.equal(ui.document.querySelector<HTMLButtonElement>('.drafting-back')!.disabled,true,'going back waits for the server');
    assert.equal(ui.document.querySelector<HTMLButtonElement>('.drafting-change')!.disabled,true);
    assert.ok([...ui.document.querySelectorAll<HTMLButtonElement>('.xi-open-slot')].every(button=>button.disabled));
    const expired=structuredClone(value);Object.assign(expired.view.round,{deadlineAtMs:19});
    await ui.render(roomState(expired));
    assert.equal(ui.document.querySelector('[role="timer"]')!.getAttribute('aria-label'),'Time’s up. Checking with the server');
    assert.equal(ui.document.querySelector('[role="timer"] .stopwatch-time')!.textContent,'Checking…');
    assert.match(ui.document.querySelector('.draft-off-notice')!.textContent!,/Checking final status with the server/);
    assert.equal(ui.document.querySelector('#final-leaderboard'),null);
  }finally{await ui.close();}
});

test("a new spin plays the reel over a decided result; a restored one does not", async () => {
  const value=snapshot(startedState()),ui=await mount(value);
  try {
    const tokens=ui.document.createElement('style');tokens.textContent=':root{--motion-spin:60000ms}';ui.document.head.append(tokens);
    assert.equal(ui.document.querySelector('button.spin-reel'),null);
    assert.ok(ui.document.querySelector('.spin-stage .spin-reel-rest'),'the reel waits at rest on the spin stage');
    await ui.render(roomState(snapshot(spun())));
    const reel=ui.document.querySelector('button.spin-reel');
    assert.ok(reel,'the reel plays when the spin arrives');
    assert.equal(ui.document.querySelector('.squad-row'),null,'the squad waits for the result');
    assert.equal(ui.document.activeElement,reel);
    await ui.click('button.spin-reel');
    assert.equal(ui.document.querySelector('button.spin-reel'),null,'a tap lands immediately');
    assert.ok(ui.document.querySelector('.squad-rows-entering .squad-row'),'and the rows stagger in');
    assert.equal(ui.document.activeElement,ui.document.getElementById('draft-stage-title'));
  }finally{await ui.close();}
  const restored=await mount(snapshot(spun()));
  try {
    assert.equal(restored.document.querySelector('button.spin-reel'),null);
    assert.equal(restored.document.querySelector('.squad-rows-entering'),null);
    assert.ok(restored.document.querySelector('.squad-row'));
  }finally{await restored.close();}
});

function deferredCommand() {
  const commands: PublicCommand["command"][] = [];
  let settle!: () => void;
  const command = async (next: PublicCommand["command"]) => { commands.push(next); await new Promise<void>(resolve => { settle = resolve; }); };
  return { commands, command, settle: () => settle() };
}
async function previewFirst(ui: Awaited<ReturnType<typeof mount>>) {
  await ui.click('.squad-row:not([aria-disabled="true"])');
  const id = ui.document.querySelector<HTMLElement>(".squad-row-selected")!.dataset.candidateId!;
  const slot = ui.document.querySelector<HTMLButtonElement>(".xi-slot-active:not(:disabled)")!;
  const position = Number(slot.closest<HTMLElement>(".xi-slot")!.dataset.position);
  await act(async () => slot.click());
  return { id, position };
}
const announced = (ui: Awaited<ReturnType<typeof mount>>) => ui.document.querySelector(".drafting .sr-status[aria-live]")!.textContent!;

test("an optimistic lock lands in its slot at once, pending with no lock edge, and the confirmation adds the edge", async () => {
  const state = spun(), value = snapshot(state), send = deferredCommand();
  const ui = await mount(value, false, send.command);
  try {
    const { id, position } = await previewFirst(ui);
    await ui.click(".drafting-lock");
    // Before the room has even published its pending state.
    const slot = ui.document.querySelector<HTMLElement>(`.xi-slot[data-position="${position}"]`)!;
    const card = slot.querySelector(".player-card-state-pending")!;
    assert.match(card.textContent!, /Locking…/);
    assert.match(card.getAttribute("aria-label")!, new RegExp(`position ${position}, locking, waiting for the server, `));
    assert.equal(slot.querySelector(".player-card-state-edge"), null, "pending never looks locked");
    assert.equal(ui.document.activeElement, slot, "focus follows the card into its slot");
    assert.match(announced(ui), new RegExp(`^Locking .+ in position ${position}\\. Waiting for the server\\.$`));
    assert.ok(ui.document.querySelector(".drafting-dock-card")!.classList.contains("drafting-card-sent"), "the card has left the dock");
    assert.equal(ui.document.querySelector<HTMLButtonElement>(".drafting-clear")!.disabled, true, "going back waits");
    assert.equal(ui.document.querySelector(".drafting-lock")!.textContent, "Waiting for server…");
    assert.ok([...ui.document.querySelectorAll<HTMLButtonElement>(".squad-row")].every(row => row.closest("fieldset")!.disabled));
    await ui.render({ ...roomState(value), pending: true, pendingCommand: "LOCK_PLAYER" });
    assert.ok(slot.querySelector(".player-card-state-pending"));
    await ui.click(".drafting-lock");
    assert.equal(send.commands.length, 1, "one intent, nothing extra");
    const confirmed = changed(state, { type: "APPLY_DRAFT_COMMAND", participantId: "host", atMs: 20, expectedDraftRevision: participant(state, "host").draftState.revision, draftCommand: { type: "LOCK_PLAYER", playerTeamSeasonId: id, battingPosition: position } });
    await ui.render({ ...roomState(snapshot(confirmed)), pending: true, pendingCommand: "LOCK_PLAYER" });
    const locked = ui.document.querySelector(`.xi-slot[data-position="${position}"] .player-card-state-locked`)!;
    assert.ok(locked.querySelector(".player-card-state-edge"), "the ivory edge arrives with the confirmation");
    assert.match(locked.getAttribute("aria-label")!, new RegExp(`position ${position}, confirmed, `));
    assert.match(announced(ui), /^Pick 1 locked\. Spin again\.$/);
    assert.equal(ui.document.querySelector<HTMLButtonElement>(".drafting-primary")!.disabled, true, "Spin waits for the room");
    send.settle(); await ui.render(roomState(snapshot(confirmed)));
    assert.equal(ui.document.activeElement, ui.document.querySelector(".drafting-primary"), "focus reaches Spin once the room is free");
    assert.equal(ui.document.querySelector(".drafting-rejected"), null);
    assert.equal(send.commands.length, 1);
  } finally { await ui.close(); }
});

test("a rejected optimistic lock snaps back to the dock, reopens the slot and says why", async () => {
  const value = snapshot(spun()), send = deferredCommand();
  const ui = await mount(value, false, send.command);
  try {
    const { position } = await previewFirst(ui);
    await ui.click(".drafting-lock");
    await ui.render({ ...roomState(value), pending: true, pendingCommand: "LOCK_PLAYER" });
    // The room's pending ends before the send settles: still waiting.
    await ui.render({ ...roomState(value), error: "Action rejected" });
    assert.ok(ui.document.querySelector(".xi-board .player-card-state-pending"));
    await act(async () => { send.settle(); await Promise.resolve(); });
    assert.equal(ui.document.querySelector(".xi-board .player-card-state-pending"), null);
    const reopened = ui.document.querySelector<HTMLButtonElement>(`.xi-slot[data-position="${position}"] .xi-open-slot`)!;
    assert.equal(reopened.disabled, false, "the slot reopens");
    const dock = ui.document.querySelector(".drafting-dock-card")!;
    assert.ok(dock.classList.contains("drafting-card-returned") && !dock.classList.contains("drafting-card-sent"), "the card is back in the dock");
    assert.ok(dock.querySelector(".player-card-state-selected"));
    assert.equal(ui.document.querySelector(".drafting-rejected")!.textContent, "⚠ Not locked · Not accepted, try again");
    assert.match(announced(ui), new RegExp(`was not locked in position ${position}\\. Not accepted, try again\\. The slot is open again\\.$`));
    assert.equal(ui.document.activeElement, dock);
    assert.equal(ui.document.querySelector(".drafting-lock")!.textContent, "Lock");
    assert.ok(ui.document.querySelector(".draft-off-recovery"), "the room's recovery stays as it was");
    // Choosing the slot again clears the reason; nothing was resent.
    await act(async () => reopened.click());
    assert.equal(ui.document.querySelector(".drafting-rejected"), null);
    assert.equal(send.commands.length, 1);
  } finally { await ui.close(); }
});

test("a transport failure keeps the card pending in its slot with the saved retry", async () => {
  const value = snapshot(spun()), send = deferredCommand();
  const ui = await mount(value, true, send.command);
  try {
    await ui.click('.squad-row:not([aria-disabled="true"])');
    await ui.click(".drafting-place");
    await ui.click(".xi-slot-active:not(:disabled)");
    await ui.click(".drafting-lock");
    assert.ok(ui.document.querySelector(".drafting-bar .drafting-card-sent"), "the bar's card has gone to its slot");
    assert.equal(ui.document.querySelector<HTMLButtonElement>(".drafting-back")!.disabled, true);
    // The session's order: pending, then the uncertain reply keeps the saved intent, then the send returns.
    await ui.render({ ...roomState(value), pending: true, pendingCommand: "LOCK_PLAYER" });
    await ui.render({ ...roomState(value), pending: true, pendingCommand: "LOCK_PLAYER", retryAvailable: true, error: "Uncertain" });
    await act(async () => { send.settle(); await Promise.resolve(); });
    assert.ok(ui.document.querySelector(".xi-board .player-card-state-pending"), "uncertain is still pending, never rejected");
    assert.equal(ui.document.querySelector(".xi-board .player-card-state-edge"), null);
    assert.ok([...ui.document.querySelectorAll("button")].some(button => button.textContent === "Retry saved action"));
  } finally { await ui.close(); }
});

test("tier-cap chips appear only for capped rooms; the clock keeps fixed digits and names its state", async () => {
  const uncapped = await mount(snapshot(spun()));
  try {
    const chips = [...uncapped.document.querySelectorAll(".xi-limits .xi-limit")].map(chip => chip.querySelector(".sr-status")!.textContent);
    assert.deepEqual(chips, ["Overseas 0 of 4", "Wicketkeeper needed"]);
  } finally { await uncapped.close(); }
  let capped = startRoom(roomLobby("era-transition", "VARIED", 2));
  capped = roomApply(capped, { type: "APPLY_DRAFT_COMMAND", participantId: participantId(1), atMs: 20, expectedDraftRevision: draftOf(capped, participantId(1)).revision, draftCommand: { type: "SPIN" } });
  const value = snapshot(capped, participantId(1));
  Object.assign(value.view.round, { deadlineAtMs: 20 + 90_000 });
  const ui = await mount(value, true);
  try {
    const strip = ui.document.querySelector(".xi-strip-pinned .xi-limits")!;
    assert.deepEqual([...strip.querySelectorAll(".xi-limit-face")].map(face => face.textContent), ["OS 0/4", "WK needed", "S 0/3", "S+A 0/6"]);
    assert.ok(strip.querySelector(".xi-limit-keeper.xi-limit-needed"));
    assert.equal(strip.querySelectorAll(".xi-limit-sa .xi-limit-swatch").length, 2);
    const timer = ui.document.querySelector('[role="timer"]')!;
    assert.ok(timer.classList.contains("stopwatch-amber"));
    assert.equal(timer.getAttribute("aria-label"), "01:30 remaining");
    assert.equal(timer.querySelector(".stopwatch-label")!.textContent, "2 min or less");
    assert.deepEqual([...timer.querySelectorAll(".stopwatch-digit")].map(digit => digit.textContent), ["0", "1", "3", "0"]);
  } finally { await ui.close(); }
  assert.deepEqual([600_000, 120_001, 120_000, 30_001, 30_000, 1, 0, null].map(draftClockState), ["normal", "normal", "amber", "amber", "red", "red", "checking", "normal"]);
});

test("a draft that moves on elsewhere while a lock is out drops the pending card and says so", async () => {
  const value = snapshot(spun()), send = deferredCommand();
  const ui = await mount(value, false, send.command);
  try {
    const { position } = await previewFirst(ui);
    const name = ui.document.querySelector(".drafting-dock .player-card-name")!.textContent!;
    await ui.click(".drafting-lock");
    await ui.render({ ...roomState(value), pending: true, pendingCommand: "LOCK_PLAYER" });
    const moved = structuredClone(value); assert.ok(moved.view.myDraft); Object.assign(moved.view.myDraft, { revision: moved.view.myDraft.revision + 1 });
    await ui.render(roomState(moved));
    assert.equal(ui.document.querySelector(".xi-board .player-card-state-pending"), null);
    assert.equal(ui.document.querySelector(".xi-board .player-card-state-locked"), null, "nothing is shown as locked that the server did not lock");
    assert.equal(announced(ui), `${name} was not locked in position ${position}. Your draft changed in another tab. The slot is open again.`);
    assert.equal(send.commands.length, 1);
  } finally { await ui.close(); }
});
