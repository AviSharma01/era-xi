import type { CSSProperties, ReactElement, ReactNode, RefObject } from "react";

import { FitBadge, monogram, PlayerCard, playerCardName } from "../../components/PlayerCard.js";
import { DRAFTING_COPY as COPY, fitDisplay, slotLabel } from "../../copy.js";
import type { DraftCandidateIdentityView, DraftPickView } from "../../eraDraftTypes.js";
import type { ActiveDraft } from "./behaviour.js";

export type Arrival =
  | { readonly position: number; readonly kind: "settle" }
  | { readonly position: number; readonly kind: "travel"; readonly x: number; readonly y: number; readonly scaleX: number; readonly scaleY: number };

const BATTING_ROWS = [
  { label: COPY.topOrder, positions: [1, 2, 3] },
  { label: COPY.middleOrder, positions: [4, 5, 6, 7] },
  { label: COPY.lowerOrder, positions: [8, 9, 10, 11] },
] as const;

function XiStatus({ draft }: { draft: ActiveDraft }): ReactElement {
  return <div className="xi-status" aria-label={COPY.statusLabel}>
    <span>{COPY.overseas} <strong>{draft.status.overseasCount}/{draft.status.overseasLimit}</strong></span>
    <span>{COPY.keeper} <strong>{draft.status.hasWicketkeeper ? COPY.keeperCovered : COPY.keeperNeeded}</strong></span>
  </div>;
}

/** The XI as eleven full cards in three batting rows, all visible; cards scale with the space they get. */
export function XiBoard(props: {
  draft: ActiveDraft;
  selected?: DraftCandidateIdentityView;
  preview: number | null;
  blocked: boolean;
  locking: boolean;
  small: boolean;
  arrival: Arrival | null;
  leading?: ReactNode;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  rootRef?: RefObject<HTMLElement | null>;
  onPreview: (position: number) => void;
  onConfirm: () => void;
  onInspect: (pick: DraftPickView) => void;
  onArrived: () => void;
}): ReactElement {
  const { draft, selected, preview, blocked, locking, small, arrival } = props;
  const slot = (position: number): ReactElement => {
    const pick = draft.picks.find((item) => item.battingPosition === position);
    const option = selected?.positions.find((item) => item.battingPosition === position);
    const arriving = arrival?.position === position ? arrival : null;
    const className = `xi-slot${arriving ? ` xi-slot-${arriving.kind === "travel" ? "travelling" : "settling"}` : ""}`;
    const style = arriving?.kind === "travel"
      ? { "--travel-x": `${arriving.x}px`, "--travel-y": `${arriving.y}px`, "--travel-scale-x": arriving.scaleX, "--travel-scale-y": arriving.scaleY } as CSSProperties
      : undefined;
    let content: ReactElement;
    if (pick) {
      const fit = fitDisplay(pick.presentationFit, pick.nominalDeductionPercent);
      content = <PlayerCard size="slot" state="locked" player={pick} slotNumber={position} fit={pick.presentationFit} fitPercent={pick.nominalDeductionPercent}
        className="xi-slot-occupied xi-slot-locked" label={COPY.lockedSlotLabel(playerCardName(pick), position, fit.text)} onClick={() => props.onInspect(pick)} />;
    } else if (preview === position && selected && option?.available) {
      const fit = fitDisplay(option.presentationFit, option.nominalDeductionPercent);
      const state = locking ? "pending" : "preview";
      // Phones lock by button only, so there the previewed card is not a control.
      content = <PlayerCard size="slot" state={state} player={selected} slotNumber={position} fit={option.presentationFit} fitPercent={option.nominalDeductionPercent}
        className={`xi-slot-occupied ${locking ? "xi-slot-pending" : "xi-slot-preview"}`} note={!locking && !small ? COPY.clickAgain : undefined}
        label={locking ? COPY.lockingSlotLabel(playerCardName(selected), position, fit.text) : COPY.previewSlotLabel(playerCardName(selected), position, fit.text, small)}
        onClick={small || locking ? undefined : () => props.onConfirm()} />;
    } else {
      const fit = option && fitDisplay(option.presentationFit, option.nominalDeductionPercent);
      const reason = option && !option.available ? option.reasons[0]?.message ?? COPY.slotUnavailable : null;
      const reasons = reason === null ? null : option!.reasons.map((item) => item.message).join(". ") || reason;
      content = <button type="button" className={`xi-open-slot${selected ? " xi-slot-active" : ""}`} disabled={blocked || !selected || !option?.available}
        aria-label={slotLabel(position, fit?.text ?? null, reasons ?? (blocked ? COPY.waiting : null))}
        onClick={() => props.onPreview(position)}>
        <span className="xi-open-number">{String(position).padStart(2, "0")}</span>
        {option && <FitBadge fit={option.presentationFit} percent={option.nominalDeductionPercent} />}
        {reason && <small className="xi-open-reason">{reason}</small>}
      </button>;
    }
    return <div key={position} className={className} style={style} data-position={position}
      onAnimationEnd={(event) => { if (arriving && event.target === event.currentTarget) props.onArrived(); }}>{content}</div>;
  };
  return <section id="draft-xi" ref={props.rootRef} className="xi-board" aria-labelledby="xi-title">
    <div className="xi-board-heading">
      {props.leading}
      <h2 id="xi-title" ref={props.headingRef} tabIndex={-1}>{COPY.yourXi}</h2>
      <span className="xi-count">{COPY.lockedCount(draft.status.pickCount)}</span>
      <XiStatus draft={draft} />
    </div>
    <div className="xi-rows">
      {BATTING_ROWS.map((row) => <div key={row.label} className="xi-row-group" role="group" aria-label={row.label}>
        <span className="xi-row-label" aria-hidden="true">{row.label}</span>
        <div className={`xi-row xi-row-${row.positions.length}`}>{row.positions.map(slot)}</div>
      </div>)}
    </div>
  </section>;
}

/** Phones, while choosing: the XI as eleven cells pinned above the squad. Opens the full-card XI. */
export function XiStrip({ draft, onOpen }: { draft: ActiveDraft; onOpen: () => void }): ReactElement {
  return <button type="button" className="xi-strip" aria-label={COPY.stripLabel(draft.status.pickCount)} onClick={onOpen}>
    {Array.from({ length: 11 }, (_, index) => {
      const pick = draft.picks.find((item) => item.battingPosition === index + 1);
      return <span key={index} className={`xi-strip-cell${pick ? ` xi-strip-filled tier-${pick.tierAppearance}` : ""}`} aria-hidden="true">
        {pick ? monogram(pick.playerName) : String(index + 1).padStart(2, "0")}
      </span>;
    })}
  </button>;
}
