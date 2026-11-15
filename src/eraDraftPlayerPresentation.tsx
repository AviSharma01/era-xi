import { useEffect, useRef, type ReactElement } from "react";
import { FitBadge, fitClass, PlayerCard, type PlayerCardPlayer } from "./components/PlayerCard.js";
import { fitLabel, friendly } from "./copy.js";
import type { DraftPickView } from "./eraDraftTypes.js";

// Shared presentation only. Solo and Draft-Off retain separate state/command controllers.
export type PlayerInspectorView = PlayerCardPlayer & Pick<DraftPickView, "historicalStats"> & {
  readonly battingPosition?: DraftPickView["battingPosition"];
};
export function PlayerInspector({ player, onClose, countdown, eraTitle }: { player: PlayerInspectorView; onClose: () => void; countdown?: string; eraTitle?: string }): ReactElement {
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
    <PlayerCard size="big" player={player} eraTitle={eraTitle} nameId="inspector-title" />
    <div className="inspector-metrics" aria-label="Exact season statistics">
      {showBat && <><div><span>Runs</span><strong>{batting.runs}</strong></div><div><span>Strike rate</span><strong>{batting.strikeRate === null ? "—" : formatOneDecimal(batting.strikeRate)}</strong></div></>}
      {showBat && !showBowl && <div><span>Batting average</span><strong>{batting.average === null ? "—" : formatOneDecimal(batting.average)}</strong></div>}
      {showBowl && <><div><span>Wickets</span><strong>{bowling.wickets}</strong></div><div><span>Economy</span><strong>{bowling.economy === null ? "—" : formatTwoDecimals(bowling.economy)}</strong></div></>}
    </div>
  </>;
  return <dialog ref={dialogRef} className="player-inspector inspector-modal" aria-labelledby="inspector-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
      if (event.key === "Escape") event.stopPropagation();
      // Close is the sheet's only interactive control; keep Tab within the dialog.
      if (event.key === "Tab") { event.preventDefault(); closeRef.current?.focus(); }
    }}>{content}</dialog>;
}

export { FitBadge, fitClass };
export { fitLabel, friendly };

function formatOneDecimal(value: number): string { return value.toFixed(1); }
function formatTwoDecimals(value: number): string { return value.toFixed(2); }
