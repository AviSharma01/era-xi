import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ResultsInningsView, ResultsMatchView, ResultsPlayerView, ResultsSuccess } from "./draftOffResultsTypes.js";
import type { ResultsIdentity } from "./draftOffResultsClient.js";
import { ResultsClientError } from "./draftOffResultsClient.js";
import { FitBadge, PlayerInspector, friendly } from "./eraDraftPlayerPresentation.js";
import type { DraftTierAppearance } from "./eraDraftTypes.js";

export type ResultsLoader = (participantId: string, signal?: AbortSignal) => Promise<ResultsSuccess>;
const appearance: Record<ResultsPlayerView["qualityTier"], DraftTierAppearance> = { S: "violet", A: "gold", B: "cobalt", C: "emerald", D: "slate" };
const rating = (value: number | null) => value === null ? "—" : value.toFixed(1);
const noSubscription = () => () => {};
const noCooldown = () => 0;
const errors: Record<string, string> = {
  AUTHENTICATION_FAILED: "Room access is unavailable. Saved access is preserved.",
  RESULT_UNAVAILABLE: "These results are unavailable. Choose another entry from the leaderboard.",
  RESULTS_NOT_READY: "Checking the final result with the server. Retry after the room refreshes.",
  RATE_LIMITED: "Room requests are paused. Retry when the cooldown ends.",
  INVALID_RESULTS_RESPONSE: "The results response could not be verified. Retry to load it again.",
};

/** Mounted for one selection and authenticated session; no persistent private results. */
export function DraftOffResultsBrowser({ identity, displayName, loadResults, retryAtMs, subscribeCooldown }: {
  identity: ResultsIdentity; displayName: string; loadResults: ResultsLoader; retryAtMs: () => number;
  subscribeCooldown?: (listener: () => void) => () => void;
}) {
  const { roomCode, roundId, roundOrdinal, eraId, participantId } = identity;
  const scope = useMemo(() => ({}), [roomCode, roundId, roundOrdinal, eraId, participantId, loadResults]);
  const [loaded, setLoaded] = useState<{ scope: object; result: ResultsSuccess | null; error: string | null } | null>(null);
  const result = loaded?.scope === scope ? loaded.result : null, error = loaded?.scope === scope ? loaded.error : null;
  const [attempt, setAttempt] = useState(0);
  const [inspected, setInspected] = useState<ResultsPlayerView | null>(null);
  const [now, setNow] = useState(Date.now);
  const cooldownDeadline = useSyncExternalStore(subscribeCooldown ?? noSubscription, retryAtMs, noCooldown);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null); setInspected(null);
    void loadResults(participantId, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (value.roomCode !== roomCode || value.roundId !== roundId || value.roundOrdinal !== roundOrdinal
        || value.eraId !== eraId || value.participantId !== participantId) throw new ResultsClientError("INVALID_RESULTS_RESPONSE");
      setLoaded({ scope, result: value, error: null });
    }).catch(cause => {
      if (!controller.signal.aborted) { setNow(Date.now()); setLoaded({ scope, result: null,
        error: errors[cause instanceof ResultsClientError ? cause.code : ""] ?? "Results could not load. Retry when your connection is available." }); }
    });
    return () => controller.abort();
  }, [roomCode, roundId, roundOrdinal, eraId, participantId, loadResults, scope, attempt]);
  useEffect(() => {
    if (!error) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const time = Date.now(); setNow(time);
      if (cooldownDeadline > time) timer = setTimeout(update, Math.min(1000, cooldownDeadline - time));
    };
    update();
    return () => clearTimeout(timer);
  }, [error, cooldownDeadline]);
  const seconds = Math.max(0, Math.ceil((cooldownDeadline - now) / 1000));
  return <section id="participant-results" className="room-participant-results" aria-labelledby="participant-results-title" aria-busy={!result && !error}>
    <header className="room-results-heading"><div><p className="eyebrow">Submitted XI · Twenty-match campaign</p><h2 id="participant-results-title" tabIndex={-1}>{displayName}’s results</h2></div><a className="quiet-button" href="#final-leaderboard">Leaderboard ↑</a></header>
    {!result && !error && <div className="draft-off-panel" role="status">Loading {displayName}’s XI and campaign…</div>}
    {error && <div className="draft-off-panel"><p role="alert">{error}</p><button className="secondary-action" disabled={seconds > 0} onClick={() => setAttempt(value => value + 1)}>{seconds > 0 ? `Retry in ${seconds}s` : "Retry results"}</button></div>}
    {result && <>
      <div className="room-result-team-layout">
        <section className="draft-off-panel room-revealed-team" aria-labelledby="submitted-xi-title"><p className="eyebrow">Batting order locked at submission</p><h3 id="submitted-xi-title">Submitted XI</h3>
          <ol className="room-revealed-list">{result.players.map(player => <li key={player.playerTeamSeasonId} className={`room-revealed-player revealed-tier-${player.qualityTier.toLowerCase()}`}>
            <span className="room-result-position">{String(player.battingPosition).padStart(2, "0")}</span>
            <button className="room-result-player-name" onClick={() => setInspected(player)} aria-label={`Inspect ${player.playerName}, position ${player.battingPosition}`}><strong>{player.playerName}</strong><small>{player.teamName} · {player.seasonYear}</small><small>{friendly(player.displayRole)} · {player.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}{player.keeperCapability === "CONFIRMED" ? " · WK" : ""}</small></button>
            <div className="room-result-ratings"><strong aria-label={`Overall ${rating(player.overallRating)}`}>{rating(player.overallRating)} <small>{player.qualityTier}</small></strong><span>BAT {rating(player.displayRole === "BOWLER" ? null : player.battingRating)} · BOWL {rating(player.displayRole === "BATTER" || player.displayRole === "WICKETKEEPER_BATTER" ? null : player.bowlingRating)}</span></div>
            <FitBadge fit={player.presentationFit} />
          </li>)}</ol>
        </section>
        <TeamAssessment result={result} />
      </div>
      <section className="draft-off-panel room-campaign" aria-labelledby="campaign-title"><p className="eyebrow">Same shared fixtures · Authoritative results</p><h3 id="campaign-title">Twenty-match campaign</h3>
        <div className="room-campaign-summary"><div><span>Record</span><strong>{result.campaign.aggregate.won}–{result.campaign.aggregate.lost}</strong></div><div><span>Points</span><strong>{result.campaign.aggregate.points}</strong></div><div><span>Net run rate</span><strong>{result.campaign.aggregate.netRunRate >= 0 ? "+" : ""}{result.campaign.aggregate.netRunRate.toFixed(3)}</strong></div></div>
        <p className="draft-off-footnote">20 played. NRR uses the backend’s full precision and all-out ball accounting.</p>
        <ol className="room-campaign-matches">{result.campaign.matches.map(match => <CampaignMatch key={match.matchId} match={match} entryName={result.displayName} />)}</ol>
      </section>
    </>}
    {result && inspected && <PlayerInspector player={{ ...inspected, tierAppearance: appearance[inspected.qualityTier] }} onClose={() => setInspected(null)} />}
  </section>;
}

function TeamAssessment({ result }: { result: ResultsSuccess }) {
  const { strength, tierCounts, fitCounts, construction: c } = result.evaluation;
  return <section className="draft-off-panel room-team-assessment" aria-labelledby="team-assessment-title"><p className="eyebrow">Ratings revealed</p><h3 id="team-assessment-title">Team assessment</h3>
    <div className="strength-grid" aria-label="Team strength ratings">{(["overall", "batting", "bowling"] as const).map(key => <div key={key} className={`reveal-metric${key === "overall" ? " reveal-metric-featured" : ""}`}><span>{friendly(key)}</span><strong>{rating(strength[key])}</strong></div>)}</div>
    <div className="assessment-section"><h4>Quality mix</h4><div className="quality-mix">{(["S", "A", "B", "C", "D"] as const).filter(tier => tierCounts[tier] > 0).map(tier => <span key={tier} className={`mix-${tier.toLowerCase()}`}>{tier} × {tierCounts[tier]}</span>)}</div></div>
    <div className="assessment-section"><h4>Batting-order fit</h4><p>{fitCounts.NATURAL} natural · {fitCounts.ACCEPTABLE + fitCounts.UNKNOWN} acceptable</p>{(["STRETCH", "MAJOR_STRETCH"] as const).filter(fit => fitCounts[fit] > 0).map(fit => <p key={fit}><FitBadge fit={fit} /> × {fitCounts[fit]}</p>)}<p className="draft-off-footnote">Position-fit adjustments are reflected in team strength.</p></div>
    <div className="assessment-section"><h4>Bowling balance</h4><p>{c.deployedBowlingUnits.toFixed(1)} / {c.requiredBowlingUnits} deployed units</p><p>{c.frontlineBowlers} frontline · {c.supportBowlers} support</p></div>
    <div className="assessment-section"><h4>Team construction</h4><p>{c.overseasCount} / {c.overseasLimit} overseas · {c.hasWicketkeeper ? "Wicketkeeper confirmed" : "No confirmed wicketkeeper"}</p></div>
  </section>;
}
function CampaignMatch({ match, entryName }: { match: ResultsMatchView; entryName: string }) {
  const opponent = `${match.opponent.teamName} ${match.opponent.seasonYear}`;
  const winner = match.outcome === "WIN" ? entryName : opponent;
  const verdict = match.resultType === "super_over" ? `${winner} won the Super Over`
    : `${winner} won by ${match.margin} ${match.resultType === "runs" ? match.margin === 1 ? "run" : "runs" : match.margin === 1 ? "wicket" : "wickets"}`;
  const score = (innings: ResultsInningsView, label: string) => <div className="innings-row"><span><small>{label}</small><strong>{innings.side === "ENTRY" ? `${entryName} XI` : opponent}</strong></span><div><b>{innings.runs}/{innings.wickets}</b><small>{Math.floor(innings.balls / 6)}.{innings.balls % 6} overs{innings.allOut ? " · all out" : ""}</small></div></div>;
  return <li><article className={`match-result match-result-${match.outcome.toLowerCase()}`} aria-label={`Match ${match.sequence}: ${verdict}`}><header className="room-match-heading"><span>Match {String(match.sequence).padStart(2, "0")}</span><strong>{opponent}</strong><span className="match-outcome">{match.outcome}</span></header>
    {score(match.firstInnings, "First innings")}{score(match.secondInnings, "Second innings")}<div className="match-verdict"><strong>{verdict}</strong></div>
  </article></li>;
}
