import { useEffect, useState, useSyncExternalStore, type CSSProperties, type MouseEventHandler, type ReactElement, type ReactNode } from "react";

import { DRAFTING_COPY, fitDisplay, fitLabel, friendly, PLAYER_CARD_COPY as COPY, rosterLabel, shortRole, teamAbbreviation } from "../copy.js";
import type {
  DraftHistoricalStatsView,
  DraftPlayerFactsView,
  DraftPresentationFit,
  DraftTierAppearance,
} from "../eraDraftTypes.js";

export type PlayerCardSize = "big" | "slot" | "mini";
export type PlayerCardState = "default" | "selected" | "preview" | "pending" | "locked" | "unavailable";
export type PlayerCardPlayer = Pick<DraftPlayerFactsView, "playerTeamSeasonId" | "playerName" | "teamId" | "teamName" | "seasonYear" | "displayRole" | "rosterStatus" | "keeperCapability"> & {
  readonly tierAppearance: DraftTierAppearance;
  readonly historicalStats?: DraftHistoricalStatsView;
};

export type PlayerCardProps = {
  player: PlayerCardPlayer;
  size: PlayerCardSize;
  state?: PlayerCardState;
  /** Batting position shown on the card. */
  slotNumber?: number;
  /** Staggers resting sheens so a row of cards does not sweep in unison. */
  order?: number;
  /** S slot cards on one board take turns: this card's turn, and how many S cards share the board. */
  sheenTurn?: { readonly index: number; readonly of: number };
  fit?: DraftPresentationFit;
  /** V3 games: the slot's nominal loss. Historical games have none and show the label alone. */
  fitPercent?: number;
  /** Era title for the "His best <era> season" line on the big card. */
  eraTitle?: string;
  unavailableReason?: string;
  note?: string;
  /** Each new non-null value plays the tier's selection flash once. */
  flashKey?: string | number | null;
  /** Empty by default; future player tags hang here from the top edge. */
  ribbon?: ReactNode;
  /** Renders the whole card as a button. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Accessible name. Defaults to playerCardName; null when an enclosing control names it. */
  label?: string | null;
  pressed?: boolean;
  nameId?: string;
  className?: string;
};

const TIER_LETTERS: Readonly<Record<DraftTierAppearance, string>> = { violet: "S", gold: "A", cobalt: "B", emerald: "C", slate: "D" };

/** "JP Duminy, S tier, Delhi Daredevils 2014, Batter". The tier letter is never drawn on the card. */
export function playerCardName(player: PlayerCardPlayer): string {
  return `${player.playerName}, ${COPY.tier(TIER_LETTERS[player.tierAppearance])}, ${player.teamName} ${player.seasonYear}, ${friendly(player.displayRole)}`;
}

export function monogram(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export function fitClass(fit: DraftPresentationFit): string {
  return (fit === "UNKNOWN" ? "ACCEPTABLE" : fit).toLowerCase().replaceAll("_", "-");
}

/** The label always carries the fit; a percentage is added for v3 games, in coral only for a loss. */
export function FitBadge({ fit, percent }: { fit: DraftPresentationFit; percent?: number }): ReactElement {
  if (percent === undefined) return <span className={`fit-badge fit-${fitClass(fit)}`}>{fitLabel(fit)}</span>;
  const display = fitDisplay(fit, percent);
  return <span className="fit-badge fit-badge-percent">{display.label}{display.loss
    ? <> <span className="fit-percent-loss">{display.percent}</span></>
    : <span className="sr-status">{DRAFTING_COPY.noLoss}</span>}</span>;
}

// Only one S card shimmers at a time: the most recent claimant holds the shimmer, and
// it passes back when that card stops asking (an inspector closing, a hover ending).
let shimmerClaims: readonly symbol[] = [];
const shimmerListeners = new Set<() => void>();
function setShimmerClaims(next: readonly symbol[]): void {
  shimmerClaims = next;
  shimmerListeners.forEach((listener) => listener());
}
function subscribeShimmer(listener: () => void): () => void {
  shimmerListeners.add(listener);
  return () => { shimmerListeners.delete(listener); };
}
function useShimmer(wanted: boolean): boolean {
  const [claim] = useState(() => Symbol("shimmer"));
  useEffect(() => {
    if (!wanted) return;
    setShimmerClaims([...shimmerClaims, claim]);
    return () => setShimmerClaims(shimmerClaims.filter((item) => item !== claim));
  }, [wanted, claim]);
  return useSyncExternalStore(subscribeShimmer, () => shimmerClaims.at(-1) === claim, () => false);
}

type CardStat = { value: string; label: string };
function roleStats(player: PlayerCardPlayer, short: boolean): CardStat[] {
  if (!player.historicalStats || player.displayRole === "UNKNOWN") return [];
  const { batting, bowling } = player.historicalStats.currentSeason;
  const runs = { value: String(batting.runs), label: COPY.runs(batting.runs) };
  const wickets = { value: String(bowling.wickets), label: short ? COPY.wicketsShort(bowling.wickets) : COPY.wickets(bowling.wickets) };
  if (player.displayRole === "ALL_ROUNDER") return [runs, wickets];
  if (player.displayRole === "BOWLER") return [wickets, { value: bowling.economy === null ? "—" : bowling.economy.toFixed(2), label: COPY.economy }];
  return [runs, { value: batting.strikeRate === null ? "—" : batting.strikeRate.toFixed(1), label: COPY.strikeRate }];
}

function isEraBest(player: PlayerCardPlayer): boolean {
  if (!player.historicalStats) return false;
  const { batting, bowling } = player.historicalStats.eraBest;
  const bestBatting = batting?.playerTeamSeasonId === player.playerTeamSeasonId;
  const bestBowling = bowling?.playerTeamSeasonId === player.playerTeamSeasonId;
  if (player.displayRole === "ALL_ROUNDER") return bestBatting || bestBowling;
  if (player.displayRole === "BOWLER") return bestBowling;
  return player.displayRole !== "UNKNOWN" && bestBatting;
}

function Stats({ stats, size, seasonYear }: { stats: CardStat[]; size: PlayerCardSize; seasonYear: number }): ReactElement {
  const lines = stats.length > 0
    ? stats.map((stat) => <span className="player-card-stat" key={stat.label}><b>{stat.value}</b> {stat.label}</span>)
    : <span className="player-card-stat">{COPY.noStats}</span>;
  return size === "big"
    ? <span className="player-card-stats" role="group" aria-label={COPY.seasonStats(seasonYear)}>{lines}</span>
    : <span className="player-card-stats">{lines}</span>;
}

/** The no-entry mark beside a "can't pick" reason. Decorative: the words carry the reason. */
export function NoEntryIcon(): ReactElement {
  return <svg className="no-entry-icon" aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor"><circle cx="8" cy="8" r="6.25" /><path d="M3.6 12.4 12.4 3.6" /></svg>;
}

function StateMarker({ state }: { state: PlayerCardState }): ReactElement | null {
  if (state === "preview") return <span className="player-card-marker">{COPY.preview}</span>;
  if (state === "pending") return <span className="player-card-marker">{COPY.locking}</span>;
  if (state === "locked") {
    return <span className="player-card-marker player-card-lock"><svg role="img" aria-label={COPY.locked} viewBox="0 0 12 14" fill="none" stroke="currentColor"><rect x="2" y="6" width="8" height="7" rx="1" /><path d="M4 6V4a2 2 0 0 1 4 0v2" /></svg></span>;
  }
  return null;
}

export function PlayerCard(props: PlayerCardProps): ReactElement {
  const { player, size, state = "default", slotNumber, fit, fitPercent, eraTitle, note, flashKey = null, ribbon, onClick, nameId } = props;
  const isS = player.tierAppearance === "violet";
  const finishShowing = state !== "preview" && state !== "unavailable";
  const [engaged, setEngaged] = useState(false);
  const shimmering = useShimmer(isS && finishShowing && (size === "big" || (size === "slot" && (engaged || state === "selected"))));
  // D appears with no flash, and an unavailable card opens without one.
  const flashing = flashKey !== null && state !== "unavailable" && player.tierAppearance !== "slate";
  const reason = state === "unavailable" ? props.unavailableReason ?? COPY.unavailable : null;
  // A card that can't be picked says why in its name, as well as on its face.
  const label = props.label === undefined ? (reason ? `${playerCardName(player)}. ${reason}` : playerCardName(player)) : props.label;
  const stats = roleStats(player, size !== "big");
  const number = slotNumber === undefined ? null : <span className="player-card-number">{String(slotNumber).padStart(2, "0")}</span>;
  const portrait = <span className="player-card-portrait" aria-hidden="true"><span>{monogram(player.playerName)}</span></span>;
  const NameTag = size === "big" && !onClick ? "h3" : "strong";
  const name = <NameTag className="player-card-name" id={nameId}>{player.playerName}</NameTag>;
  const fitTag = fit && <span className="player-card-fit"><FitBadge fit={fit} percent={fitPercent} /></span>;
  const noteLine = note && <span className="player-card-note">{note}</span>;
  const reasonLine = reason && <span className="player-card-reason">{reason}</span>;
  const shortTeam = `${teamAbbreviation(player.teamId, player.teamName)} · ${player.seasonYear}`;
  const role = friendly(player.displayRole);

  const className = [
    "player-card", `player-card-${size}`, `player-card-state-${state}`, `tier-${player.tierAppearance}`,
    shimmering ? "player-card-shimmer" : "", flashing ? "player-card-flash-active" : "", props.className ?? "",
  ].filter(Boolean).join(" ");
  const style = {
    "--card-order": props.order ?? (slotNumber ?? 1) - 1,
    ...(props.sheenTurn ? { "--sheen-turn": props.sheenTurn.index, "--sheen-turns": Math.max(1, props.sheenTurn.of) } : {}),
  } as CSSProperties;
  const engage = size === "slot" && isS ? {
    onPointerEnter: () => setEngaged(true), onPointerLeave: () => setEngaged(false),
    onFocus: () => setEngaged(true), onBlur: () => setEngaged(false),
  } : {};

  // Spans throughout: slot and mini cards are often the content of a button.
  const body = <span className="player-card-body" key={flashKey ?? "rest"}>
    <span className="player-card-surface" aria-hidden="true">
      <span className="player-card-edge" />
      <span className="player-card-face"><span className="player-card-finish" /><span className="player-card-sheen" /></span>
      {state === "pending" && <span className="player-card-pulse" />}
      {flashing && <span className="player-card-flash"><span className="player-card-flash-dim" /><span className="player-card-flash-burst" /><span className="player-card-flash-sweep" /></span>}
    </span>
    {ribbon != null && <span className="player-card-ribbon">{ribbon}</span>}
    {size === "big" && <span className="player-card-content">
      {reason && <span className="player-card-reason player-card-banner"><NoEntryIcon />{reason}</span>}
      <span className="player-card-top">{number}<StateMarker state={state} /></span>
      {portrait}
      <span className="player-card-copy">
        {name}
        <span className="player-card-team">{player.teamName} · {player.seasonYear}</span>
        <span className="player-card-meta"><span>{role}</span><span>{rosterLabel(player.rosterStatus)}</span>
          {player.keeperCapability === "CONFIRMED" && player.displayRole !== "WICKETKEEPER_BATTER" && <span>{COPY.keeper}</span>}</span>
        <Stats stats={stats} size={size} seasonYear={player.seasonYear} />
        {eraTitle && isEraBest(player) && <span className="player-card-era-best">{COPY.eraBest(eraTitle)}</span>}
      </span>
      {fitTag}{noteLine}
    </span>}
    {size === "slot" && <span className="player-card-content">
      <span className="player-card-top">{number}<StateMarker state={state} /></span>
      {portrait}
      {name}
      <span className="player-card-team">{shortTeam}</span>
      <Stats stats={stats} size={size} seasonYear={player.seasonYear} />
      <span className="player-card-tags"><span className="player-card-role">{shortRole(player.displayRole)}</span>{fitTag}</span>
      {noteLine}{reasonLine}
    </span>}
    {size === "mini" && <span className="player-card-content">
      {number}{portrait}
      <span className="player-card-copy">
        {name}
        <span className="player-card-team">{shortTeam} · {role}</span>
        {noteLine}{reasonLine}
      </span>
      <span className="player-card-side"><StateMarker state={state} />{fitTag}</span>
    </span>}
    {(state === "selected" || state === "preview" || state === "locked") && <span className="player-card-state-edge" aria-hidden="true" />}
  </span>;

  if (onClick) return <button type="button" className={className} style={style} onClick={onClick} aria-label={label ?? undefined} aria-pressed={props.pressed} {...engage}>{body}</button>;
  const naming = label === null ? {} : { role: "group", "aria-label": label };
  return size === "big"
    ? <div className={className} style={style} {...naming} {...engage}>{body}</div>
    : <span className={className} style={style} {...naming} {...engage}>{body}</span>;
}
