import { draftOffFormatDescription, draftOffFormatLabel } from "./draftOffFormat.js";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { SnapshotSuccess, PublicCommand } from "./draftOffClientTypes.js";
import type { DraftOffSessionState } from "./draftOffSession.js";
import type { DraftOffRoomView } from "./draftOffRoomTypes.js";
import type { DraftCandidateIdentityView, DraftPickView, EraDraftPublicView } from "./eraDraftTypes.js";
import { CandidateGallery, SelectedPlayerDetail, PlayerInspector, FitBadge, fitLabel, friendly } from "./eraDraftPlayerPresentation.js";
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
function useSmallScreen() {
  const [small, setSmall] = useState(() => typeof matchMedia === "function" && matchMedia("(max-width: 899px)").matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(max-width: 899px)");
    const update = () => setSmall(query.matches); update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return small;
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
  const me = view.participants.find(row => row.participantId === snapshot.participantId);
  const submitted = view.participants.filter(row => row.roundStatus === "SUBMITTED").length;
  const entrants = view.participants.filter(row => row.roundStatus !== undefined).length;
  const blocked = state.pending || state.accessUnavailable;
  const expired = view.phase === "IN_PROGRESS" && remaining === 0;
  const stage = view.phase === "LOBBY" ? "Private lobby" : view.phase === "COMPLETE" ? "Final leaderboard" : me?.roundStatus === "SUBMITTED" ? "XI submitted" : "Draft in progress";
  return <div ref={roomRef} className={`draft-off-room room-phase-${view.phase.toLowerCase()}`}>
    <div ref={barRef} className={`draft-off-room-bar${remaining !== null && remaining <= 30_000 ? " clock-urgent" : remaining !== null && remaining <= 120_000 ? " clock-warning" : ""}`}>
      <div className="room-bar-identity"><p className="eyebrow">{draftOffFormatLabel(view.round.format ?? "MIRROR")} · {stage}</p><strong>{DRAFT_OFF_ERA_LABELS[view.round.eraId]}</strong></div>
      {view.phase === "IN_PROGRESS" && <div className="room-countdown" role="timer" aria-label={`${formatDraftCountdown(remaining)} remaining`}><span>Time remaining</span><strong>{formatDraftCountdown(remaining)}</strong></div>}
      <details className="room-people"><summary>{view.phase === "LOBBY" ? `${view.participants.filter(row => row.membershipStatus === "JOINED").length}/8 players` : `${submitted}/${entrants} submitted`}</summary><ParticipantList view={view} me={snapshot.participantId} /></details>
    </div>
    <p className="sr-status" aria-live="polite">{view.phase === "IN_PROGRESS" && (expired ? "Draft time reached. Checking the server for final status." : remaining !== null && remaining <= 30_000 ? "Thirty seconds or less remaining." : remaining !== null && remaining <= 120_000 ? "Two minutes or less remaining." : "Draft clock running.")}</p>
    {(state.pending || state.error || localError || state.accessUnavailable) && <div className="draft-off-recovery" role="status" aria-live="polite">
      <span>{state.pending ? state.retryAvailable ? "Action not yet confirmed. Your exact saved intent is preserved." : state.pendingCommand ? `${actionLabel(state.pendingCommand)}…` : "Refreshing authoritative room state…" : state.error ?? localError}</span>
      {state.pending && state.error && <span>{state.error}</span>}
      {!state.accessUnavailable && <div><button className="secondary-action" onClick={() => void actions.resync()}>Refresh room</button>
        {state.retryAvailable && <button className="primary-action" onClick={() => void actions.retry()}>Retry saved action</button>}</div>}
    </div>}
    {view.phase === "LOBBY" ? <Lobby snapshot={snapshot} code={code} blocked={blocked} onCommand={send} />
      : view.phase === "COMPLETE" ? <FinalResults key={`${code}:${view.round.roundId}:${snapshot.participantId}`} snapshot={snapshot} code={code} actions={actions} accessUnavailable={state.accessUnavailable} />
        : me?.roundStatus === "SUBMITTED" ? <Waiting snapshot={snapshot} expired={expired} countdown={formatDraftCountdown(remaining)} />
          : me?.roundStatus === "DRAFTING" && view.myDraft && view.myDraft.phase !== "SETUP" ? <DraftWorkspace key={view.round.roundId} draft={view.myDraft} blocked={blocked || expired} onCommand={send} expired={expired} countdown={formatDraftCountdown(remaining)} />
            : <section className="draft-off-panel"><h1>You’re outside this round</h1><p>You left before the host started. The roster is now fixed. You can still see public room status and the final leaderboard.</p></section>}
    {expired && <p className="draft-off-notice" role="status">Time reached. Checking final status with the server. Complete legal XIs auto-submit; incomplete XIs are excluded.</p>}
  </div>;
}
function actionLabel(type: Command["type"]) {
  return ({ START: "Starting the round", LEAVE: "Leaving the lobby", REJOIN: "Rejoining the lobby", SPIN: "Spinning franchise", RESPIN: "Using your respin", LOCK_PLAYER: "Confirming your pick", SUBMIT: "Submitting your XI" })[type];
}
function ParticipantList({ view, me }: { view: DraftOffRoomView; me: string }) {
  return <ul className="draft-off-members">{view.participants.map(row => <li key={row.participantId}><strong>{row.displayName}<small>{row.participantId === me ? "You" : ""}{row.role === "HOST" ? " · Host" : ""}</small></strong>
    <span>{row.roundStatus === "SUBMITTED" ? "Submitted" : row.roundStatus === "DRAFTING" ? "Drafting" : row.roundStatus === "INELIGIBLE" ? "Incomplete" : row.membershipStatus === "LEFT" ? "Left lobby" : "Joined"}</span></li>)}</ul>;
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
function CompactXi({ draft, selected, preview, onPreview, onInspect, blocked }: {
  draft: ActiveDraft; selected?: DraftCandidateIdentityView; preview: number | null;
  onPreview?: (position: number) => void; onInspect: (player: DraftPickView) => void; blocked?: boolean;
}) {
  return <section className="room-xi" aria-label="Your batting order"><div className="room-xi-heading"><h2>Your XI</h2><span>{draft.status.pickCount} / 11 locked</span></div>
    <div className="room-xi-status"><span>Overseas <strong>{draft.status.overseasCount}/4</strong></span><span>Keeper <strong>{draft.status.hasWicketkeeper ? "Covered" : "Needed"}</strong></span></div>
    <ol>{Array.from({ length: 11 }, (_, index) => index + 1).map(position => {
      const pick = draft.picks.find(row => row.battingPosition === position), option = selected?.positions.find(row => row.battingPosition === position);
      return <li key={position} className={pick ? `room-slot-locked tier-${pick.tierAppearance}` : preview === position ? "room-slot-preview" : ""}><span className="room-slot-number">{String(position).padStart(2, "0")}</span>
        {pick ? <button className="room-locked-player" aria-label={`Inspect ${pick.playerName}, position ${position}`} onClick={() => onInspect(pick)}><strong>{pick.playerName}</strong><small>{pick.teamName} · {pick.seasonYear} · {friendly(pick.displayRole)}</small><FitBadge fit={pick.presentationFit} /></button>
          : selected ? <button className="room-position-option" disabled={blocked || !option?.available} aria-pressed={preview === position} aria-label={`Position ${position}, ${option ? fitLabel(option.presentationFit) : "unavailable"}${option && !option.available ? `, ${option.reasons.map(reason => reason.message).join(". ")}` : ""}`} onClick={() => onPreview?.(position)}>
            <span>{preview === position ? selected.playerName : "Place player"}</span>{option && <FitBadge fit={option.presentationFit} />}{option && !option.available && <small>{option.reasons[0]?.message ?? "Unavailable"}</small>}</button>
            : <span className="room-slot-empty">Open batting position</span>}
      </li>;
    })}</ol>
  </section>;
}
function DraftWorkspace({ draft, blocked, expired, countdown, onCommand }: { draft: ActiveDraft; blocked: boolean; expired: boolean; countdown: string; onCommand: (command: Command) => Promise<void> }) {
  const small = useSmallScreen();
  const [selectedId, setSelectedId] = useState<string | null>(null), [preview, setPreview] = useState<number | null>(null);
  const [inspected, setInspected] = useState<DraftPickView | DraftCandidateIdentityView | null>(null), [showXi, setShowXi] = useState(false), [confirmSubmit, setConfirmSubmit] = useState(false);
  const [notice, setNotice] = useState("Spin a franchise-season to begin.");
  const actionRef = useRef<HTMLButtonElement>(null), previous = useRef(draft.revision);
  useEffect(() => {
    if (previous.current === draft.revision) return;
    previous.current = draft.revision; setSelectedId(null); setPreview(null); setInspected(null); setConfirmSubmit(false); setShowXi(false);
    setNotice(draft.phase === "XI_COMPLETE" ? "Eleven picks locked. Your XI is complete." : draft.phase === "AWAITING_SPIN" ? "Pick locked. Spin the next franchise-season." : "Franchise-season ready. Choose your player.");
    requestAnimationFrame(() => actionRef.current?.focus());
  }, [draft.revision, draft.phase]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !inspected && !showXi && !confirmSubmit) { setSelectedId(null); setPreview(null); } };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, [inspected, showXi, confirmSubmit]);
  const selected = draft.phase === "AWAITING_PICK" ? draft.candidates.find(row => row.playerTeamSeasonId === selectedId) : undefined;
  const option = selected?.positions.find(row => row.battingPosition === preview && row.available);
  const lock = () => { if (!selected || !option || blocked) return; void onCommand({ type: "LOCK_PLAYER", playerTeamSeasonId: selected.playerTeamSeasonId, battingPosition: option.battingPosition }); };
  const confirmation = <button className="primary-action room-confirm-pick" disabled={blocked || !option} onClick={lock}>{blocked && !expired ? "Waiting for server…" : option ? `Confirm pick · Slot ${String(option.battingPosition).padStart(2, "0")}` : "Choose a position"}</button>;
  const xi = <CompactXi draft={draft} selected={selected} preview={preview} blocked={blocked} onPreview={setPreview} onInspect={setInspected} />;
  const submitButton = <button ref={actionRef} className="primary-action" disabled={blocked} onClick={() => setConfirmSubmit(true)}>Submit XI</button>;
  return <>
    <div className="room-draft-actions"><div><strong>{draft.phase === "XI_COMPLETE" ? "XI complete" : `Pick ${String(draft.status.pickCount + 1).padStart(2, "0")} / 11`}</strong><span>{draft.phase === "AWAITING_PICK" ? `${draft.currentSpin.teamName} · ${draft.currentSpin.seasonYear}` : draft.phase === "XI_COMPLETE" ? "Eleven positions locked" : "Your next franchise-season"}</span></div>
      <div>{draft.phase === "AWAITING_SPIN" && <button ref={actionRef} className="primary-action" disabled={blocked} onClick={() => void onCommand({ type: "SPIN" })}>Spin franchise</button>}
        {draft.phase === "AWAITING_PICK" && (draft.status.respinStatus === "AVAILABLE" ? <button ref={actionRef} className="secondary-action" disabled={blocked} onClick={() => void onCommand({ type: "RESPIN" })}>Respin · 1 left</button> : <span>Respin used</span>)}
        {draft.phase === "XI_COMPLETE" && submitButton}
        {!small && selected && confirmation}
        {small && <button className="secondary-action" onClick={() => setShowXi(true)}>Your XI · {draft.status.pickCount}/11</button>}</div></div>
    <div className="room-draft-layout"><section className="room-candidates" aria-label="Draft players" aria-busy={blocked}>
      {draft.phase === "AWAITING_SPIN" && <div className="room-spin-empty"><span aria-hidden="true">{String(draft.status.pickCount + 1).padStart(2, "0")}</span><h1>{draft.status.pickCount ? "Make the next pick count." : "Eleven places. One era."}</h1><p>Spin a franchise-season, choose one historical player and lock an open batting position. Your choices stay private.</p></div>}
      {draft.phase === "AWAITING_PICK" && <><h1 className="room-workspace-title">Choose your player</h1><fieldset disabled={blocked} className="room-candidate-fieldset"><legend className="sr-status">Eligible player-season choices</legend><CandidateGallery view={draft} selectedId={selectedId} onUnavailable={setNotice} onSelect={candidate => { setSelectedId(selectedId === candidate.playerTeamSeasonId ? null : candidate.playerTeamSeasonId); setPreview(null); setNotice(`${candidate.playerName} selected. Choose an open batting position.`); }} /></fieldset>
        {!small && (selected ? <div className="room-selected"><SelectedPlayerDetail candidate={selected} /><button className="quiet-button" onClick={() => setInspected(selected)}>Inspect season</button><p>Select an open position in your XI, then confirm above.</p><button className="quiet-button" onClick={() => { setSelectedId(null); setPreview(null); }}>Cancel selection</button></div> : <p className="draft-off-footnote">Select a player to view their season and choose a batting position.</p>)}</>}
      {draft.phase === "XI_COMPLETE" && <div className="room-complete"><p className="eyebrow">11 / 11 locked</p><h1>Your XI is ready.</h1><p>Submit to freeze your team and wait for the room. If you stay unsubmitted, the backend automatically submits a complete legal XI at the deadline.</p><p>Use Submit XI above when you are ready.</p><p>Ratings and everyone else’s picks stay hidden during drafting.</p></div>}
      {expired && <p>Checking the server’s deadline decision…</p>}
    </section>{!small && xi}</div>
    <p className="sr-status" aria-live="polite">{notice}</p>
    {blocked && !expired && <p role="status" className="draft-off-notice">Waiting for server confirmation. Your XI will update when the action is confirmed.</p>}
    {small && selected && <Dialog title="Place your player" countdown={countdown} className="room-placement-sheet" onClose={() => { setSelectedId(null); setPreview(null); }}><div className="room-placement-body"><SelectedPlayerDetail candidate={selected} />{blocked && !expired && <p role="status">Waiting for server confirmation. Your saved action is preserved.</p>}<button className="quiet-button" onClick={() => setInspected(selected)}>Inspect season</button>{xi}</div><div className="room-sheet-confirm"><div className="room-placement-context"><strong>{selected.playerName}</strong><small>Selected player · {selected.teamName} · {selected.seasonYear}</small></div>{confirmation}</div></Dialog>}
    {showXi && <Dialog title="Your locked XI" countdown={countdown} onClose={() => setShowXi(false)}><CompactXi draft={draft} preview={null} onInspect={setInspected} /></Dialog>}
    {confirmSubmit && <Dialog title="Submit and lock your XI?" countdown={countdown} onClose={() => setConfirmSubmit(false)}><p>Submission is final. Your eleven players and batting positions will be frozen while the room finishes.</p><p>Results arrive when everyone submits or the shared deadline passes.</p><button className="primary-action" disabled={blocked} onClick={() => { setConfirmSubmit(false); void onCommand({ type: "SUBMIT" }); }}>Submit and lock XI</button><button className="secondary-action" onClick={() => setConfirmSubmit(false)}>Keep reviewing</button></Dialog>}
    {inspected && <PlayerInspector player={inspected} countdown={countdown} onClose={() => setInspected(null)} />}
  </>;
}
function Waiting({ snapshot, expired, countdown }: { snapshot: SnapshotSuccess; expired: boolean; countdown: string }) {
  const [inspected, setInspected] = useState<DraftPickView | null>(null);
  const draft = snapshot.view.myDraft;
  return <div className="room-waiting-layout"><section className="draft-off-panel"><p className="eyebrow">Submission confirmed</p><h1>Your XI is locked in.</h1><p>{expired ? "Checking the final result with the server." : "The room is still drafting. Results arrive when everyone submits or time runs out."}</p><p>Your submission is final. Private XIs and ratings remain hidden.</p><ParticipantList view={snapshot.view} me={snapshot.participantId} /></section>
    {draft && draft.phase !== "SETUP" && <CompactXi draft={draft} preview={null} onInspect={setInspected} />}{inspected && <PlayerInspector player={inspected} countdown={countdown} onClose={() => setInspected(null)} />}</div>;
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
