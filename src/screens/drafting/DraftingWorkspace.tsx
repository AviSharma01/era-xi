import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";

import { PlayerCard } from "../../components/PlayerCard.js";
import { DRAFTING_COPY as COPY, ERA_COPY, fitDisplay, PLAYER_CARD_COPY, teamAbbreviation } from "../../copy.js";
import type { DraftCandidateIdentityView } from "../../eraDraftTypes.js";
import { PlayerInspector, type PlayerInspectorView } from "../../eraDraftPlayerPresentation.js";
import { useBackStepGuard, useSmallScreen, useSpinReel, useSwipeDown, type ActiveDraft } from "./behaviour.js";
import { ReelAtRest, SpinReel } from "./SpinReel.js";
import { SquadList, unavailableReason } from "./SquadList.js";
import { XiBoard, XiStrip, type Arrival } from "./XiBoard.js";

export type DraftingCommand =
  | { readonly type: "SPIN" }
  | { readonly type: "RESPIN" }
  | { readonly type: "LOCK_PLAYER"; readonly playerTeamSeasonId: string; readonly battingPosition: number };

export type DraftingWorkspaceProps = {
  draft: ActiveDraft;
  onCommand: (command: DraftingCommand) => void;
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
  /** Solo locks at once, so the card can travel. Draft-Off's stays in its slot until confirmed. */
  lockTravel?: boolean;
  /** Draft-Off: the clock shown over player details. */
  countdown?: string;
  squadHint?: string;
  warning?: ReactNode;
  /** Announced with the workspace's own status messages, such as a rejected lock. */
  statusNote?: string | null;
};

/** One drafting screen for Solo and Draft-Off. Each mode owns its commands and state; this owns the presentation. */
export function DraftingWorkspace(props: DraftingWorkspaceProps): ReactElement {
  const { draft, blocked = false, locking = false, expired = false, lockTravel = false, complete, onCommand } = props;
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

  const selected = draft.phase === "AWAITING_PICK" ? draft.candidates.find((candidate) => candidate.playerTeamSeasonId === selectedId) : undefined;
  const placeable = selected?.available ? selected : undefined;
  const option = placeable?.positions.find((position) => position.battingPosition === preview && position.available);
  const spinReady = draft.phase === "AWAITING_SPIN";

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
    setSelectedId(null); setPreview(null); setInspected(null); setPlacing(false);
    if (draft.phase === "AWAITING_PICK") {
      setDirection("forward");
      setNotice(COPY.spinResult(draft.currentSpin.teamName, draft.currentSpin.seasonYear));
    } else {
      const last = draft.picks.reduce((latest, pick) => (pick.pickNumber > latest ? pick.pickNumber : latest), 0);
      setNotice(draft.phase === "XI_COMPLETE" ? COPY.xiComplete : COPY.pickLocked(last));
      primaryRef.current?.focus();
    }
  }, [draft]);
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
    if (!from || !draft.picks.some((pick) => pick.battingPosition === from.position)) return;
    travelFrom.current = null;
    const to = boardRef.current?.querySelector(`[data-position="${from.position}"]`)?.getBoundingClientRect();
    setArrival(!small && from.rect && to && to.width > 0 && to.height > 0
      ? { position: from.position, kind: "travel", x: from.rect.left - to.left, y: from.rect.top - to.top, scaleX: from.rect.width / to.width, scaleY: from.rect.height / to.height }
      : { position: from.position, kind: "settle" });
  }, [draft.picks, small]);

  const selectPlayer = (candidate: DraftCandidateIdentityView): void => {
    setPreview(null); setInspected(null); setEnteringRevision(null);
    if (candidate.playerTeamSeasonId === selectedId) { clearSelection(); return; }
    setSelectedId(candidate.playerTeamSeasonId);
    setFlashCount((count) => count + 1);
    setNotice(unavailableReason(candidate) ?? COPY.playerSelected(candidate.playerName));
    focusNext.current = () => {
      rootRef.current?.querySelector<HTMLElement>(`.squad-row-selected`)?.scrollIntoView?.({ block: "nearest" });
      cardRef.current?.scrollIntoView?.({ block: "nearest" });
      cardRef.current?.focus({ preventScroll: true });
    };
  };
  const previewSlot = (position: number): void => {
    const target = placeable?.positions.find((item) => item.battingPosition === position);
    if (!target) return;
    setPreview(position);
    setNotice(COPY.slotPreview(position, fitDisplay(target.presentationFit, target.nominalDeductionPercent).text));
    focusNext.current = () => lockRef.current?.focus();
  };
  const lock = (): void => {
    if (!placeable || !option || blocked) return;
    if (lockTravel) {
      travelFrom.current = { position: option.battingPosition, rect: cardRef.current?.querySelector(".player-card")?.getBoundingClientRect() ?? null };
    }
    onCommand({ type: "LOCK_PLAYER", playerTeamSeasonId: placeable.playerTeamSeasonId, battingPosition: option.battingPosition });
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
  const lockButton = <button ref={lockRef} type="button" className="primary-action drafting-lock" disabled={blocked || !option} onClick={lock}>{lockLabel}</button>;
  const bigCard = selected && <PlayerCard className="selected-player-detail" size="big" player={selected} eraTitle={era.title}
    state={selected.available ? "selected" : "unavailable"} unavailableReason={unavailableReason(selected)}
    flashKey={`${selected.playerTeamSeasonId}:${flashCount}`}
    fit={option?.presentationFit} fitPercent={option?.nominalDeductionPercent} />;
  const board = <XiBoard draft={draft} selected={placeable} preview={preview} blocked={blocked} locking={locking} small={small} arrival={arrival}
    headingRef={xiHeadingRef} rootRef={boardRef} onPreview={previewSlot} onConfirm={lock} onInspect={setInspected} onArrived={() => setArrival(null)}
    leading={small && placing ? <button type="button" className="quiet-button drafting-back" disabled={blocked} onClick={stepBack}>{COPY.backToSquad}</button> : undefined} />;

  if (small) {
    const screen = draft.phase === "AWAITING_PICK" && !placing && !(reel.active && reel.kind === "SPIN") ? "squad" : "board";
    return <div ref={rootRef} className={`drafting drafting-small${spinReady ? " drafting-spin-ready" : ""}`}>
      {props.warning}
      <div key={screen} className={`drafting-screen drafting-screen-${screen} drafting-step-${direction}`}>
        {screen === "squad" && draft.phase === "AWAITING_PICK"
          ? <>
            <XiStrip draft={draft} onOpen={placeInXi} />
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
            <PlayerCard size="mini" player={placeable} state="selected" fit={option?.presentationFit} fitPercent={option?.nominalDeductionPercent} />
            <p className="drafting-hint">{locking ? PLAYER_CARD_COPY.locking : option ? COPY.tapLock : COPY.tapSlot}</p>
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
        <div ref={cardRef} tabIndex={-1} className="drafting-dock-card">{bigCard}</div>
        <div className="drafting-dock-actions">
          <button type="button" className="quiet-button drafting-clear" disabled={blocked} onClick={clearSelection}>{COPY.clear}</button>
          <button type="button" className="quiet-button" onClick={() => setInspected(selected)}>{COPY.inspectSeason}</button>
          {placeable && <p className="drafting-hint">{locking ? PLAYER_CARD_COPY.locking : option ? COPY.clickAgain : COPY.chooseSlot}</p>}
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
