import type { CSSProperties, ReactElement, ReactNode } from "react";

import { monogram, NoEntryIcon } from "../../components/PlayerCard.js";
import { DRAFTING_COPY as COPY, friendly, PLAYER_CARD_COPY, rejectionReason, rosterLabel } from "../../copy.js";
import type { DraftCandidateIdentityView, EraDraftPublicView } from "../../eraDraftTypes.js";

/** The short reason a player can't be picked, from the projection's rejection codes. */
export function unavailableReason(candidate: DraftCandidateIdentityView): string | undefined {
  if (candidate.available) return undefined;
  return rejectionReason(candidate.positions.flatMap((position) => position.reasons.map((reason) => reason.code))) ?? PLAYER_CARD_COPY.unavailable;
}

/** The squad as one list panel. Rows carry no tier: opening a card is the discovery. */
export function SquadList(props: {
  view: Extract<EraDraftPublicView, { phase: "AWAITING_PICK" }>;
  selectedId: string | null;
  blocked: boolean;
  entering: boolean;
  onSelect: (candidate: DraftCandidateIdentityView) => void;
  /** On phones the big card expands out of its row. */
  expansion?: (candidate: DraftCandidateIdentityView) => ReactNode;
}): ReactElement {
  let previousGroup: DraftCandidateIdentityView["presentationGroup"] | null = null;
  return <section className="squad-panel" aria-labelledby="squad-title">
    <div className="squad-heading"><h2 id="squad-title">{COPY.squadTitle}</h2><span>{COPY.squadCount(props.view.candidates.length)}</span></div>
    <fieldset className="squad-fieldset" disabled={props.blocked}>
      <legend className="sr-status">{COPY.squadLegend}</legend>
      <div className={`squad-rows${props.entering ? " squad-rows-entering" : ""}`}>
        {props.view.candidates.map((candidate, index) => {
          const selected = candidate.playerTeamSeasonId === props.selectedId;
          const reason = unavailableReason(candidate);
          const reasonId = `squad-unavailable-${candidate.playerTeamSeasonId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
          const showGroup = candidate.presentationGroup !== previousGroup;
          previousGroup = candidate.presentationGroup;
          return <div className="squad-entry" key={candidate.playerTeamSeasonId} style={{ "--row-index": index } as CSSProperties}>
            {showGroup && <div className="squad-group-label">{friendly(candidate.presentationGroup)}</div>}
            <button type="button" className={`squad-row${selected ? " squad-row-selected" : ""}`} data-candidate-id={candidate.playerTeamSeasonId}
              aria-disabled={!candidate.available} aria-pressed={selected} aria-describedby={reason ? reasonId : undefined}
              onClick={() => props.onSelect(candidate)}>
              <span className="squad-monogram" aria-hidden="true">{monogram(candidate.playerName)}</span>
              <span className="squad-row-body"><strong>{candidate.playerName}</strong>
                <span className="squad-row-meta">{rowMeta(candidate)}</span>
                {reason && <span id={reasonId} className="squad-row-reason"><NoEntryIcon />{reason}</span>}
              </span>
              <span className="squad-row-stats">{quickStats(candidate).map((line) => <span key={line}>{line}</span>)}</span>
              <span className="squad-row-mark" aria-hidden="true">{!candidate.available ? "" : selected ? "✓" : "+"}</span>
            </button>
            {selected && props.expansion?.(candidate)}
          </div>;
        })}
      </div>
    </fieldset>
  </section>;
}

function rowMeta(candidate: DraftCandidateIdentityView): string {
  const keeper = candidate.keeperCapability === "CONFIRMED" && candidate.displayRole !== "WICKETKEEPER_BATTER" ? ` · ${COPY.keeperShort}` : "";
  return `${friendly(candidate.displayRole)} · ${rosterLabel(candidate.rosterStatus)}${keeper}`;
}

/**
 * While a respin's reel runs, the squad it replaces stays in place, dimmed and inert, so the layout holds still.
 * Decorative only: the new squad is never drawn before its reel lands.
 */
export function StaleSquad({ candidates }: { candidates: readonly DraftCandidateIdentityView[] }): ReactElement {
  return <div className="squad-panel squad-panel-stale" aria-hidden="true" inert>
    <div className="squad-heading"><span className="squad-title">{COPY.squadTitle}</span><span>{COPY.squadCount(candidates.length)}</span></div>
    <div className="squad-rows">
      {candidates.map((candidate) => <div key={candidate.playerTeamSeasonId} className="squad-stale-row">
        <span className="squad-monogram">{monogram(candidate.playerName)}</span>
        <span className="squad-row-body"><strong>{candidate.playerName}</strong><span className="squad-row-meta">{rowMeta(candidate)}</span></span>
        <span className="squad-row-stats">{quickStats(candidate).map((line) => <span key={line}>{line}</span>)}</span>
      </div>)}
    </div>
  </div>;
}

function quickStats(candidate: DraftCandidateIdentityView): string[] {
  const { batting, bowling } = candidate.historicalStats.currentSeason;
  const batLine = `${batting.runs} ${PLAYER_CARD_COPY.runs(batting.runs)} · ${batting.strikeRate === null ? "—" : batting.strikeRate.toFixed(1)} ${PLAYER_CARD_COPY.strikeRate}`;
  const bowlLine = `${bowling.wickets} ${PLAYER_CARD_COPY.wicketsShort(bowling.wickets)} · ${bowling.economy === null ? "—" : bowling.economy.toFixed(2)} ${PLAYER_CARD_COPY.economy}`;
  if (candidate.displayRole === "ALL_ROUNDER") return [batLine, bowlLine];
  if (candidate.displayRole === "BOWLER" || candidate.displayRole === "UNKNOWN") return [bowlLine];
  return [batLine];
}
