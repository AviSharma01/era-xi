import { draftOffFormatDescription, draftOffFormatLabel } from "./draftOffFormat.js";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { SnapshotSuccess, PublicCommand } from "./draftOffClientTypes.js";
import type { DraftOffSessionState } from "./draftOffSession.js";
import type { DraftOffPublicRoomView } from "./draftOffRoomTypes.js";
import type { DraftPickView, EraDraftPublicView } from "./eraDraftTypes.js";
import type { EraDraftTierCaps } from "./eraDraftTierCaps.js";
import { PlayerInspector, fitLabel } from "./eraDraftPlayerPresentation.js";
import { PlayerCard, playerCardName } from "./components/PlayerCard.js";
import { CLOCK_COPY, DRAFTING_COPY, ERA_COPY } from "./copy.js";
import { DraftingWorkspace } from "./screens/drafting/DraftingWorkspace.js";
import { appRoutePath, draftOffRoomPath } from "./webRoutes.js";
import { DraftOffComparison, DraftOffResultsBrowser, type ResultsLoader } from "./draftOffResults.js";

export const DRAFT_OFF_ERA_LABELS = {
  "era-foundation": "Foundation · 2008–2010", "era-expansion": "Expansion · 2011–2013",
  "era-transition": "Transition · 2014–2017", "era-modern-pre-impact": "Modern Pre-Impact · 2018–2022", "era-impact": "Impact · 2023–2026",
} as const;

type Command = PublicCommand["command"];
type ActiveDraft = Exclude<EraDraftPublicView, { phase: "SETUP" }>;
export type DraftOffRoomActions = { command: (command: Command) => Promise<void>; retry: () => Promise<void>; resync: () => Promise<void>;
  loadResults?: ResultsLoader; resultsRetryAtMs?: () => number; subscribeResultsCooldown?: (listener: () => void) => () => void };
const INITIAL_ROOM: DraftOffSessionState = { snapshot: null, pending: false, error: null, accessUnavailable: false };
export { INITIAL_ROOM };

/** Presentation clock only. It cannot submit, exclude, resolve or publish room state. */
export function remainingDraftMs(deadline: number | undefined, serverTime: number, elapsed: number): number | null {
  return deadline === undefined ? null : Math.max(0, deadline - serverTime - Math.max(0, elapsed));
}
export function formatDraftCountdown(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  const seconds = Math.ceil(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
type ClockState = "normal" | "amber" | "red" | "checking";
/** Amber at 2:00 or less, red at 0:30 or less, grey while the server checks at zero. */
export function draftClockState(milliseconds: number | null): ClockState {
  if (milliseconds === null) return "normal";
  return milliseconds <= 0 ? "checking" : milliseconds <= 30_000 ? "red" : milliseconds <= 120_000 ? "amber" : "normal";
}
const CLOCK_LABELS: Readonly<Record<ClockState, string>> = { normal: CLOCK_COPY.normal, amber: CLOCK_COPY.amber, red: CLOCK_COPY.red, checking: CLOCK_COPY.timeUp };
/** The room clock: each digit in a fixed-width box so it never jitters, and a text label beside the colour. */
function Stopwatch({ remaining }: { remaining: number | null }) {
  const state = draftClockState(remaining), time = formatDraftCountdown(remaining);
  return <div className={`room-countdown stopwatch stopwatch-${state}`} role="timer" aria-label={CLOCK_COPY.label(time, state === "checking")}>
    <span className="stopwatch-label" aria-hidden="true">{CLOCK_LABELS[state]}</span>
    <strong className="stopwatch-time" aria-hidden="true">{state === "checking" ? CLOCK_COPY.checking
      : [...time].map((char, index) => <span key={index} className={/\d/.test(char) ? "stopwatch-digit" : "stopwatch-separator"}>{char}</span>)}</strong>
  </div>;
}
function useCountdown(snapshot: SnapshotSuccess | null) {
  const anchor = useMemo(() => ({ server: snapshot?.serverTimeMs ?? 0, local: performance.now() }), [snapshot]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (snapshot?.view.phase !== "IN_PROGRESS") return;
    const timer = setInterval(() => setTick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [snapshot?.view.phase]);
  void tick;
  return remainingDraftMs(snapshot?.view.round.deadlineAtMs, anchor.server, performance.now() - anchor.local);
}

export function DraftOffRoomExperience({ code, state, actions }: {
  code: string; state: DraftOffSessionState; actions: DraftOffRoomActions;
}) {
  const snapshot = state.snapshot, remaining = useCountdown(snapshot);
  const roomRef = useRef<HTMLDivElement>(null), barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!snapshot || !barRef.current) return;
    const measure = () => roomRef.current?.style.setProperty("--room-bar-height", `${barRef.current!.getBoundingClientRect().height}px`);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure); observer.observe(barRef.current);
    return () => observer.disconnect();
  }, [!!snapshot]);
  const [localError, setLocalError] = useState<string | null>(null);
  const sending = useRef(false);
  const send = async (command: Command) => {
    if (sending.current || state.pending || state.accessUnavailable) return;
    sending.current = true; setLocalError(null);
    try { await actions.command(command); }
    catch { setLocalError("This action could not start. Refresh the room or recover the saved action before trying again."); }
    finally { sending.current = false; }
  };
  useEffect(() => setLocalError(null), [snapshot?.view.revision]);
  if (!snapshot) return <section className="draft-off-panel"><p className="eyebrow">Room {code}</p><h1>{state.accessUnavailable ? "Room access unavailable" : "Restoring your room"}</h1>
    <p role="status">{state.error ?? "Checking your identity and current room state…"}</p>
    {!state.accessUnavailable && <button className="secondary-action" onClick={() => void actions.resync()}>Refresh room</button>}</section>;
  const view = snapshot.view;
  const publicView = state.publicSnapshot?.view;
  const rosterView = publicView && publicView.round.roundId === view.round.roundId && publicView.revision >= view.revision ? publicView : view;
  const me = view.participants.find(row => row.participantId === snapshot.participantId);
  const submitted = rosterView.participants.filter(row => row.roundStatus === "SUBMITTED").length;
  const entrants = rosterView.participants.filter(row => row.roundStatus !== undefined).length;
  const blocked = state.pending || state.accessUnavailable;
  const expired = view.phase === "IN_PROGRESS" && remaining === 0;
  const quietPending = view.phase === "IN_PROGRESS" && me?.roundStatus === "DRAFTING" && state.pending && !state.retryAvailable && !state.error && !localError && !state.accessUnavailable;
  const stage = view.phase === "LOBBY" ? "Private lobby" : view.phase === "COMPLETE" ? "Final leaderboard" : me?.roundStatus === "SUBMITTED" ? "XI submitted" : "Draft in progress";
  return <div ref={roomRef} className={`draft-off-room room-phase-${view.phase.toLowerCase()}`}>
    <div ref={barRef} className="draft-off-room-bar">
      <div className="room-bar-identity"><p className="eyebrow">{draftOffFormatLabel(view.round.format ?? "MIRROR")} · {stage}</p><strong>{DRAFT_OFF_ERA_LABELS[view.round.eraId]}</strong></div>
      {view.phase === "IN_PROGRESS" && <Stopwatch remaining={remaining} />}
      <details className="room-people"><summary>{view.phase === "LOBBY" ? `${rosterView.participants.filter(row => row.membershipStatus === "JOINED").length}/8 players` : `${submitted}/${entrants} submitted`}</summary><ParticipantList view={rosterView} me={snapshot.participantId} /></details>
    </div>
    <p className="sr-status" aria-live="polite">{view.phase === "IN_PROGRESS" && (expired ? "Draft time reached. Checking the server for final status." : remaining !== null && remaining <= 30_000 ? "Thirty seconds or less remaining." : remaining !== null && remaining <= 120_000 ? "Two minutes or less remaining." : "Draft clock running.")}</p>
    {/* A plain wait shows on the thing being changed, so the XI never resizes for it; the room's status still announces it. */}
    {(state.pending || state.error || localError || state.accessUnavailable) && <div className={`draft-off-recovery${quietPending ? " sr-status" : ""}`} role="status" aria-live="polite">
      <span>{state.pending ? state.retryAvailable ? "Action not yet confirmed. Your exact saved intent is preserved." : state.pendingCommand ? `${actionLabel(state.pendingCommand)}…` : "Refreshing authoritative room state…" : state.error ?? localError}</span>
      {state.pending && state.error && <span>{state.error}</span>}
      {!state.accessUnavailable && !quietPending && <div><button className="secondary-action" onClick={() => void actions.resync()}>Refresh room</button>
        {state.retryAvailable && <button className="primary-action" onClick={() => void actions.retry()}>Retry saved action</button>}</div>}
    </div>}
    {view.phase === "LOBBY" ? <Lobby snapshot={snapshot} code={code} blocked={blocked} onCommand={send} />
      : view.phase === "COMPLETE" ? <FinalResults key={`${code}:${view.round.roundId}:${snapshot.participantId}`} snapshot={snapshot} code={code} actions={actions} accessUnavailable={state.accessUnavailable} />
        : me?.roundStatus === "SUBMITTED" ? <Waiting snapshot={snapshot} rosterView={rosterView} expired={expired} countdown={formatDraftCountdown(remaining)} />
          : me?.roundStatus === "DRAFTING" && view.myDraft && view.myDraft.phase !== "SETUP" ? <DraftWorkspace key={view.round.roundId} draft={view.myDraft} blocked={blocked || expired} locking={state.pending && state.pendingCommand === "LOCK_PLAYER"} onCommand={send} expired={expired} countdown={formatDraftCountdown(remaining)} tierCaps={view.round.tierCaps} />
            : <section className="draft-off-panel"><h1>You’re outside this round</h1><p>You left before the host started. The roster is now fixed. You can still see public room status and the final leaderboard.</p></section>}
    {expired && <p className="draft-off-notice" role="status">Time reached. Checking final status with the server. Complete legal XIs auto-submit; incomplete XIs are excluded.</p>}
  </div>;
}
function actionLabel(type: Command["type"]) {
  return ({ START: "Starting the round", LEAVE: "Leaving the lobby", REJOIN: "Rejoining the lobby", SPIN: "Spinning franchise", RESPIN: "Using your respin", LOCK_PLAYER: "Confirming your pick", SUBMIT: "Submitting your XI" })[type];
}
function ParticipantList({ view, me }: { view: DraftOffPublicRoomView; me: string }) {
  return <ul className="draft-off-members">{view.participants.map(row => <li key={row.participantId}><strong>{row.displayName}<small>{row.participantId === me ? "You" : ""}{row.role === "HOST" ? " · Host" : ""}</small></strong>
    <span>{row.lockedPickCount !== undefined && <>{row.lockedPickCount}/11 · </>}{row.roundStatus === "SUBMITTED" ? "Submitted" : row.roundStatus === "DRAFTING" ? "Drafting" : row.roundStatus === "INELIGIBLE" ? "Incomplete" : row.membershipStatus === "LEFT" ? "Left lobby" : "Joined"}</span></li>)}</ul>;
}
function Invite({ code }: { code: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const path = draftOffRoomPath(code, import.meta.env?.BASE_URL ?? "/");
  const url = typeof window === "undefined" ? path : new URL(path, window.location.origin).href;
  return <div className="room-invite"><span>Private room code</span><strong>{code}</strong><button className="secondary-action" onClick={() => {
    if (!navigator.clipboard) { setMessage("Select and copy the invite link below."); return; }
    void navigator.clipboard.writeText(url).then(() => setMessage("Invite link copied."), () => setMessage("Select and copy the invite link below."));
  }}>Copy invite link</button><label className="room-invite-link">Invite link<input readOnly value={url} onFocus={event => event.currentTarget.select()} /></label>{message && <p role="status">{message}</p>}</div>;
}
function Lobby({ snapshot, code, blocked, onCommand }: { snapshot: SnapshotSuccess; code: string; blocked: boolean; onCommand: (command: Command) => Promise<void> }) {
  const me = snapshot.view.participants.find(row => row.participantId === snapshot.participantId)!;
  const joined = snapshot.view.participants.filter(row => row.membershipStatus === "JOINED").length;
  return <div className="room-lobby-layout"><section className="draft-off-panel room-lobby-main"><p className="eyebrow">The challenge</p><h1>Same era. Your own XI.</h1>
    <p>{draftOffFormatDescription(snapshot.view.round.format ?? "MIRROR")}</p>
    <p>Build eleven players against one shared deadline, then face the same twenty historical fixtures. Points first, net run rate breaks the tie.</p>
    <div className="room-settings"><div><span>Era</span><strong>{DRAFT_OFF_ERA_LABELS[snapshot.view.round.eraId]}</strong></div><div><span>Draft clock</span><strong>{snapshot.settings.draftMinutes} minutes</strong></div><div><span>Room</span><strong>{joined} / 8 players</strong></div></div>
    <p className="draft-off-footnote">Era, time and format are fixed. Exactly 11 players · Max 4 overseas · A wicketkeeper · One respin. Every batting position locks.</p>
    <h2>Players</h2><ParticipantList view={snapshot.view} me={snapshot.participantId} />
    {me.role === "HOST" ? <><button className="primary-action" disabled={blocked || joined < 2 || joined > 8} onClick={() => void onCommand({ type: "START" })}>Start {snapshot.settings.draftMinutes}-minute draft</button>
      <p>{joined < 2 ? "Invite at least one more player to start." : "Starting locks the roster and begins the shared clock for everyone."}</p></>
      : <><p>{me.membershipStatus === "LEFT" ? "You left this lobby. Your name and identity are reserved; rejoin before the host starts." : "Waiting for the host to start. You can close this page and return using the same browser."}</p>
        <button className="secondary-action" disabled={blocked} onClick={() => void onCommand({ type: me.membershipStatus === "LEFT" ? "REJOIN" : "LEAVE" })}>{me.membershipStatus === "LEFT" ? "Rejoin lobby" : "Leave lobby"}</button></>}
  </section><aside className="draft-off-panel"><Invite code={code} /><p className="draft-off-footnote">An invite grants room entry, not access to another player’s private draft. Each player uses a separate browser context or device.</p></aside></div>;
}
function Dialog({ title, children, onClose, className = "", countdown }: { title: string; children: ReactNode; onClose: () => void; className?: string; countdown?: string }) {
  const ref = useRef<HTMLDialogElement>(null), opener = useRef<HTMLElement | null>(null), id = useId();
  useEffect(() => {
    opener.current ??= document.activeElement as HTMLElement | null;
    ref.current?.showModal(); ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { const target = opener.current; requestAnimationFrame(() => { if (!ref.current?.open && target?.isConnected) target.focus(); }); };
  }, []);
  return <dialog ref={ref} className={`room-dialog ${className}`} aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
    <header><h2 id={id}>{title}</h2>{countdown && <span className="room-sheet-clock" role="timer" aria-label={`${countdown} remaining`}>{countdown}</span>}<button className="quiet-button" onClick={onClose}>Close</button></header>{countdown === "00:00" && <p role="status">Time reached. Checking final status with the server.</p>}{children}
  </dialog>;
}
function CompactXi({ draft, onInspect }: { draft: ActiveDraft; onInspect: (player: DraftPickView) => void }) {
  return <section className="room-xi" aria-label="Your batting order"><div className="room-xi-heading"><h2>Your XI</h2><span>{draft.status.pickCount} / 11 locked</span></div>
    <div className="room-xi-status"><span>Overseas <strong>{draft.status.overseasCount}/4</strong></span><span>Keeper <strong>{draft.status.hasWicketkeeper ? "Covered" : "Needed"}</strong></span></div>
    <ol>{Array.from({ length: 11 }, (_, index) => index + 1).map(position => {
      const pick = draft.picks.find(row => row.battingPosition === position);
      return <li key={position} className={pick ? "room-slot-locked" : ""}><span className="room-slot-number">{String(position).padStart(2, "0")}</span>
        {pick ? <PlayerCard size="mini" state="locked" player={pick} order={position - 1} fit={pick.presentationFit} className="room-locked-player" label={`Inspect ${playerCardName(pick)}, position ${position}, ${fitLabel(pick.presentationFit)}`} onClick={() => onInspect(pick)} />
          : <span className="room-slot-empty">Open batting position</span>}
      </li>;
    })}</ol>
  </section>;
}
function DraftWorkspace({ draft, blocked, locking, expired, countdown, tierCaps, onCommand }: { draft: ActiveDraft; blocked: boolean; locking: boolean; expired: boolean; countdown: string; tierCaps?: EraDraftTierCaps; onCommand: (command: Command) => Promise<void> }) {
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  useEffect(() => setConfirmSubmit(false), [draft.revision]);
  return <>
    <DraftingWorkspace draft={draft} blocked={blocked} locking={locking} expired={expired} countdown={countdown} squadHint={DRAFTING_COPY.squadEmptyPrivate}
      optimisticLock tierCaps={tierCaps} onCommand={command => onCommand(command)}
      complete={{
        title: DRAFTING_COPY.roomCompleteTitle,
        detail: <div className="room-complete"><p className="eyebrow">{DRAFTING_COPY.roomCompleteCount}</p><p>{DRAFTING_COPY.roomCompleteAutoSubmit}</p><p>{DRAFTING_COPY.roomCompleteHidden}</p></div>,
        action: ref => <button ref={ref} className="primary-action drafting-primary" disabled={blocked} onClick={() => setConfirmSubmit(true)}>{DRAFTING_COPY.roomSubmit}</button>,
      }} />
    {expired && <p className="draft-off-footnote">Checking the server’s deadline decision…</p>}
    {confirmSubmit && <Dialog title="Submit and lock your XI?" countdown={countdown} onClose={() => setConfirmSubmit(false)}><p>Submission is final. Your eleven players and batting positions will be frozen while the room finishes.</p><p>Results arrive when everyone submits or the shared deadline passes.</p><button className="primary-action" disabled={blocked} onClick={() => { setConfirmSubmit(false); void onCommand({ type: "SUBMIT" }); }}>Submit and lock XI</button><button className="secondary-action" onClick={() => setConfirmSubmit(false)}>Keep reviewing</button></Dialog>}
  </>;
}
function Waiting({ snapshot, rosterView, expired, countdown }: { snapshot: SnapshotSuccess; rosterView: DraftOffPublicRoomView; expired: boolean; countdown: string }) {
  const [inspected, setInspected] = useState<DraftPickView | null>(null);
  const draft = snapshot.view.myDraft;
  return <div className="room-waiting-layout"><section className="draft-off-panel"><p className="eyebrow">Submission confirmed</p><h1>Your XI is locked in.</h1><p>{expired ? "Checking the final result with the server." : "The room is still drafting. Results arrive when everyone submits or time runs out."}</p><p>Your submission is final. Private XIs and ratings remain hidden.</p><ParticipantList view={rosterView} me={snapshot.participantId} /></section>
    {draft && draft.phase !== "SETUP" && <CompactXi draft={draft} onInspect={setInspected} />}{inspected && <PlayerInspector player={inspected} eraTitle={draft && draft.phase !== "SETUP" ? ERA_COPY[draft.eraId].title : undefined} countdown={countdown} onClose={() => setInspected(null)} />}</div>;
}
const noCooldown = () => 0;
function FinalResults({ snapshot, code, actions, accessUnavailable }: { snapshot: SnapshotSuccess; code: string; actions: DraftOffRoomActions; accessUnavailable: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [pair, setPair] = useState<[string, string] | null>(null);
  const result = snapshot.view.resolution, round = snapshot.view.round;
  const entrant = snapshot.view.participants.find(row => row.participantId === snapshot.participantId)?.roundStatus !== undefined;
  const rows = result?.leaderboard ?? [];
  const selected = rows.find(row => row.participantId === selectedId) ?? rows.find(row => row.participantId === snapshot.participantId) ?? rows[0];
  const available = entrant && !accessUnavailable && !!actions.loadResults && round.phase === "RESOLVED";
  const select = (id: string) => {
    setSelectedId(id); setCompare(false);
    requestAnimationFrame(() => {
      const heading = document.getElementById("participant-results-title");
      heading?.focus({ preventScroll: true });
      heading?.closest(".room-participant-results")?.scrollIntoView?.({ block: "start" });
    });
  };
  const first = rows.find(row => row.participantId === pair?.[0]) ?? selected;
  const second = rows.find(row => row.participantId === pair?.[1] && row !== first) ?? rows.find(row => row !== first);
  const identity = { roomCode: code, roundId: round.roundId, roundOrdinal: round.roundOrdinal, eraId: round.eraId };
  return <>
    <Leaderboard snapshot={snapshot} selectedId={available ? selected?.participantId : undefined} onSelect={available ? select : undefined} />
    {available && rows.length > 0 && <section id="comparison-selection" tabIndex={-1} className="draft-off-panel room-results-controls" aria-label="Results views">
      <div className="draft-off-tabs"><button className="secondary-action" aria-pressed={!compare} onClick={() => setCompare(false)}>Individual results</button><button className="secondary-action" aria-pressed={compare} disabled={rows.length < 2} onClick={() => setCompare(true)}>Compare two XIs</button></div>
      {rows.length < 2 && <p>Comparison needs two eligible submitted XIs. You can inspect the eligible XI below.</p>}
      {compare && first && second && <div className="room-comparison-selectors">
        {([first, second] as const).map((entry, i) => <label key={i}>XI {i === 0 ? "A" : "B"}<select value={entry.participantId} onChange={event => setPair(i === 0 ? [event.target.value, second.participantId] : [first.participantId, event.target.value])}>
          {rows.map(row => <option key={row.participantId} value={row.participantId} disabled={row.participantId === (i === 0 ? second : first).participantId}>{row.displayName} · Rank {row.rank}</option>)}
        </select></label>)}
        <button className="secondary-action" onClick={() => setPair([second.participantId, first.participantId])}>Swap XIs</button>
      </div>}
    </section>}
    {available && compare && first && second && <DraftOffComparison identity={identity} entries={[first, second]} loadResults={actions.loadResults!} retryAtMs={actions.resultsRetryAtMs ?? noCooldown} subscribeCooldown={actions.subscribeResultsCooldown} />}
    {available && !compare && selected && <DraftOffResultsBrowser key={selected.participantId} identity={{ roomCode: code, roundId: round.roundId,
      roundOrdinal: round.roundOrdinal, eraId: round.eraId, participantId: selected.participantId }} displayName={selected.displayName}
      loadResults={actions.loadResults!} retryAtMs={actions.resultsRetryAtMs ?? noCooldown} subscribeCooldown={actions.subscribeResultsCooldown} />}
  </>;
}
function Leaderboard({ snapshot, selectedId, onSelect }: { snapshot: SnapshotSuccess; selectedId?: string; onSelect?: (id: string) => void }) {
  const result = snapshot.view.resolution;
  if (!result) return <section className="draft-off-panel"><h1>Checking results</h1><p>Refresh the room to load the authoritative leaderboard.</p></section>;
  const mine = snapshot.view.participants.find(row => row.participantId === snapshot.participantId);
  const title = result.contestStatus === "NO_CONTEST" ? "No eligible XIs this round." : result.contestStatus === "UNCONTESTED" ? "An uncontested result." : "The room has its result.";
  return <section id="final-leaderboard" className="draft-off-panel room-results"><p className="eyebrow">Draft-Off · Final leaderboard</p><h1>{title}</h1>
    <p>{result.contestStatus === "NO_CONTEST" ? "No one completed a legal XI before the deadline, so no campaigns were simulated." : result.contestStatus === "UNCONTESTED" ? "Only one XI was eligible. Its twenty-match campaign is shown without a contested victory." : "Every eligible XI faced the same twenty historical fixtures in the same order."}</p>
    {mine?.roundStatus === "INELIGIBLE" && <p className="draft-off-notice">Your XI was incomplete at the deadline and was excluded from the leaderboard.</p>}
    {result.leaderboard.length > 0 && <><div className="room-leaderboard-scroll"><table><caption>Ranked by points, then full-precision net run rate. Exact ties share rank.</caption><thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">P</th><th scope="col">W</th><th scope="col">L</th><th scope="col">Pts</th><th scope="col">NRR</th></tr></thead>
      <tbody>{result.leaderboard.map(row => <tr key={row.participantId} className={row.participantId === snapshot.participantId ? "room-my-result" : undefined}><td data-label="Rank">{row.rank}</td><th scope="row">{row.displayName}{row.participantId === snapshot.participantId && <small>You</small>}{onSelect && <button className="room-view-results" aria-pressed={row.participantId === selectedId} aria-label={`View ${row.displayName} results`} onClick={() => onSelect(row.participantId)}>{row.participantId === selectedId ? "Viewing results" : "View results"}</button>}</th><td data-label="Played">{row.played}</td><td data-label="Won">{row.won}</td><td data-label="Lost">{row.lost}</td><td data-label="Points"><strong>{row.points}</strong></td><td data-label="NRR">{row.netRunRate >= 0 ? "+" : ""}{row.netRunRate.toFixed(3)}</td></tr>)}</tbody></table></div><p className="draft-off-footnote">Displayed NRR is rounded; ranking uses the backend’s full precision.</p></>}
    {result.ineligibleParticipantIds.length > 0 && <p>{result.ineligibleParticipantIds.length} {result.ineligibleParticipantIds.length === 1 ? "incomplete XI was" : "incomplete XIs were"} excluded at the deadline.</p>}
    <p className="draft-off-footnote">{result.trigger === "ALL_SUBMITTED" ? "Resolved early: every entrant submitted." : "Resolved at the shared deadline."} Start a new private room for another challenge.</p><a className="secondary-action" href={appRoutePath("DRAFT_OFF", import.meta.env?.BASE_URL ?? "/")}>New Draft-Off room</a>
  </section>;
}
