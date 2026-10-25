import { useEffect, useRef, type ReactElement } from "react";
import type { DraftCandidateIdentityView, DraftPickView, DraftPresentationFit, EraDraftPublicView } from "./eraDraftTypes.js";

// Shared presentation only. Solo and Draft-Off retain separate state/command controllers.
export function CandidateGallery(props: {
  view: Extract<EraDraftPublicView, { phase: "AWAITING_PICK" }>;
  selectedId: string | null;
  selected?: DraftCandidateIdentityView;
  onSelect: (candidate: DraftCandidateIdentityView) => void;
  onUnavailable: (reason: string) => void;
}): ReactElement {
  let previousGroup: DraftCandidateIdentityView["presentationGroup"] | null = null;
  return (
    <div className="candidate-section">
      <div className="candidate-heading"><h3>Eligible squad</h3><span>{props.view.candidates.length} players</span></div>
      <div className="candidate-grid">
        {props.view.candidates.map((candidate) => {
          const selected = candidate.playerTeamSeasonId === props.selectedId;
          const unavailableReason = !candidate.available
            ? candidate.positions.flatMap((position) => position.reasons)[0]?.message ?? "Unavailable"
            : undefined;
          const unavailableReasonId = `candidate-unavailable-${candidate.playerTeamSeasonId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
          const showGroup = candidate.presentationGroup !== previousGroup;
          previousGroup = candidate.presentationGroup;
          return (
            <div className="candidate-entry" key={candidate.playerTeamSeasonId}>
              {showGroup && <div className="candidate-group-label"><span>{friendly(candidate.presentationGroup)}</span></div>}
              <button className={`candidate-card${selected ? " candidate-card-selected" : ""}`}
                aria-disabled={!candidate.available} aria-pressed={selected}
                aria-describedby={unavailableReason ? unavailableReasonId : undefined}
                onClick={() => candidate.available ? props.onSelect(candidate) : props.onUnavailable(unavailableReason!)}>
                <span className="portrait-placeholder" aria-hidden="true"><span>{monogram(candidate.playerName)}</span></span>
                <span className="candidate-body"><strong>{candidate.playerName}</strong><span>{friendly(candidate.displayRole)}</span>
                  <span className="candidate-meta">{candidate.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}
                    {candidate.keeperCapability === "CONFIRMED" && candidate.displayRole !== "WICKETKEEPER_BATTER" ? " · WK" : ""}</span>
                  {unavailableReason && <span id={unavailableReasonId} className="candidate-unavailable">{unavailableReason}</span>}
                </span>
                <span className="candidate-quick-stats">
                  {candidateQuickStats(candidate).map((line) => <span key={line}>{line}</span>)}
                </span>
                <span className="select-mark" aria-hidden="true">{!candidate.available ? "" : selected ? "✓" : "+"}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SelectedPlayerDetail({ candidate }: { candidate: DraftCandidateIdentityView }): ReactElement {
  const showBatting = candidate.displayRole !== "BOWLER" && candidate.displayRole !== "UNKNOWN";
  const showBowling = candidate.displayRole === "BOWLER" || candidate.displayRole === "ALL_ROUNDER";
  return <section className={`selected-player-detail tier-${candidate.tierAppearance}`} aria-labelledby="selected-player-title">
    <span className="selected-player-portrait" aria-hidden="true">{monogram(candidate.playerName)}</span>
    <div className="selected-player-copy">
      <h3 id="selected-player-title">{candidate.playerName}</h3>
      <p>{candidate.teamName} · {candidate.seasonYear}</p>
      <div className="selected-player-meta">
        <span>{friendly(candidate.displayRole)}</span>
        <span>{candidate.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}</span>
        {candidate.keeperCapability === "CONFIRMED" && candidate.displayRole !== "WICKETKEEPER_BATTER" && <span>Wicketkeeper</span>}
      </div>
      <CurrentSeasonStats candidate={candidate} batting={showBatting} bowling={showBowling} />
    </div>
  </section>;
}

function CurrentSeasonStats(props: {
  candidate: Pick<DraftCandidateIdentityView, "historicalStats" | "seasonYear">;
  batting: boolean;
  bowling: boolean;
}): ReactElement {
  const { batting, bowling } = props.candidate.historicalStats.currentSeason;
  const lines: string[] = [];
  if (props.batting) {
    lines.push(`${batting.runs} runs · ${batting.strikeRate === null ? "—" : formatOneDecimal(batting.strikeRate)} SR`);
  }
  if (props.bowling) {
    lines.push(`${bowling.wickets} wickets · ${bowling.economy === null ? "—" : formatTwoDecimals(bowling.economy)} econ`);
  }
  return <div className="current-season-stats" aria-label={`${props.candidate.seasonYear} current season statistics`}>
    <span>{props.candidate.seasonYear} season</span>
    {lines.length > 0 ? lines.map((line) => <strong key={line}>{line}</strong>) : <strong>No recorded statistics</strong>}
  </div>;
}

export type PlayerInspectorView = Pick<DraftPickView, "playerName" | "teamName" | "seasonYear" | "displayRole" | "rosterStatus" | "keeperCapability" | "historicalStats" | "tierAppearance"> & {
  readonly battingPosition?: DraftPickView["battingPosition"];
};
export function PlayerInspector({ player, onClose, countdown }: { player: PlayerInspectorView; onClose: () => void; countdown?: string }): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Keep the original opener across StrictMode's effect setup/cleanup replay.
    openerRef.current ??= document.activeElement as HTMLElement | null;
    const opener = openerRef.current;
    dialogRef.current?.showModal(); closeRef.current?.focus();
    return () => {
      // Restore after native dialog removal/cancel has finished its own focus handling.
      requestAnimationFrame(() => { if (!dialogRef.current?.open && opener?.isConnected) opener.focus(); });
    };
  }, []);
  const { batting, bowling } = player.historicalStats.currentSeason;
  const showBat = player.displayRole !== "BOWLER" && player.displayRole !== "UNKNOWN";
  const showBowl = player.displayRole === "BOWLER" || player.displayRole === "ALL_ROUNDER";
  const content = <>
    <header><p className="eyebrow">Player details{'battingPosition' in player ? ` · Slot ${String(player.battingPosition).padStart(2, "0")}` : " · Preview"}</p>
      {countdown && <span className="room-sheet-clock" role="timer" aria-label={`${countdown} remaining`}>{countdown}</span>}
      <button ref={closeRef} className="quiet-button" onClick={onClose} aria-label="Close player details">Close ×</button></header>
    {countdown === "00:00" && <p role="status">Time reached. Checking final status with the server.</p>}
    <div className="inspector-identity"><span className="inspector-monogram" aria-hidden="true">{monogram(player.playerName)}</span>
      <div><h3 id="inspector-title">{player.playerName}</h3><p>{player.teamName} · {player.seasonYear}</p></div></div>
    <p>{friendly(player.displayRole)} · {player.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}{player.keeperCapability === "CONFIRMED" && player.displayRole !== "WICKETKEEPER_BATTER" ? " · WK" : ""}</p>
    <div className="inspector-metrics" aria-label="Exact season statistics">
      {showBat && <><div><span>Runs</span><strong>{batting.runs}</strong></div><div><span>Strike rate</span><strong>{batting.strikeRate === null ? "—" : formatOneDecimal(batting.strikeRate)}</strong></div></>}
      {showBat && !showBowl && <div><span>Batting average</span><strong>{batting.average === null ? "—" : formatOneDecimal(batting.average)}</strong></div>}
      {showBowl && <><div><span>Wickets</span><strong>{bowling.wickets}</strong></div><div><span>Economy</span><strong>{bowling.economy === null ? "—" : formatTwoDecimals(bowling.economy)}</strong></div></>}
    </div>
  </>;
  return <dialog ref={dialogRef} className={`player-inspector inspector-modal tier-${player.tierAppearance}`} aria-labelledby="inspector-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
      if (event.key === "Escape") event.stopPropagation();
      // Close is the sheet's only interactive control; keep Tab within the dialog.
      if (event.key === "Tab") { event.preventDefault(); closeRef.current?.focus(); }
    }}>{content}</dialog>;
}

export function FitBadge({ fit }: { fit: DraftPresentationFit }): ReactElement {
  return <span className={`fit-badge fit-${fitClass(fit)}`}>{fitLabel(fit)}</span>;
}

export function fitLabel(fit: DraftPresentationFit): string {
  // Approved UI fallback only: authoritative UNKNOWN remains neutral and unchanged.
  return friendly(fit === "UNKNOWN" ? "ACCEPTABLE" : fit);
}

export function monogram(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export function friendly(value: string): string {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function fitClass(fit: DraftPresentationFit): string {
  return (fit === "UNKNOWN" ? "ACCEPTABLE" : fit).toLowerCase().replaceAll("_", "-");
}

function candidateQuickStats(candidate: DraftCandidateIdentityView): string[] {
  const { batting, bowling } = candidate.historicalStats.currentSeason;
  const battingLine = `${batting.runs} runs · ${batting.strikeRate === null ? "—" : formatOneDecimal(batting.strikeRate)} SR`;
  const bowlingLine = `${bowling.wickets} ${bowling.wickets === 1 ? "wkt" : "wkts"} · ${bowling.economy === null ? "—" : formatTwoDecimals(bowling.economy)} econ`;
  if (candidate.displayRole === "ALL_ROUNDER") return [battingLine, bowlingLine];
  if (candidate.displayRole === "BOWLER" || candidate.displayRole === "UNKNOWN") return [bowlingLine];
  return [battingLine];
}

function formatOneDecimal(value: number): string { return value.toFixed(1); }
function formatTwoDecimals(value: number): string { return value.toFixed(2); }
