import type { CSSProperties, ReactElement, ReactNode, RefObject } from "react";

import { FitBadge, monogram, PlayerCard, playerCardName } from "../../components/PlayerCard.js";
import { DRAFTING_COPY as COPY, fitDisplay, REJECTION_COPY, rejectionReason, slotLabel } from "../../copy.js";
import type { DraftCandidateIdentityView, DraftPickView } from "../../eraDraftTypes.js";
import type { EraDraftTierCaps } from "../../eraDraftTierCaps.js";
import type { ActiveDraft } from "./behaviour.js";

export type Arrival =
  | { readonly position: number; readonly kind: "settle" }
  | { readonly position: number; readonly kind: "travel"; readonly x: number; readonly y: number; readonly scaleX: number; readonly scaleY: number };

const BATTING_ROWS = [
  { label: COPY.topOrder, positions: [1, 2, 3] },
  { label: COPY.middleOrder, positions: [4, 5, 6, 7] },
  { label: COPY.lowerOrder, positions: [8, 9, 10, 11] },
] as const;

type Limit = { key: string; name: string; short: string; count: number; limit: number; swatches: readonly string[] };
/** Overseas always; S and S+A only when the room has caps. Counts come from the projected picks. */
function draftLimits(draft: ActiveDraft, caps: EraDraftTierCaps | undefined, compact: boolean): Limit[] {
  const s = draft.picks.filter((pick) => pick.tierAppearance === "violet").length;
  const sa = s + draft.picks.filter((pick) => pick.tierAppearance === "gold").length;
  return [
    { key: "overseas", name: COPY.overseas, short: compact ? COPY.overseasShort : COPY.overseas, count: draft.status.overseasCount, limit: draft.status.overseasLimit, swatches: [] },
    ...(caps ? [
      { key: "s", name: COPY.sTierName, short: COPY.tierS, count: s, limit: caps.maxS, swatches: ["violet"] },
      { key: "sa", name: COPY.saTierName, short: COPY.tierSA, count: sa, limit: caps.maxSA, swatches: ["violet", "gold"] },
    ] : []),
  ];
}

/** "Overseas 2/4 · WK needed · S 2/3 · S+A 4/6". A cap at its limit says "full" with an ivory outline; a missing keeper is amber and says "needed". */
export function LimitsStrip({ draft, caps, compact = false }: { draft: ActiveDraft; caps?: EraDraftTierCaps; compact?: boolean }): ReactElement {
  const [overseas, ...tiers] = draftLimits(draft, caps, compact);
  const chip = (limit: Limit): ReactElement => {
    const full = limit.count >= limit.limit;
    return <li key={limit.key} className={`xi-limit xi-limit-${limit.key}${full ? " xi-limit-full" : ""}`}>
      <span className="sr-status">{COPY.limitChipLabel(limit.name, limit.count, limit.limit, full)}</span>
      <span className="xi-limit-face" aria-hidden="true">
        {limit.swatches.map((tier) => <span key={tier} className={`xi-limit-swatch tier-${tier}`} />)}
        {limit.short} <strong>{limit.count}/{limit.limit}</strong>{full && <> · {COPY.limitFull}</>}
      </span>
    </li>;
  };
  const keeper = draft.status.hasWicketkeeper;
  return <ul className={`xi-limits${compact ? " xi-limits-compact" : ""}`} aria-label={COPY.limitsLabel}>
    {chip(overseas!)}
    <li className={`xi-limit xi-limit-keeper${keeper ? "" : " xi-limit-needed"}`}>
      <span className="sr-status">{COPY.keeperChipLabel(keeper)}</span>
      <span className="xi-limit-face" aria-hidden="true">{COPY.keeperChip} <strong>{keeper ? COPY.keeperChipCovered : COPY.keeperChipNeeded}</strong></span>
    </li>
    {tiers.map(chip)}
  </ul>;
}

/** A lock sent to the server and not yet confirmed: the card sits in its slot with no lock edge. */
export type PendingLock = { readonly player: DraftCandidateIdentityView; readonly position: number };

/** The XI as eleven full cards in three batting rows, all visible; cards scale with the space they get. */
export function XiBoard(props: {
  draft: ActiveDraft;
  selected?: DraftCandidateIdentityView;
  preview: number | null;
  pending: PendingLock | null;
  blocked: boolean;
  small: boolean;
  caps?: EraDraftTierCaps;
  arrival: Arrival | null;
  leading?: ReactNode;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  rootRef?: RefObject<HTMLElement | null>;
  onPreview: (position: number) => void;
  onConfirm: () => void;
  onInspect: (pick: DraftPickView) => void;
  onArrived: () => void;
}): ReactElement {
  const { draft, selected, preview, pending, blocked, small, arrival } = props;
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
    } else if (pending?.position === position) {
      const pendingOption = pending.player.positions.find((item) => item.battingPosition === position)!;
      const fit = fitDisplay(pendingOption.presentationFit, pendingOption.nominalDeductionPercent);
      content = <PlayerCard size="slot" state="pending" player={pending.player} slotNumber={position} fit={pendingOption.presentationFit} fitPercent={pendingOption.nominalDeductionPercent}
        className="xi-slot-occupied xi-slot-pending" label={COPY.lockingSlotLabel(playerCardName(pending.player), position, fit.text)} />;
    } else if (preview === position && selected && option?.available) {
      const fit = fitDisplay(option.presentationFit, option.nominalDeductionPercent);
      // Phones lock by button only, so there the previewed card is not a control.
      content = <PlayerCard size="slot" state="preview" player={selected} slotNumber={position} fit={option.presentationFit} fitPercent={option.nominalDeductionPercent}
        className="xi-slot-occupied xi-slot-preview" note={small ? undefined : COPY.clickAgain}
        label={COPY.previewSlotLabel(playerCardName(selected), position, fit.text, small)}
        onClick={small || blocked ? undefined : () => props.onConfirm()} />;
    } else {
      const fit = option && fitDisplay(option.presentationFit, option.nominalDeductionPercent);
      const codes = option && !option.available ? option.reasons.map((item) => item.code) : null;
      const reason = codes && (rejectionReason(codes) ?? COPY.slotUnavailable);
      const reasons = codes && ([...new Set(codes.map((code) => REJECTION_COPY[code]))].join(". ") || reason);
      content = <button type="button" className={`xi-open-slot${selected ? " xi-slot-active" : ""}`} disabled={blocked || !selected || !option?.available}
        aria-label={slotLabel(position, fit?.text ?? null, reasons ?? (blocked ? COPY.waiting : null))}
        onClick={() => props.onPreview(position)}>
        <span className="xi-open-number">{String(position).padStart(2, "0")}</span>
        {option && <FitBadge fit={option.presentationFit} percent={option.nominalDeductionPercent} />}
        {reason && <small className="xi-open-reason">{reason}</small>}
      </button>;
    }
    // The pending card takes focus while the server decides, so keyboard users hear "Locking".
    return <div key={position} className={className} style={style} data-position={position} tabIndex={pending?.position === position ? -1 : undefined}
      onAnimationEnd={(event) => { if (arriving && event.target === event.currentTarget) props.onArrived(); }}>{content}</div>;
  };
  return <section id="draft-xi" ref={props.rootRef} className="xi-board" aria-labelledby="xi-title">
    <div className="xi-board-heading">
      {props.leading}
      <h2 id="xi-title" ref={props.headingRef} tabIndex={-1}>{COPY.yourXi}</h2>
      <LimitsStrip draft={draft} caps={props.caps} compact={small} />
      <span className="xi-count">{COPY.lockedCount(draft.status.pickCount)}</span>
    </div>
    <div className="xi-rows">
      {BATTING_ROWS.map((row) => <div key={row.label} className="xi-row-group" role="group" aria-label={row.label}>
        <span className="xi-row-label" aria-hidden="true">{row.label}</span>
        <div className={`xi-row xi-row-${row.positions.length}`}>{row.positions.map(slot)}</div>
      </div>)}
    </div>
  </section>;
}

/** Phones, while choosing: the XI as eleven cells pinned above the squad, with the limits on a second line. Opens the full-card XI. */
export function XiStrip({ draft, caps, onOpen }: { draft: ActiveDraft; caps?: EraDraftTierCaps; onOpen: () => void }): ReactElement {
  return <div className="xi-strip-pinned">
    <button type="button" className="xi-strip" aria-label={COPY.stripLabel(draft.status.pickCount)} onClick={onOpen}>
      {Array.from({ length: 11 }, (_, index) => {
        const pick = draft.picks.find((item) => item.battingPosition === index + 1);
        return <span key={index} className={`xi-strip-cell${pick ? ` xi-strip-filled tier-${pick.tierAppearance}` : ""}`} aria-hidden="true">
          {pick ? monogram(pick.playerName) : String(index + 1).padStart(2, "0")}
        </span>;
      })}
    </button>
    <LimitsStrip draft={draft} caps={caps} compact />
  </div>;
}
