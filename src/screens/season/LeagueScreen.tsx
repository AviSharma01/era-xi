import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type RefObject } from "react";

import { LEAGUE_COPY as COPY, ordinal } from "../../copy.js";
import type { EraDraftGameCompleteView, SeasonMatchView, SeasonStandingView, UserLeagueCheckpointView } from "../../eraDraftTypes.js";
import type { EraDraftPresentationCursor } from "../../eraDraftUiPersistence.js";
import { motionMs, useSmallScreen } from "../drafting/behaviour.js";
import { formatNetRunRate, formatOvers, formatScore, isCloseMatch, matchMargin } from "./match.js";

type LeagueCursor = Extract<EraDraftPresentationCursor, { phase: "LEAGUE" | "LEAGUE_COMPLETE" }>;

export type LeagueScreenProps = {
  view: EraDraftGameCompleteView;
  cursor: LeagueCursor;
  /** Straight after Start league: auto-play runs and match 1 counts as revealed live. A resumed game opens paused. */
  live: boolean;
  /** Opponents' short names ("MI 2013"), by team id, for narrow tables and phones. */
  shortNames: ReadonlyMap<string, string>;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onCursor: (cursor: EraDraftPresentationCursor) => void;
};

const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const canAnimate = (element: Element | null | undefined): element is HTMLElement => typeof (element as HTMLElement | null)?.animate === "function";
const easing = (token: string): string => (typeof window === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(token).trim()) || "ease-out";

/**
 * The Solo league: one screen, two real layouts. While the league runs, matches reveal one at a time through the saved
 * presentation cursor (exactly as one "Next match" step each) beside the live table. At the end the layout switches to
 * league complete; the ~500ms move between them is decoration that snaps to its end if interrupted.
 */
export function LeagueScreen(props: LeagueScreenProps): ReactElement {
  const { view, cursor } = props;
  const matches = view.league.userMatches;
  const total = matches.length;
  const complete = cursor.phase === "LEAGUE_COMPLETE";
  const revealed = complete ? total : cursor.revealedUserMatches;
  const small = useSmallScreen();
  const id = useId();
  // Matches from this index on are revealed in front of the player; earlier ones were already seen (a resumed save).
  const [liveFrom] = useState(() => (props.live ? 0 : revealed));
  const [openedComplete] = useState(complete);
  const [paused, setPaused] = useState(!props.live);
  const hidden = usePageHidden();
  const [details, setDetails] = useState<number | null>(null);
  const pipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const pipsRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLElement>(null);

  // Auto-play: one match per --motion-league-match, then league complete. Pause, a hidden tab or open match details hold it.
  const advance = useRef<() => void>(() => undefined);
  advance.current = () => props.onCursor(revealed < total
    ? { phase: "LEAGUE", revealedUserMatches: revealed + 1 }
    : { phase: "LEAGUE_COMPLETE" });
  useEffect(() => {
    if (complete || paused || hidden || details !== null) return;
    const timer = setTimeout(() => advance.current(), motionMs("--motion-league-match"));
    return () => clearTimeout(timer);
  }, [complete, revealed, paused, hidden, details]);

  useCompleteMove(complete, rootRef, [pipsRef, tableRef], props.headingRef);

  const closeDetails = (restoreFocus: boolean): void => {
    const index = details;
    setDetails(null);
    if (restoreFocus && index !== null) pipRefs.current[index]?.focus();
  };
  const fresh = !complete && revealed - 1 >= liveFrom ? revealed - 1 : null;
  const latest = matches[revealed - 1]!;
  const status = complete
    ? openedComplete ? "" : COPY.completeStatus(view.league.userFinalPosition, view.league.qualified)
    : fresh === null ? "" : COPY.status(latest.matchNumber, resultLine(latest.match), latest.record.won, latest.record.lost, latest.position);

  const pips = <PipStrip ref={pipsRef} matches={matches} revealed={revealed} fresh={fresh} compact={complete} small={small}
    details={details} pipRefs={pipRefs} onOpen={(index) => setDetails(details === index ? null : index)} onClose={closeDetails} />;
  const announcer = <p className="sr-status" aria-live="polite">{status}</p>;

  if (complete) {
    const { league } = view;
    const outcome = league.qualified
      ? COPY.outcomeQualified(league.userFinalPosition, league.userRecord.won, league.userRecord.lost)
      : COPY.outcomeOut(league.userFinalPosition, league.userRecord.won, league.userRecord.lost);
    return <div ref={rootRef} className="league league-complete">
      <header className="league-complete-head" data-league-fade>
        <h1 ref={props.headingRef} tabIndex={-1} id={`${id}-title`}>{COPY.completeTitle}</h1>
        <p className={`league-outcome${league.qualified ? " league-outcome-in" : ""}`}>{outcome}</p>
      </header>
      {pips}
      <Standings ref={tableRef} rows={league.finalStandings} final shortNames={props.shortNames} />
      <div className="league-complete-action" data-league-fade>
        <button type="button" className="primary-action" onClick={() => props.onCursor(league.qualified
          ? { phase: "PLAYOFFS", revealedPlayoffMatches: 1 }
          : { phase: "COMPLETE" })}>{league.qualified ? COPY.beginPlayoffs : COPY.seeSeason} <span aria-hidden="true">→</span></button>
      </div>
      {announcer}
    </div>;
  }

  const won = latest.match.result === "WIN";
  const user = latest.match.firstInnings.teamId === "user" ? latest.match.firstInnings : latest.match.secondInnings;
  const opponent = latest.match.firstInnings.teamId === "user" ? latest.match.secondInnings : latest.match.firstInnings;
  return <div ref={rootRef} className="league league-live">
    <section className="league-feed" aria-labelledby={`${id}-title`}>
      <div className="league-feed-head">
        <h1 ref={props.headingRef} tabIndex={-1} id={`${id}-title`}>{COPY.title}</h1>
        <p className="league-count">{COPY.matchOf(revealed, total)}</p>
      </div>
      {pips}
      <div key={latest.match.matchId} className={`league-latest league-latest-${won ? "win" : "loss"}`}>
        <p className="league-latest-line">
          <Verdict won={won} /><span aria-hidden="true" className="league-latest-dot"> · </span>
          <span>{resultLine(latest.match)}</span>
        </p>
        <p className="league-latest-score">
          {COPY.yourXi} {formatScore(user.runs, user.wickets)}<span aria-hidden="true"> · </span>
          <TeamName teamId={opponent.teamId} teamName={opponent.teamName} shortNames={props.shortNames} short={small} /> {formatScore(opponent.runs, opponent.wickets)}
        </p>
      </div>
      <dl className="league-summary">
        <div><dt>{COPY.record}</dt><dd>{latest.record.won}–{latest.record.lost}</dd></div>
        <div><dt>{COPY.position}</dt><dd>{ordinal(latest.position)} <small>{COPY.movement(latest.movement, latest.previousPosition)}</small></dd></div>
      </dl>
    </section>
    <div className="league-controls">
      <button type="button" className={paused ? "primary-action" : "secondary-action"} onClick={() => setPaused((value) => !value)}>
        <span aria-hidden="true" className="league-control-icon">{paused ? <PlayIcon /> : <PauseIcon />}</span>{paused ? COPY.resume : COPY.pause}
      </button>
      <button type="button" className="secondary-action" onClick={() => props.onCursor({ phase: "LEAGUE_COMPLETE" })}>{COPY.skip}</button>
      {paused && <span className="league-paused">{COPY.paused}</span>}
    </div>
    <Standings ref={tableRef} rows={latest.standings} final={false} shortNames={props.shortNames} />
    {announcer}
  </div>;
}

/** A short name on screen ("MI 2013") with the full name for screen readers; the full name when it has no short one. */
function TeamName(props: { teamId: string; teamName: string; shortNames: ReadonlyMap<string, string>; short: boolean }): ReactElement {
  const short = props.shortNames.get(props.teamId);
  if (!props.short || !short || short === props.teamName) return <>{props.teamName}</>;
  return <><span aria-hidden="true">{short}</span><span className="sr-status">{props.teamName}</span></>;
}

/** "Your XI beat Mumbai Indians 2013 by 6 wickets", in plain cricket words. */
export function resultLine(match: SeasonMatchView): string {
  const opponent = match.firstInnings.teamId === "user" ? match.secondInnings : match.firstInnings;
  return COPY.resultLine(match.result === "WIN", opponent.teamName, matchMargin(match));
}

function Verdict({ won }: { won: boolean }): ReactElement {
  return <span className={`league-verdict league-verdict-${won ? "win" : "loss"}`}>
    <span aria-hidden="true">{won ? COPY.win : COPY.loss}</span>{won ? <TickIcon /> : <CrossIcon />}
    <span className="sr-status">{won ? COPY.winName : COPY.lossName}</span>
  </span>;
}

const TickIcon = (): ReactElement => <svg className="league-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.2 6.4l2.4 2.4 5.2-5.6" /></svg>;
const CrossIcon = (): ReactElement => <svg className="league-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3 3l6 6M9 3l-6 6" /></svg>;
const PauseIcon = (): ReactElement => <svg className="league-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M4 2.5v7M8 2.5v7" /></svg>;
const PlayIcon = (): ReactElement => <svg className="league-icon league-icon-fill" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3.5 2.2v7.6L9.8 6z" /></svg>;

/**
 * The 14 pips: W in mint with a tick, L in coral with a cross, upcoming dim. One tab stop; arrow keys, Home and End
 * move between played pips. A played pip opens its scores. Only the pip revealed live gets the fill, and a close match's
 * burst (win) or flash (loss) on top; close pips keep a marker.
 */
function PipStrip(props: {
  ref: RefObject<HTMLDivElement | null>;
  matches: readonly UserLeagueCheckpointView[];
  revealed: number;
  fresh: number | null;
  compact: boolean;
  small: boolean;
  details: number | null;
  pipRefs: RefObject<(HTMLButtonElement | null)[]>;
  onOpen: (index: number) => void;
  onClose: (restoreFocus: boolean) => void;
}): ReactElement {
  const { matches, revealed } = props;
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const stop = Math.min(focusIndex ?? revealed - 1, revealed - 1);
  const anyClose = matches.slice(0, revealed).some((checkpoint) => isCloseMatch(checkpoint.match));
  const move = (event: KeyboardEvent<HTMLOListElement>): void => {
    const current = props.pipRefs.current.findIndex((pip) => pip === document.activeElement);
    if (current < 0) return;
    const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? Math.min(current + 1, revealed - 1)
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? Math.max(current - 1, 0)
        : event.key === "Home" ? 0 : event.key === "End" ? revealed - 1 : null;
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    props.pipRefs.current[next]?.focus();
  };
  const open = props.details === null ? null : matches[props.details] ?? null;
  return <div ref={props.ref} className={`league-pips-wrap${props.compact ? " league-pips-compact" : ""}`}>
    <ol className="league-pips" aria-label={COPY.pipsLabel(revealed)} onKeyDown={move}>
      {matches.map((checkpoint, index) => {
        const number = String(checkpoint.matchNumber).padStart(2, "0");
        if (index >= revealed) {
          return <li key={checkpoint.match.matchId}><span className="league-pip league-pip-upcoming">
            <span aria-hidden="true">{number}</span><span className="sr-status">{COPY.pipUpcoming(checkpoint.matchNumber)}</span>
          </span></li>;
        }
        const won = checkpoint.match.result === "WIN";
        const close = isCloseMatch(checkpoint.match);
        const fresh = index === props.fresh;
        const classes = ["league-pip", `league-pip-${won ? "win" : "loss"}`, close ? "league-pip-close" : "",
          fresh ? "league-pip-fresh" : "", fresh && close ? (won ? "league-pip-burst" : "league-pip-flash") : ""].filter(Boolean).join(" ");
        return <li key={checkpoint.match.matchId}>
          <button ref={(element) => { props.pipRefs.current[index] = element; }} type="button" className={classes}
            tabIndex={index === stop ? 0 : -1} aria-haspopup="dialog" aria-expanded={props.details === index}
            aria-label={COPY.pipLabel(checkpoint.matchNumber, resultLine(checkpoint.match), won, close)}
            onFocus={() => setFocusIndex(index)} onClick={() => props.onOpen(index)}>
            <span className="league-pip-letter">{won ? COPY.win : COPY.loss}</span>{won ? <TickIcon /> : <CrossIcon />}
            {close && <span className="league-pip-marker" />}
          </button>
        </li>;
      })}
    </ol>
    {anyClose && <p className="league-pips-legend"><span className="league-pip-marker" aria-hidden="true" />{COPY.closeMatch}</p>}
    {open && <MatchDetails checkpoint={open} small={props.small} anchor={props.pipRefs.current[props.details!] ?? null}
      wrap={props.ref} onClose={props.onClose} />}
  </div>;
}

/**
 * A played match's scores: a popover beside the pip on desktop, a bottom sheet on phones. Escape or Close returns focus
 * to the pip; a click outside, or tabbing out of the popover, closes it.
 */
function MatchDetails(props: {
  checkpoint: UserLeagueCheckpointView;
  small: boolean;
  anchor: HTMLButtonElement | null;
  wrap: RefObject<HTMLDivElement | null>;
  onClose: (restoreFocus: boolean) => void;
}): ReactElement {
  const { checkpoint, small } = props;
  const { match } = checkpoint;
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const [left, setLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    closeRef.current?.focus();
    if (small) return;
    const wrap = props.wrap.current, anchor = props.anchor, popover = ref.current;
    if (!wrap || !anchor || !popover) return;
    const centre = anchor.getBoundingClientRect().left + anchor.offsetWidth / 2 - wrap.getBoundingClientRect().left;
    setLeft(Math.max(0, Math.min(wrap.clientWidth - popover.offsetWidth, centre - popover.offsetWidth / 2)));
  }, [small, props.anchor, props.wrap]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => { if (event.key === "Escape") { event.preventDefault(); onClose.current(true); } };
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (ref.current?.contains(target) || (target instanceof Element && target.closest(".league-pip"))) return;
      onClose.current(false);
    };
    window.addEventListener("keydown", onKey);
    if (!small) window.addEventListener("pointerdown", onPointer);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onPointer); };
  }, [small]);
  const won = match.result === "WIN";
  const opponent = match.firstInnings.teamId === "user" ? match.secondInnings : match.firstInnings;
  const innings = (side: SeasonMatchView["firstInnings"]): ReactElement => {
    const name = side.teamId === "user" ? COPY.yourXi : side.teamName;
    const overs = formatOvers(side.balls);
    return <div className={`league-innings${side.teamId === "user" ? " league-innings-user" : ""}`}>
      <span className="league-innings-team">{name}</span>
      <span className="league-innings-score">{formatScore(side.runs, side.wickets)}</span>
      <span className="league-innings-overs"><span aria-hidden="true">{COPY.overs(overs)}</span><span className="sr-status">{COPY.oversName(overs)}</span></span>
    </div>;
  };
  const body = <>
    <div className="league-details-head">
      <h2 id={`${id}-title`}>{COPY.detailsTitle(checkpoint.matchNumber, opponent.teamName)}</h2>
      <button ref={closeRef} type="button" className="quiet-button" onClick={() => props.onClose(true)}>{COPY.close}</button>
    </div>
    {innings(match.firstInnings)}
    {innings(match.secondInnings)}
    <p className={`league-details-result league-latest-${won ? "win" : "loss"}`}>
      <Verdict won={won} /><span>{resultLine(match)}</span>
    </p>
    {isCloseMatch(match) && <p className="league-details-close"><span className="league-pip-marker" aria-hidden="true" />{COPY.closeMatch}</p>}
  </>;
  if (small) {
    // A modal sheet: focus stays on Close, its one control, until it closes.
    return <>
      <div className="league-sheet-scrim" aria-hidden="true" onClick={() => props.onClose(true)} />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="league-sheet"
        onKeyDown={(event) => { if (event.key === "Tab") { event.preventDefault(); closeRef.current?.focus(); } }}>{body}</div>
    </>;
  }
  // Focusable, so a click on its text keeps focus inside instead of closing it.
  return <div ref={ref} role="dialog" aria-labelledby={`${id}-title`} tabIndex={-1} className="league-popover"
    style={left === null ? { visibility: "hidden" } : { left }}
    onBlur={(event) => { if (!ref.current?.contains(event.relatedTarget as Node | null) && !(event.relatedTarget as Element | null)?.closest?.(".league-pip")) props.onClose(false); }}>{body}</div>;
}

/**
 * The table: pos, team, P, W, L, Pts and NRR, your row lit with the ivory edge. Rows slide to their new order after each
 * match (a fade with reduced motion). The final table draws the playoff line between 4th and 5th. A narrow table shows
 * team-seasons as "MI 2013"; the full name stays for screen readers.
 */
function Standings(props: { ref: RefObject<HTMLElement | null>; rows: readonly SeasonStandingView[]; final: boolean; shortNames: ReadonlyMap<string, string> }): ReactElement {
  const { rows, final } = props;
  const id = useId();
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  useRowSlide(bodyRef, rows.map((row) => row.teamId).join("|"));
  const header = (short: string, name: string, className?: string): ReactElement =>
    <th scope="col" className={className}><span aria-hidden="true">{short}</span><span className="sr-status">{name}</span></th>;
  return <section ref={props.ref} className={`league-table${final ? " league-table-final" : ""}`} aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`} className="league-table-title">{final ? COPY.finalTableTitle : COPY.tableTitle}</h2>
    <table>
      <caption className="sr-status">{COPY.tableCaption}</caption>
      <thead><tr>
        {header(COPY.columnPosition, COPY.columnPositionName, "league-col-pos")}
        <th scope="col" className="league-col-team">{COPY.columnTeam}</th>
        {header(COPY.columnPlayed, COPY.columnPlayedName)}
        {header(COPY.columnWon, COPY.columnWonName)}
        {header(COPY.columnLost, COPY.columnLostName)}
        {header(COPY.columnPoints, COPY.columnPointsName)}
        {header(COPY.columnNetRunRate, COPY.columnNetRunRateName, "league-col-nrr")}
      </tr></thead>
      <tbody ref={bodyRef}>{rows.flatMap((row) => {
        const short = props.shortNames.get(row.teamId) ?? row.teamName;
        const cells = <tr key={row.teamId} data-team={row.teamId} className={row.isUser ? "league-row-user" : undefined}>
          <td className="league-col-pos">{row.position}</td>
          <th scope="row" className="league-col-team">
            {row.isUser ? COPY.yourXi : short === row.teamName ? row.teamName
              : <><span className="league-name-full">{row.teamName}</span><span className="league-name-short" aria-hidden="true">{short}</span></>}
            {final && row.qualified === true && <span className="sr-status">, {COPY.qualified}</span>}
          </th>
          <td>{row.played}</td><td>{row.won}</td><td>{row.lost}</td><td className="league-col-pts">{row.points}</td>
          <td className="league-col-nrr">{formatNetRunRate(row.netRunRate)}</td>
        </tr>;
        return final && row.position === 4 && rows.length > 4
          ? [cells, <tr key="playoff-line" className="league-playoff-line" data-league-fade><td colSpan={7}>{COPY.playoffLine}</td></tr>]
          : [cells];
      })}</tbody>
    </table>
  </section>;
}

/** After each match, rows that changed place slide from where they were (~300ms); with reduced motion they fade. */
function useRowSlide(bodyRef: RefObject<HTMLTableSectionElement | null>, order: string): void {
  const tops = useRef(new Map<string, number>());
  const lastOrder = useRef(order);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const rows = [...body.querySelectorAll<HTMLTableRowElement>("tr[data-team]")];
    const next = new Map(rows.map((row) => [row.dataset.team!, row.offsetTop]));
    const changed = order !== lastOrder.current;
    lastOrder.current = order;
    if (changed && canAnimate(rows[0])) {
      const duration = motionMs("--motion-standings-slide");
      const reduce = reducedMotion();
      for (const row of rows) {
        const before = tops.current.get(row.dataset.team!);
        const after = next.get(row.dataset.team!)!;
        if (before === undefined || before === after || duration <= 0) continue;
        row.animate(reduce ? [{ opacity: 0.4 }, { opacity: 1 }] : [{ transform: `translateY(${before - after}px)` }, { transform: "none" }],
          { duration, easing: easing("--ease-standard") });
      }
    }
    tops.current = next;
  });
}

/**
 * League complete: the pips and the table move from where they were into the final layout (~500ms, transform only) and
 * the rest fades in; with reduced motion the final layout fades in. The final layout is already in place, so any key,
 * pointer or a hidden tab snaps the move to its end.
 */
function useCompleteMove(
  complete: boolean,
  rootRef: RefObject<HTMLElement | null>,
  parts: readonly RefObject<HTMLElement | null>[],
  headingRef: RefObject<HTMLHeadingElement | null>,
): void {
  const last = useRef<(DOMRect | null)[]>([]);
  const wasComplete = useRef(complete);
  useLayoutEffect(() => {
    const switched = complete && !wasComplete.current;
    wasComplete.current = complete;
    const root = rootRef.current;
    if (!switched || !root) return;
    // Focus first, so any scroll it causes belongs to the new layout before it is measured.
    headingRef.current?.focus();
    const duration = motionMs("--motion-league-complete");
    if (duration <= 0 || !canAnimate(root)) return;
    const timing = { duration, easing: easing("--ease-standard") };
    const animations: Animation[] = [];
    if (reducedMotion()) animations.push(root.animate([{ opacity: 0 }, { opacity: 1 }], timing));
    else {
      parts.forEach((part, index) => {
        const element = part.current, from = last.current[index];
        if (!element || !from) return;
        const to = element.getBoundingClientRect();
        const dx = from.left + from.width / 2 - (to.left + to.width / 2);
        animations.push(element.animate([{ transform: `translate(${dx}px, ${from.top - to.top}px)`, opacity: 0.6 }, { transform: "none", opacity: 1 }], timing));
      });
      root.querySelectorAll<HTMLElement>("[data-league-fade]").forEach((element) => animations.push(element.animate([{ opacity: 0 }, { opacity: 1 }], timing)));
    }
    // Everything moving in the league snaps, including rows still sliding to the final order after Skip to end.
    const finish = (): void => {
      for (const animation of [...animations, ...root.getAnimations({ subtree: true })]) {
        if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish();
      }
    };
    const onVisibility = (): void => { if (document.visibilityState === "hidden") finish(); };
    window.addEventListener("pointerdown", finish, true);
    window.addEventListener("keydown", finish, true);
    document.addEventListener("visibilitychange", onVisibility);
    const detach = (): void => {
      window.removeEventListener("pointerdown", finish, true);
      window.removeEventListener("keydown", finish, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    void Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(detach);
    return () => { finish(); detach(); };
  }, [complete]);
  // Where the parts sit in the running league, for the move. Every render, after the move above has read it.
  useLayoutEffect(() => {
    if (!complete) last.current = parts.map((part) => part.current?.getBoundingClientRect() ?? null);
  });
}

function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.visibilityState === "hidden");
  useEffect(() => {
    const update = (): void => setHidden(document.visibilityState === "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return hidden;
}
