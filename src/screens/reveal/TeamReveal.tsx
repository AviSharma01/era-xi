import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type RefObject } from "react";

import { FitBadge, PlayerCard, type PlayerCardPlayer, type PlayerCardRatings } from "../../components/PlayerCard.js";
import { DRAFTING_COPY, ERA_COPY, PLAYER_CARD_COPY, REVEAL_COPY as COPY, shortRole, teamAbbreviation } from "../../copy.js";
import type { RevealPlayerView, TeamEvaluationSummaryView } from "../../eraDraftTypes.js";
import type { EraId } from "../../teamEvaluationV2.js";
import { motionMs, useSlotSqueeze, useSmallScreen } from "../drafting/behaviour.js";
import { bowlingCoverage, costlyFit, formatRating, ratingBuild, revealFit, roleRatings, type RatingBuild } from "./build.js";

/** One revealed player: the authoritative reveal row, and the card it was drafted as. */
export type RevealEntry = { readonly player: RevealPlayerView; readonly card: PlayerCardPlayer };

export type TeamRevealProps = {
  eraId: EraId;
  entries: readonly RevealEntry[];
  evaluation: TeamEvaluationSummaryView;
  /** Play the flips first. Only straight after Reveal team, never on a restored game. */
  flip?: boolean;
  onFlipDone?: () => void;
  /** The one button onward ("Start league" in Solo). Sits at the bottom of the panel, or sticky on phones. */
  action?: (ref: RefObject<HTMLButtonElement | null>) => ReactElement;
  /** Draft-Off: names open the season inspector. */
  onInspect?: (playerTeamSeasonId: string) => void;
  /** Whose XI, for the table's caption; Solo leaves it out. */
  ownerName?: string;
  /** Inside a page (Draft-Off results): no viewport-height layout, no sticky action, and focus is left alone. */
  embedded?: boolean;
  headingLevel?: 1 | 2 | 3;
  /** Extra class on each table row. */
  rowClassName?: string;
  warning?: ReactNode;
};

const BATTING_ROWS = [
  { label: DRAFTING_COPY.topOrder, positions: [1, 2, 3] },
  { label: DRAFTING_COPY.middleOrder, positions: [4, 5, 6, 7] },
  { label: DRAFTING_COPY.lowerOrder, positions: [8, 9, 10, 11] },
] as const;

const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The reveal, shared by Solo and Draft-Off: the eleven cards flip in batting order, then the team sheet. */
export function TeamReveal(props: TeamRevealProps): ReactElement {
  // Fixed at mount: the parent may clear `flip` once the cards have turned, and the tick still follows them.
  const [flipped] = useState(Boolean(props.flip));
  const [stage, setStage] = useState<"flip" | "sheet">(flipped ? "flip" : "sheet");
  const entries = [...props.entries].sort((a, b) => a.player.battingPosition - b.player.battingPosition);
  const finished = useRef(false);
  const finish = (): void => {
    if (finished.current) return;
    finished.current = true;
    setStage("sheet");
    props.onFlipDone?.();
  };
  return stage === "flip"
    ? <RevealFlip eraId={props.eraId} entries={entries} warning={props.warning} onDone={finish} />
    : <TeamSheetView {...props} entries={entries} afterFlip={flipped} />;
}

function revealedFace(player: RevealPlayerView): PlayerCardRatings {
  const { batting, bowling } = roleRatings(player);
  return {
    overall: formatRating(player.overallRating),
    ratings: [
      ...(batting === null ? [] : [{ label: COPY.columnBatting, value: formatRating(batting) }]),
      ...(bowling === null ? [] : [{ label: COPY.columnBowling, value: formatRating(bowling) }]),
    ],
  };
}

/**
 * The same board the XI was drafted on. Each card flips (~280ms) in batting order, 100ms apart, and the revealed XI
 * holds (~600ms) before the sheet; with reduced motion each back fades in place, still in sequence, with the same hold.
 * A tap or click anywhere, or Skip, goes straight to the team sheet.
 */
function RevealFlip({ eraId, entries, warning, onDone }: { eraId: EraId; entries: readonly RevealEntry[]; warning?: ReactNode; onDone: () => void }): ReactElement {
  const small = useSmallScreen();
  const era = ERA_COPY[eraId];
  const skipRef = useRef<HTMLButtonElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useSlotSqueeze(rowsRef, !small);
  useEffect(() => {
    skipRef.current?.focus({ preventScroll: true });
    // The last card turns, then all eleven hold together before the sheet. Reduced motion keeps the same timing.
    const total = motionMs("--motion-reveal-stagger") * (entries.length - 1) + motionMs("--motion-reveal-flip") + motionMs("--motion-reveal-hold");
    const timer = setTimeout(() => done.current(), total);
    return () => clearTimeout(timer);
  }, [entries.length]);
  const slot = (position: number): ReactElement | null => {
    const index = entries.findIndex((entry) => entry.player.battingPosition === position);
    const entry = entries[index];
    if (!entry) return null;
    const fit = { fit: entry.player.presentationFit, fitPercent: entry.player.battingAdjustment?.penaltyPercent };
    return <div key={position} className="xi-slot reveal-slot" data-position={position} style={{ "--reveal-order": index } as CSSProperties}>
      <PlayerCard size="slot" state="locked" player={entry.card} slotNumber={position} {...fit} className="reveal-front" label={null} />
      <PlayerCard size="slot" state="locked" player={entry.card} slotNumber={position} {...fit} className="reveal-back" label={null} revealed={revealedFace(entry.player)} />
    </div>;
  };
  // Decorative: the sheet that follows carries every number. Screen readers hear the status and can Skip.
  const board = <section className="xi-board reveal-board" aria-hidden="true">
    <div className="xi-board-heading"><h2>{DRAFTING_COPY.yourXi}</h2></div>
    <div ref={rowsRef} className="xi-rows">
      {BATTING_ROWS.map((row) => <div key={row.label} className="xi-row-group">
        <span className="xi-row-label">{row.label}</span>
        <div className={`xi-row xi-row-${row.positions.length}`}>{row.positions.map(slot)}</div>
      </div>)}
    </div>
  </section>;
  const title = <h1 className="drafting-title">{COPY.revealing}</h1>;
  const skip = <button ref={skipRef} type="button" className="secondary-action reveal-skip" onClick={onDone}>{small ? COPY.tapToSkip : COPY.skip}</button>;
  const status = <p className="sr-status" aria-live="polite">{COPY.revealingStatus}</p>;
  const context = <p className="drafting-context"><span>{era.title} · {era.years}</span><span>{DRAFTING_COPY.lockedCount(11)}</span></p>;
  // A tap anywhere on the board skips; the click lands here from any child.
  if (small) {
    return <div className="drafting drafting-small reveal-flip" onClick={onDone}>
      {warning}
      <div className="drafting-screen drafting-screen-board">{context}{title}{board}</div>
      <div className="drafting-bar">{skip}</div>
      {status}
    </div>;
  }
  return <div className="drafting drafting-split drafting-stage-complete reveal-flip" onClick={onDone}>
    <div className="drafting-head">{context}{warning}</div>
    <div className="drafting-left" />
    <div className="drafting-stage"><section className="drafting-complete">{title}{skip}</section></div>
    {board}
    {status}
  </div>;
}

/** The team rating ticks down from its base to the final number in coral, once, after the flip. */
function useTick(build: RatingBuild | null, final: number, play: boolean): { text: string; ticking: boolean } {
  const [value, setValue] = useState<number | null>(() => (play && build && !reducedMotion() ? build.baseValue : null));
  useEffect(() => {
    if (value === null || !build) return;
    const duration = motionMs("--motion-level-2");
    if (duration <= 0) { setValue(null); return; }
    let frame = 0;
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / duration);
      if (t >= 1) { setValue(null); return; }
      setValue(build.baseValue + (final - build.baseValue) * t);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // Runs once, on mount: later renders only read the value it sets.
  }, []);
  return { text: formatRating(value ?? final), ticking: value !== null };
}

function TeamSheetView(props: TeamRevealProps & { entries: readonly RevealEntry[]; afterFlip: boolean }): ReactElement {
  const { evaluation, entries, embedded = false } = props;
  const small = useSmallScreen();
  const era = ERA_COPY[props.eraId];
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const buildOpenRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const [pressed, setPressed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const build = ratingBuild(evaluation);
  const coverage = bowlingCoverage(evaluation.construction);
  const tick = useTick(build, evaluation.strength.overall, props.afterFlip);
  const costly = entries.filter((entry) => costlyFit(entry.player));
  const highlight = Boolean(build) && (pressed || focused);
  const Heading = (`h${props.headingLevel ?? 1}`) as "h1";

  useEffect(() => { if (!embedded) headingRef.current?.focus({ preventScroll: true }); }, [embedded]);
  useLayoutEffect(() => { if (buildOpen) sheetRef.current?.focus(); }, [buildOpen]);
  useEffect(() => {
    if (!buildOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setBuildOpen(false);
      buildOpenRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [buildOpen]);

  const playersId = `${id}-build-players`;
  const buildLine = build && <>
    <button type="button" className="reveal-build-line" aria-pressed={pressed} aria-label={COPY.buildLabel(build.base, build.loss, build.final)}
      aria-describedby={playersId} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onClick={() => setPressed((value) => !value)}>
      <span>{COPY.base} {build.base}</span><span aria-hidden="true"> · </span>
      <span className="reveal-build-step">{COPY.battingOrder} <span className="reveal-loss">−{build.loss}</span></span>
    </button>
    <span id={playersId} className="sr-status">{COPY.buildPlayers(costly.map((entry) => `${entry.player.playerName} (${revealFit(entry.player).text})`))}</span>
  </>;
  const coverageLine = coverage && <p className="reveal-coverage">{coverage}</p>;
  const action = props.action?.(actionRef);
  const rating = <p className="reveal-rating">
    <span className={tick.ticking ? "reveal-rating-ticking" : undefined} aria-hidden="true">{tick.text}</span>
    <span className="sr-status">{formatRating(evaluation.strength.overall)}</span>
  </p>;
  const table = <TeamSheetTable entries={entries} small={small} highlight={highlight} onInspect={props.onInspect}
    caption={props.ownerName ? COPY.sheetCaptionFor(props.ownerName) : COPY.sheetCaption} rowClassName={props.rowClassName} />;
  const status = !embedded && <p className="sr-status" aria-live="polite">{COPY.revealedStatus}</p>;

  if (small) {
    const closeBuild = (): void => { setBuildOpen(false); buildOpenRef.current?.focus(); };
    const sheet = buildOpen && <section ref={sheetRef} id={`${id}-build`} tabIndex={-1} className="reveal-build-sheet" aria-labelledby={`${id}-build-title`}>
      <div className="reveal-build-sheet-head"><h2 id={`${id}-build-title`}>{COPY.buildTitle}</h2>
        <button type="button" className="quiet-button" onClick={closeBuild}>{COPY.close}</button></div>
      {buildLine}{coverageLine}
    </section>;
    return <div className={`reveal-sheet reveal-sheet-small${embedded ? " reveal-sheet-embedded" : ""}`}>
      {props.warning}
      <section className="reveal-bar" aria-labelledby={`${id}-title`}>
        <Heading id={`${id}-title`} ref={headingRef} tabIndex={-1} className="reveal-rating-title">{COPY.teamRating}</Heading>
        {rating}
        <span className="reveal-bar-components">{COPY.bat} <b>{formatRating(evaluation.strength.batting)}</b> · {COPY.bowl} <b>{formatRating(evaluation.strength.bowling)}</b></span>
        {build && <span className="reveal-loss reveal-bar-loss"><span className="sr-status">{COPY.battingOrder} </span>−{build.loss}</span>}
        {(build || coverage) && <button ref={buildOpenRef} type="button" className="quiet-button reveal-build-open" aria-expanded={buildOpen}
          aria-controls={`${id}-build`} onClick={() => setBuildOpen((open) => !open)}>{COPY.build} <span aria-hidden="true">›</span></button>}
      </section>
      {embedded && sheet}
      {table}
      {/* The sheet rises above Start league, which stays on screen; the table above it shows the highlight. */}
      {!embedded && (action || sheet) && <div className="reveal-dock">{sheet}{action && <div className="reveal-action">{action}</div>}</div>}
      {status}
    </div>;
  }

  return <div className={`reveal-sheet${embedded ? " reveal-sheet-embedded" : ""}`}>
    {props.warning && <div className="reveal-sheet-warning">{props.warning}</div>}
    <section className="reveal-panel" aria-labelledby={`${id}-title`}>
      <p className="reveal-era">{era.title} · {era.years}</p>
      <Heading id={`${id}-title`} ref={headingRef} tabIndex={-1} className="reveal-rating-title">{COPY.teamRating}</Heading>
      {rating}
      <dl className="reveal-components">
        <div><dt>{COPY.batting}</dt><dd>{formatRating(evaluation.strength.batting)}</dd></div>
        <div><dt>{COPY.bowling}</dt><dd>{formatRating(evaluation.strength.bowling)}</dd></div>
      </dl>
      {(build || coverage) && <div className="reveal-build">{buildLine}{coverageLine}</div>}
      {action && <div className="reveal-action">{action}</div>}
    </section>
    {table}
    {status}
  </div>;
}

function TeamSheetTable(props: {
  entries: readonly RevealEntry[];
  small: boolean;
  highlight: boolean;
  caption: string;
  rowClassName?: string;
  onInspect?: (playerTeamSeasonId: string) => void;
}): ReactElement {
  const { small, onInspect } = props;
  const [open, setOpen] = useState<string | null>(null);
  const header = (short: string, name: string, className: string): ReactElement =>
    <th scope="col" className={className}><span aria-hidden="true">{short}</span><span className="sr-status">{name}</span></th>;
  const number = (value: number | null, className: string): ReactElement => <td className={className}>{value === null
    ? <><span aria-hidden="true">{COPY.noRating}</span><span className="sr-status">{COPY.noRatingName}</span></>
    : formatRating(value)}</td>;
  return <div className="team-sheet-wrap">
    <table className={`team-sheet${small ? " team-sheet-small" : ""}`}>
      <caption className="sr-status">{props.caption}</caption>
      <thead><tr>
        {header(COPY.columnPosition, COPY.columnPositionName, "team-sheet-position")}
        <th scope="col" className="team-sheet-player">{COPY.columnPlayer}</th>
        <th scope="col" className="team-sheet-tier">{COPY.columnTier}</th>
        {header(COPY.columnOverall, COPY.columnOverallName, "team-sheet-number")}
        {!small && header(COPY.columnBatting, COPY.columnBattingName, "team-sheet-number")}
        {!small && header(COPY.columnBowling, COPY.columnBowlingName, "team-sheet-number")}
        <th scope="col" className="team-sheet-fit">{COPY.columnFit}</th>
      </tr></thead>
      <tbody>{props.entries.map(({ player, card }) => {
        const id = player.playerTeamSeasonId;
        const { batting, bowling } = roleRatings(player);
        const expanded = small && open === id;
        const highlighted = props.highlight && costlyFit(player);
        const meta = `${teamAbbreviation(player.teamId, player.teamName)} · ${player.seasonYear} · ${shortRole(player.displayRole)}`;
        const name = <><strong>{player.playerName}</strong><span className="team-sheet-meta">{meta}</span></>;
        // Phones tap a row for its batting and bowling; Draft-Off names open the season inspector.
        const identity = small
          ? <button type="button" className="team-sheet-name" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : id)}>{name}<span className="sr-status">{COPY.showRatings}</span></button>
          : onInspect ? <button type="button" className="team-sheet-name" onClick={() => onInspect(id)}><span className="sr-status">{COPY.inspect}</span>{name}</button>
            : <span className="team-sheet-name">{name}</span>;
        const tier = PLAYER_CARD_COPY.tier(player.qualityTier);
        return <tr key={id} className={[`revealed-player revealed-tier-${player.qualityTier.toLowerCase()}`, highlighted ? "team-sheet-highlight" : "", props.rowClassName ?? ""].filter(Boolean).join(" ")}>
          <td className="team-sheet-position">{String(player.battingPosition).padStart(2, "0")}</td>
          <th scope="row" className="team-sheet-player">
            {identity}
            {expanded && <span className="team-sheet-detail">
              <span>{COPY.bat} <b>{batting === null ? COPY.noRating : formatRating(batting)}</b> · {COPY.bowl} <b>{bowling === null ? COPY.noRating : formatRating(bowling)}</b></span>
              {onInspect && <button type="button" className="quiet-button" onClick={() => onInspect(id)}>{COPY.inspectSeason}</button>}
            </span>}
          </th>
          <td className="team-sheet-tier"><span className={`team-sheet-swatch tier-${card.tierAppearance}`} aria-hidden="true" /><span aria-hidden="true">{player.qualityTier}</span><span className="sr-status">{tier}</span></td>
          <td className="team-sheet-number revealed-overall">{formatRating(player.overallRating)}</td>
          {!small && number(batting, "team-sheet-number")}
          {!small && number(bowling, "team-sheet-number")}
          <td className="team-sheet-fit"><FitBadge fit={player.presentationFit} percent={player.battingAdjustment?.penaltyPercent} /></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
