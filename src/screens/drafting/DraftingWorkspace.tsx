import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";

import { PlayerCard } from "../../components/PlayerCard.js";
import { DRAFTING_COPY as COPY, ERA_COPY, fitDisplay, PLAYER_CARD_COPY, rejectionReason, teamAbbreviation } from "../../copy.js";
import type { DraftCandidateIdentityView } from "../../eraDraftTypes.js";
import { PlayerInspector, type PlayerInspectorView } from "../../eraDraftPlayerPresentation.js";
import type { EraDraftTierCaps } from "../../eraDraftTierCaps.js";
import { useBackStepGuard, useSmallScreen, useSpinReel, useSwipeDown, type ActiveDraft } from "./behaviour.js";
import { ReelAtRest, SpinReel } from "./SpinReel.js";
import { SquadList, unavailableReason } from "./SquadList.js";
import { XiBoard, XiStrip, type Arrival, type PendingLock } from "./XiBoard.js";

export type DraftingCommand =
  | { readonly type: "SPIN" }
  | { readonly type: "RESPIN" }
  | { readonly type: "LOCK_PLAYER"; readonly playerTeamSeasonId: string; readonly battingPosition: number };

/** A lock this screen sent and the server has not yet decided. `settled` means the send itself has finished. */
type SentLock = { readonly seq: number; readonly id: string; readonly name: string; readonly position: number; readonly revision: number; readonly settled: boolean };

export type DraftingWorkspaceProps = {
  draft: ActiveDraft;
  /** Draft-Off returns the send, so the screen knows when the server has answered. */
  onCommand: (command: DraftingCommand) => void | Promise<unknown>;
  /** What XI_COMPLETE offers: Reveal team in Solo, Submit XI in Draft-Off. */
  complete: {
    title: string;
    detail: ReactNode;
    action: (ref: RefObject<HTMLButtonElement | null>) => ReactElement;
  };
  /** Draft-Off: an unconfirmed action or a passed deadline. Browsing and picking wait. */
  blocked?: boolean;
  /** Draft-Off: a lock is waiting on the server, so its card has no lock edge yet. */
  locking?: boolean;
  /** Draft-Off: the deadline has passed and the server is deciding. */
  expired?: boolean;
  /**
   * Draft-Off: Lock plays at once. The card travels into its slot and waits there, "Locking…" with no lock edge,
   * until the server confirms; a rejection snaps it back to the dock with a short reason. Nothing extra is sent.
   */
  optimisticLock?: boolean;
  /** Draft-Off rooms with tier caps: shown beside Overseas and WK. */
  tierCaps?: EraDraftTierCaps;
  /** Draft-Off: the clock shown over player details. */
  countdown?: string;
  squadHint?: string;
  warning?: ReactNode;
  /** Announced with the workspace's own status messages, such as a rejected lock. */
  statusNote?: string | null;
};

/** One drafting screen for Solo and Draft-Off. Each mode owns its commands and state; this owns the presentation. */
export function DraftingWorkspace(props: DraftingWorkspaceProps): ReactElement {
  const { draft, blocked: roomBlocked = false, locking = false, expired = false, optimisticLock = false, complete, onCommand } = props;
  const small = useSmallScreen();
  const era = ERA_COPY[draft.eraId];
  const reel = useSpinReel(draft);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [inspected, setInspected] = useState<PlayerInspectorView | null>(null);
  const [placing, setPlacing] = useState(false);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [flashCount, setFlashCount] = useState(0);
  const [enteringRevision, setEnteringRevision] = useState<number | null>(null);
  const [arrival, setArrival] = useState<Arrival | null>(null);
  const [notice, setNotice] = useState<string>(COPY.spinPrompt);
  const [sent, setSent] = useState<SentLock | null>(null);
  const [rejection, setRejection] = useState<{ id: string; reason: string } | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const xiHeadingRef = useRef<HTMLHeadingElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const reelRef = useRef<HTMLButtonElement>(null);
  const lockRef = useRef<HTMLButtonElement>(null);
  const placeRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef<(() => void) | null>(null);
  const travelFrom = useRef<{ position: number; rect: DOMRect | null } | null>(null);
  const revision = useRef(draft.revision);
  const sendSeq = useRef(0);
  // Spin or Submit takes focus after a lock, as soon as the room lets it be used.
  const focusPrimary = useRef(false);

  const selected = draft.phase === "AWAITING_PICK" ? draft.candidates.find((candidate) => candidate.playerTeamSeasonId === selectedId) : undefined;
  const placeable = selected?.available ? selected : undefined;
  const sentLock = sent && sent.revision === draft.revision ? sent : null;
  const pending: PendingLock | null = sentLock && placeable?.playerTeamSeasonId === sentLock.id ? { player: placeable, position: sentLock.position } : null;
  // Nothing moves while a lock is out: going back, choosing and locking all wait for the server.
  const blocked = roomBlocked || sentLock !== null;
  const option = pending ? undefined : placeable?.positions.find((position) => position.battingPosition === preview && position.available);
  const spinReady = draft.phase === "AWAITING_SPIN";
  const rejected = rejection && rejection.id === selectedId ? rejection.reason : null;

  const focusRow = (id: string | null): void => {
    focusNext.current = () => {
      const rows = rootRef.current?.querySelectorAll<HTMLElement>("[data-candidate-id]") ?? [];
      [...rows].find((row) => row.dataset.candidateId === id)?.focus();
    };
  };
  const clearSelection = (): void => {
    focusRow(selectedId);
    setSelectedId(null); setPreview(null); setPlacing(false);
    setNotice(COPY.selectionCleared);
  };
  const stepBack = (): void => {
    if (blocked) return;
    if (inspected) { setInspected(null); return; }
    if (placing) {
      setDirection("back"); setPlacing(false);
      focusNext.current = () => (placeRef.current ?? headingRef.current)?.focus();
    } else if (selectedId !== null) clearSelection();
  };
  useBackStepGuard(small, stepBack);

  useEffect(() => { const focus = focusNext.current; focusNext.current = null; focus?.(); });
  useEffect(() => { headingRef.current?.focus(); }, []);
  useEffect(() => { if (reel.active) reelRef.current?.focus({ preventScroll: true }); }, [reel.active, draft.revision]);
  useEffect(() => {
    if (revision.current === draft.revision) return;
    revision.current = draft.revision;
    const out = sent;
    setSelectedId(null); setPreview(null); setInspected(null); setPlacing(false); setSent(null); setRejection(null);
    if (out && !draft.picks.some((pick) => pick.battingPosition === out.position && pick.playerTeamSeasonId === out.id)) {
      // The draft moved on without this pick: another tab, or the deadline.
      setNotice(COPY.lockRejectedNotice(out.name, out.position, expired ? COPY.lockTimeUp : COPY.lockDraftChanged));
      focusPrimary.current = true;
    } else if (draft.phase === "AWAITING_PICK") {
      setDirection("forward");
      setNotice(COPY.spinResult(draft.currentSpin.teamName, draft.currentSpin.seasonYear));
    } else {
      const last = draft.picks.reduce((latest, pick) => (pick.pickNumber > latest ? pick.pickNumber : latest), 0);
      setNotice(draft.phase === "XI_COMPLETE" ? COPY.xiComplete : COPY.pickLocked(last));
      focusPrimary.current = true;
    }
  }, [draft]);
  useEffect(() => {
    const primary = primaryRef.current;
    if (!focusPrimary.current || !primary || primary.disabled) return;
    focusPrimary.current = false;
    primary.focus();
  });
  // The send has finished, the room is no longer locking, and the draft is unchanged: the server said no.
  useEffect(() => {
    if (!sent?.settled || locking || sent.revision !== draft.revision) return;
    const candidate = draft.phase === "AWAITING_PICK" ? draft.candidates.find((item) => item.playerTeamSeasonId === sent.id) : undefined;
    const slot = candidate?.positions.find((item) => item.battingPosition === sent.position);
    const reason = expired ? COPY.lockTimeUp
      : (candidate && unavailableReason(candidate)) ?? (slot && !slot.available ? rejectionReason(slot.reasons.map((item) => item.code)) : undefined) ?? COPY.lockNotAccepted;
    setSent(null); setPreview(null);
    setRejection({ id: sent.id, reason });
    setNotice(COPY.lockRejectedNotice(sent.name, sent.position, reason));
    const reopened = (): HTMLElement | null | undefined => boardRef.current?.querySelector<HTMLElement>(`[data-position="${sent.position}"] .xi-open-slot:not(:disabled)`);
    focusNext.current = () => (small ? reopened() ?? xiHeadingRef.current : cardRef.current)?.focus({ preventScroll: true });
  }, [sent, locking, draft, expired, small]);
  useEffect(() => {
    if (selectedId === null && inspected === null && !placing) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (inspected) { setInspected(null); return; }
      if (small && placing) { stepBack(); return; }
      if (!blocked) clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  // The card travels from where the dock drew it. Measured before paint, so it never flashes in the slot.
  useLayoutEffect(() => {
    const from = travelFrom.current;
    if (!from || !(pending?.position === from.position || draft.picks.some((pick) => pick.battingPosition === from.position))) return;
    travelFrom.current = null;
    const to = boardRef.current?.querySelector(`[data-position="${from.position}"]`)?.getBoundingClientRect();
    setArrival(!small && from.rect && to && to.width > 0 && to.height > 0
      ? { position: from.position, kind: "travel", x: from.rect.left - to.left, y: from.rect.top - to.top, scaleX: from.rect.width / to.width, scaleY: from.rect.height / to.height }
      : { position: from.position, kind: "settle" });
  }, [draft.picks, pending?.position, small]);

  const selectPlayer = (candidate: DraftCandidateIdentityView): void => {
    setPreview(null); setInspected(null); setEnteringRevision(null); setRejection(null);
    if (candidate.playerTeamSeasonId === selectedId) { clearSelection(); return; }
    setSelectedId(candidate.playerTeamSeasonId);
    setFlashCount((count) => count + 1);
    const reason = unavailableReason(candidate);
    setNotice(reason ? COPY.cantPickNotice(candidate.playerName, reason) : COPY.playerSelected(candidate.playerName));
    focusNext.current = () => {
      rootRef.current?.querySelector<HTMLElement>(`.squad-row-selected`)?.scrollIntoView?.({ block: "nearest" });
      cardRef.current?.scrollIntoView?.({ block: "nearest" });
      cardRef.current?.focus({ preventScroll: true });
    };
  };
  const previewSlot = (position: number): void => {
    const target = placeable?.positions.find((item) => item.battingPosition === position);
    if (!target) return;
    setPreview(position); setRejection(null);
    setNotice(COPY.slotPreview(position, fitDisplay(target.presentationFit, target.nominalDeductionPercent).text));
    focusNext.current = () => lockRef.current?.focus();
  };
  const lock = (): void => {
    if (!placeable || !option || blocked) return;
    const position = option.battingPosition;
    travelFrom.current = { position, rect: cardRef.current?.querySelector(".player-card")?.getBoundingClientRect() ?? null };
    const result = onCommand({ type: "LOCK_PLAYER", playerTeamSeasonId: placeable.playerTeamSeasonId, battingPosition: position });
    if (!optimisticLock) return;
    const seq = sendSeq.current += 1;
    setSent({ seq, id: placeable.playerTeamSeasonId, name: placeable.playerName, position, revision: draft.revision, settled: false });
    setRejection(null);
    setNotice(COPY.lockingNotice(placeable.playerName, position));
    focusNext.current = () => boardRef.current?.querySelector<HTMLElement>(`[data-position="${position}"]`)?.focus({ preventScroll: true });
    const settle = (): void => setSent((current) => (current?.seq === seq ? { ...current, settled: true } : current));
    void Promise.resolve(result).then(settle, settle);
  };
  const landReel = (): void => {
    focusNext.current = () => headingRef.current?.focus();
    setEnteringRevision(draft.revision);
    reel.land();
  };
  const placeInXi = (): void => {
    setDirection("forward"); setPlacing(true);
    focusNext.current = () => xiHeadingRef.current?.focus();
  };
  const changePlayer = (): void => {
    setDirection("back");
    clearSelection();
  };

  const spinAction = spinReady || (reel.active && reel.kind === "SPIN");
  const spinButton = spinAction && <button ref={primaryRef} type="button" className="primary-action drafting-primary drafting-spin" disabled={blocked}
    aria-label={reel.active ? COPY.spinSkip : undefined} onClick={() => { if (reel.active) landReel(); else onCommand({ type: "SPIN" }); }}>{blocked && !expired ? COPY.waiting : COPY.spin}</button>;
  const respinControl = draft.phase === "AWAITING_PICK" && !reel.active && draft.status.respinStatus === "AVAILABLE"
    ? <button type="button" className="secondary-action drafting-respin" disabled={blocked} onClick={() => onCommand({ type: "RESPIN" })}>{blocked && !expired ? COPY.waiting : COPY.respinAvailable}</button>
    : !reel.active && draft.phase !== "XI_COMPLETE" && <span className="drafting-respin-status">{draft.status.respinStatus === "USED" ? COPY.respinUsed : COPY.respinAvailable}</span>;

  const heading = draft.phase === "AWAITING_SPIN" ? (draft.status.pickCount === 0 ? COPY.readyFirst : COPY.readyNext)
    : draft.phase === "XI_COMPLETE" ? complete.title
      : reel.active ? COPY.spinning : `${draft.currentSpin.teamName} ${draft.currentSpin.seasonYear}`;
  const reelElement = reel.active && draft.phase === "AWAITING_PICK"
    ? <SpinReel eraId={draft.eraId} kind={reel.kind} seed={`${draft.revision}:${draft.currentSpin.teamSeasonId}`} reelRef={reelRef}
        abbreviation={teamAbbreviation(draft.currentSpin.teamId, draft.currentSpin.teamName)} year={draft.currentSpin.seasonYear} onLand={landReel} />
    : null;
  const pickLine = <p className="drafting-context"><span>{era.title} · {era.years}</span><span>{COPY.pickOf(Math.min(draft.status.pickCount + 1, 11))}</span></p>;
  // Before the spin and while its reel runs, the spin is the whole stage: reel, a large Spin, the respin and one line.
  const stage = spinAction && <section className="spin-stage" aria-labelledby="draft-stage-title">
    <h1 id="draft-stage-title" ref={headingRef} tabIndex={-1} className="drafting-title">{heading}</h1>
    {reelElement ?? <ReelAtRest />}
    {spinButton}
    <span className="drafting-respin-status">{draft.status.respinStatus === "USED" ? COPY.respinUsed : COPY.respinAvailable}</span>
    <p className="spin-stage-hint">{props.squadHint ?? COPY.squadEmpty}</p>
  </section>;
  const hero = draft.phase === "AWAITING_PICK" && !reel.active
    ? <h1 id="draft-stage-title" ref={headingRef} tabIndex={-1} className="drafting-hero">{draft.currentSpin.teamName} <span>{draft.currentSpin.seasonYear}</span></h1>
    : <h1 id="draft-stage-title" ref={headingRef} tabIndex={-1} className={reel.active ? "sr-status" : "drafting-title"}>{heading}</h1>;
  const inspector = inspected && <PlayerInspector player={inspected} eraTitle={era.title} countdown={props.countdown} onClose={() => setInspected(null)} />;
  const status = <p className="sr-status" aria-live="polite">{props.statusNote ? `${notice} ${props.statusNote}` : notice}</p>;
  const lockLabel = blocked && !expired ? COPY.waiting : option ? COPY.lockIn(option.battingPosition) : COPY.lock;
  const lockHint = rejected ? <p className="drafting-rejected"><span aria-hidden="true">⚠</span> {COPY.lockRejected(rejected)}</p> : null;
  const lockButton = <button ref={lockRef} type="button" className="primary-action drafting-lock" disabled={blocked || !option} onClick={lock}>{lockLabel}</button>;
  const unpickable = selected && unavailableReason(selected);
  const bigCard = selected && <PlayerCard className="selected-player-detail" size="big" player={selected} eraTitle={era.title}
    state={selected.available ? "selected" : "unavailable"} unavailableReason={unpickable ? COPY.cantPick(unpickable) : undefined}
    flashKey={`${selected.playerTeamSeasonId}:${flashCount}`}
    fit={option?.presentationFit} fitPercent={option?.nominalDeductionPercent} />;
  const board = <XiBoard draft={draft} selected={placeable} preview={preview} pending={pending} blocked={blocked} small={small} arrival={arrival} caps={props.tierCaps}
    headingRef={xiHeadingRef} rootRef={boardRef} onPreview={previewSlot} onConfirm={lock} onInspect={setInspected} onArrived={() => setArrival(null)}
    leading={small && placing ? <button type="button" className="quiet-button drafting-back" disabled={blocked} onClick={stepBack}>{COPY.backToSquad}</button> : undefined} />;

  if (small) {
    const screen = draft.phase === "AWAITING_PICK" && !placing && !(reel.active && reel.kind === "SPIN") ? "squad" : "board";
    return <div ref={rootRef} className={`drafting drafting-small${spinReady ? " drafting-spin-ready" : ""}`}>
      {props.warning}
      <div key={screen} className={`drafting-screen drafting-screen-${screen} drafting-step-${direction}`}>
        {screen === "squad" && draft.phase === "AWAITING_PICK"
          ? <>
            <XiStrip draft={draft} caps={props.tierCaps} onOpen={placeInXi} />
            {pickLine}
            <div className="spin-area spin-area-picked">{hero}{respinControl}</div>
            {!(reel.active && reel.kind === "RESPIN") && <SquadList view={draft} selectedId={selectedId} blocked={blocked} entering={enteringRevision === draft.revision}
              onSelect={selectPlayer} expansion={(candidate) => <SquadFlash cardRef={cardRef} card={bigCard} onDismiss={() => { if (!blocked) clearSelection(); }}>
                {!blocked && <button type="button" className="quiet-button" onClick={() => setInspected(candidate)}>{COPY.inspectSeason}</button>}
                {candidate.available && <button ref={placeRef} type="button" className="primary-action drafting-place" disabled={blocked} onClick={placeInXi}>{COPY.placeInXi}</button>}
              </SquadFlash>} />}
          </>
          : <>
            {!placing && pickLine}
            {stage || hero}
            {board}
          </>}
      </div>
      {reelElement && !spinAction && <div className="drafting-reel-overlay">{reelElement}</div>}
      {screen === "board" && !spinAction && <div className={`drafting-bar${placeable && placing ? " drafting-bar-placing" : ""}`}>
        {draft.phase === "XI_COMPLETE" && <>
          <div className="drafting-bar-detail">{complete.detail}</div>
          {complete.action(primaryRef)}
        </>}
        {draft.phase === "AWAITING_PICK" && (placeable && placing
          ? <>
            <PlayerCard size="mini" player={placeable} state="selected" fit={option?.presentationFit} fitPercent={option?.nominalDeductionPercent}
              className={pending ? "drafting-card-sent" : rejected ? "drafting-card-returned" : undefined} />
            {lockHint ?? <p className="drafting-hint">{pending || locking ? PLAYER_CARD_COPY.locking : option ? COPY.tapLock : COPY.tapSlot}</p>}
            <div className="drafting-bar-actions">
              <button type="button" className="secondary-action drafting-change" disabled={blocked} onClick={changePlayer}>{COPY.changePlayer}</button>
              {lockButton}
            </div>
          </>
          : <p className="drafting-hint">{COPY.chooseFirst}</p>)}
      </div>}
      {status}
      {inspector}
    </div>;
  }

  return <div ref={rootRef} className={`drafting drafting-split${spinReady ? " drafting-spin-ready" : ""}`}>
    <div className="drafting-left" id="draft-players">
      {pickLine}
      {props.warning}
      {stage || <div className={`spin-area${reel.active ? " spin-area-reeling" : draft.phase === "AWAITING_PICK" ? " spin-area-picked" : ""}`}>
        {hero}
        {reelElement}
        <div className="spin-area-actions">{respinControl}</div>
      </div>}
      {draft.phase === "AWAITING_PICK" && !reel.active && <SquadList view={draft} selectedId={selectedId} blocked={blocked}
        entering={enteringRevision === draft.revision} onSelect={selectPlayer} />}
      {selected && <section className="drafting-dock" aria-label={COPY.dockLabel}>
        <div ref={cardRef} tabIndex={-1} className={`drafting-dock-card${pending ? " drafting-card-sent" : rejected ? " drafting-card-returned" : ""}`}>{bigCard}</div>
        <div className="drafting-dock-actions">
          <button type="button" className="quiet-button drafting-clear" disabled={blocked} onClick={clearSelection}>{COPY.clear}</button>
          <button type="button" className="quiet-button" onClick={() => setInspected(selected)}>{COPY.inspectSeason}</button>
          {placeable && (lockHint ?? <p className="drafting-hint">{pending || locking ? PLAYER_CARD_COPY.locking : option ? COPY.clickAgain : COPY.chooseSlot}</p>)}
          {placeable && lockButton}
        </div>
      </section>}
      {draft.phase === "XI_COMPLETE" && <div className="drafting-complete">
        {complete.detail}
        {complete.action(primaryRef)}
      </div>}
    </div>
    {board}
    {status}
    {inspector}
  </div>;
}

function SquadFlash(props: { cardRef: RefObject<HTMLDivElement | null>; card: ReactNode; onDismiss: () => void; children: ReactNode }): ReactElement {
  const swipe = useSwipeDown(props.onDismiss);
  return <div className="squad-flash">
    <div ref={props.cardRef} tabIndex={-1} className="squad-flash-card" {...swipe}>{props.card}</div>
    <div className="squad-flash-actions">{props.children}</div>
  </div>;
}
