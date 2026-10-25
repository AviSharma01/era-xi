import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ResultsInningsView, ResultsMatchView, ResultsPlayerView, ResultsSuccess } from "./draftOffResultsTypes.js";
import type { ResultsIdentity } from "./draftOffResultsClient.js";
import { ResultsClientError } from "./draftOffResultsClient.js";
import { FitBadge, PlayerInspector, friendly } from "./eraDraftPlayerPresentation.js";
import type { ReactNode } from "react";
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

type ResultsResourceProps = {
  identity: ResultsIdentity; loadResults: ResultsLoader; retryAtMs: () => number;
  subscribeCooldown?: (listener: () => void) => () => void;
};

/** Selection and session scoped; the authenticated session owns caching and authorization. */
function useParticipantResults({ identity, loadResults, retryAtMs, subscribeCooldown }: ResultsResourceProps) {
  const { roomCode, roundId, roundOrdinal, eraId, participantId } = identity;
  const scope = useMemo(() => ({}), [roomCode, roundId, roundOrdinal, eraId, participantId, loadResults]);
  const [loaded, setLoaded] = useState<{ scope: object; result: ResultsSuccess | null; error: string | null } | null>(null);
  const result = loaded?.scope === scope ? loaded.result : null, error = loaded?.scope === scope ? loaded.error : null;
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const cooldownDeadline = useSyncExternalStore(subscribeCooldown ?? noSubscription, retryAtMs, noCooldown);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
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
  return { result, error, seconds, retry: () => setAttempt(value => value + 1) };
}

function ResultsLoading({ resource, name }: { resource: ReturnType<typeof useParticipantResults>; name: string }) {
  const { result, error, seconds, retry } = resource;
  return <>
    {!result && !error && <div className="draft-off-panel" role="status">Loading {name}’s XI and campaign…</div>}
    {error && <div className="draft-off-panel"><p role="alert">{name}: {error}</p><button className="secondary-action" disabled={seconds > 0} onClick={retry}>{seconds > 0 ? `Retry in ${seconds}s` : "Retry results"}</button></div>}
  </>;
}

export function DraftOffResultsBrowser(props: ResultsResourceProps & { displayName: string }) {
  const resource = useParticipantResults(props), { result, error } = resource;
  const { displayName } = props;
  const [inspected, setInspected] = useState<ResultsPlayerView | null>(null);
  useEffect(() => setInspected(null), [result]);
  return <section id="participant-results" className="room-participant-results" aria-labelledby="participant-results-title" aria-busy={!result && !error}>
    <header className="room-results-heading"><div><p className="eyebrow">Submitted XI · Twenty-match campaign</p><h2 id="participant-results-title" tabIndex={-1}>{displayName}’s results</h2></div><a className="quiet-button" href="#final-leaderboard">Leaderboard ↑</a></header>
    <ResultsLoading resource={resource} name={displayName} />
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
        <ol className="room-campaign-matches">{result.campaign.matches.map(match => <li key={match.matchId}><CampaignMatch match={match} entryName={result.displayName} /></li>)}</ol>
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
  return <article className={`match-result match-result-${match.outcome.toLowerCase()}`} aria-label={`Match ${match.sequence}: ${verdict}`}><header className="room-match-heading"><span>Match {String(match.sequence).padStart(2, "0")}</span><strong>{opponent}</strong><span className="match-outcome">{match.outcome}</span></header>
    {score(match.firstInnings, "First innings")}{score(match.secondInnings, "Second innings")}<div className="match-verdict"><strong>{verdict}</strong></div>
  </article>;
}

export type ComparisonEntry = { participantId: string; displayName: string; rank: number };
export function DraftOffComparison({ identity, entries, loadResults, retryAtMs, subscribeCooldown }: {
  identity: Omit<ResultsIdentity, "participantId">; entries: readonly [ComparisonEntry, ComparisonEntry];
  loadResults: ResultsLoader; retryAtMs: () => number; subscribeCooldown?: ResultsResourceProps["subscribeCooldown"];
}) {
  const resources = { loadResults, retryAtMs, subscribeCooldown };
  const first = useParticipantResults({ ...resources, identity: { ...identity, participantId: entries[0].participantId } });
  const second = useParticipantResults({ ...resources, identity: { ...identity, participantId: entries[1].participantId } });
  const a = first.result, b = second.result;
  const [inspection, setInspection] = useState<{ player: ResultsPlayerView; result: ResultsSuccess } | null>(null);
  const ready = !!a && !!b;
  // Compare by fixture identity and sequence, never by opponent name: opponents recur.
  const aligned = ready && a.campaign.matches.every((match, i) => {
    const other = b.campaign.matches[i];
    return other && match.sequence === other.sequence && match.matchId === other.matchId
      && match.opponent.profileId === other.opponent.profileId && match.opponent.teamName === other.opponent.teamName
      && match.opponent.seasonYear === other.opponent.seasonYear;
  });
  const pair = (label: string, values: readonly [ReactNode, ReactNode]) => <div className="room-comparison-row" key={label}>
    <h4>{label}</h4>{values.map((value, i) => <div className="room-comparison-value" key={i}><span className="room-comparison-label">{i === 0 ? "A" : "B"} · {entries[i].displayName}</span>{value}</div>)}
  </div>;
  const results = ready ? [a, b] as const : null;
  const values = (read: (r: ResultsSuccess) => ReactNode): [ReactNode, ReactNode] => [read(a!), read(b!)];
  return <section id="xi-comparison" className="room-participant-results room-comparison" aria-labelledby="comparison-title" aria-busy={(!a && !first.error) || (!b && !second.error)}>
    <h2 id="comparison-title">Two XIs, one shared schedule</h2>
    <p>Each XI independently faced the same twenty historical fixtures. These teams did not play each other.</p>
    <nav className="room-comparison-links" aria-label="Comparison sections"><a href="#comparison-campaign">Campaign</a><a href="#comparison-teams">Team assessment</a><a href="#comparison-players">Batting order</a><a href="#comparison-fixtures">Fixtures</a><a href="#comparison-selection">Change XIs ↑</a></nav>
    <ResultsLoading resource={first} name={`A · ${entries[0].displayName}`} /><ResultsLoading resource={second} name={`B · ${entries[1].displayName}`} />
    <p className="sr-status" role="status">{ready && aligned ? `Comparison ready: ${entries[0].displayName} and ${entries[1].displayName}.` : ""}</p>
    {ready && !aligned && <p role="alert">These campaigns could not be aligned to the same schedule. Reload the page before comparing.</p>}
    {results && aligned && <>
      <section id="comparison-campaign" className="draft-off-panel" aria-labelledby="comparison-campaign-title"><h3 id="comparison-campaign-title">Campaign results</h3>
        {pair("Final rank", entries.map(entry => <strong>Rank {entry.rank}{entries[0].rank === entries[1].rank ? " · Shared rank" : ""}</strong>) as [ReactNode, ReactNode])}
        {(["played", "won", "lost", "points"] as const).map((key, i) => pair(["Played", "Wins", "Losses", "Points"][i], values(r => <strong>{r.campaign.aggregate[key]}</strong>)))}
        {pair("Net run rate", values(r => <strong>{r.campaign.aggregate.netRunRate >= 0 ? "+" : ""}{r.campaign.aggregate.netRunRate.toFixed(3)}</strong>))}
        <p className="draft-off-footnote">Server ranks are preserved, including exact ties. Displayed NRR is rounded; ranking uses full precision. NRR uses regulation innings and all-out ball accounting.</p>
      </section>
      <section id="comparison-teams" className="draft-off-panel" aria-labelledby="comparison-teams-title"><h3 id="comparison-teams-title">Team assessment</h3>
        {(["overall", "batting", "bowling"] as const).map(key => pair(`${friendly(key)} strength`, values(r => <strong>{rating(r.evaluation.strength[key])}</strong>)))}
        {pair("Quality mix", values(r => <span>{(["S", "A", "B", "C", "D"] as const).map(tier => `${tier} × ${r.evaluation.tierCounts[tier]}`).join(" · ")}</span>))}
        {pair("Batting-order fit", values(r => <span>{Object.entries(r.evaluation.fitCounts).filter(([, count]) => count > 0).map(([fit, count]) => `${friendly(fit)} × ${count}`).join(" · ")}</span>))}
        {pair("Bowling balance", values(r => <span>{r.evaluation.construction.deployedBowlingUnits.toFixed(1)} / {r.evaluation.construction.requiredBowlingUnits} units · {r.evaluation.construction.frontlineBowlers} frontline · {r.evaluation.construction.supportBowlers} support</span>))}
        {pair("Team construction", values(r => <span>{r.evaluation.construction.overseasCount} / {r.evaluation.construction.overseasLimit} overseas · {r.evaluation.construction.hasWicketkeeper ? "Wicketkeeper confirmed" : "No confirmed wicketkeeper"}</span>))}
        <p className="draft-off-footnote">Position fit and construction are already reflected in team strength.</p>
      </section>
      <section id="comparison-players" className="draft-off-panel" aria-labelledby="comparison-players-title"><h3 id="comparison-players-title">Locked batting order</h3>
        <ol className="room-comparison-players">{a.players.map(player => {
          const other = b.players.find(p => p.battingPosition === player.battingPosition)!;
          return <li key={player.battingPosition} data-position={player.battingPosition}>
            {pair(`Position ${String(player.battingPosition).padStart(2, "0")}`, [player, other].map((p, i) => <div className="room-comparison-player">
              <button className="room-result-player-name" aria-label={`Inspect ${p.playerName}, position ${p.battingPosition}, ${entries[i].displayName}`} onClick={() => setInspection({ player: p, result: results[i] })}><strong>{p.playerName}</strong><small>{p.teamName} · {p.seasonYear}</small><small>{friendly(p.displayRole)} · {p.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}{p.keeperCapability === "CONFIRMED" ? " · WK" : ""}</small></button>
              <span>Overall {rating(p.overallRating)} · {p.qualityTier}</span><span>BAT {rating(p.displayRole === "BOWLER" ? null : p.battingRating)} · BOWL {rating(p.displayRole === "BATTER" || p.displayRole === "WICKETKEEPER_BATTER" ? null : p.bowlingRating)}</span><FitBadge fit={p.presentationFit} />
              {i === 0 && <small>{p.playerTeamSeasonId === other.playerTeamSeasonId ? "Same player-season" : p.playerId === other.playerId ? "Same player, different season" : "Different players"}</small>}
            </div>) as [ReactNode, ReactNode])}
          </li>;
        })}</ol>
      </section>
      <section id="comparison-fixtures" className="draft-off-panel room-campaign" aria-labelledby="comparison-fixtures-title"><h3 id="comparison-fixtures-title">Twenty shared fixtures</h3><p>Each XI’s separate campaign. Expand a fixture for both innings and the full verdict.</p>
        <div className="room-fixture-legend" aria-label="Fixture participants">{entries.map((entry, i) => <p className="room-comparison-label" key={entry.participantId}>{i === 0 ? "A" : "B"} · {entry.displayName}</p>)}</div>
        <ol className="room-comparison-fixtures">{a.campaign.matches.map((match, index) => <li key={match.matchId} data-sequence={match.sequence}>
          <details className="room-comparison-fixture">
            <summary><span className="room-fixture-summary-title">Match {String(match.sequence).padStart(2, "0")} · {match.opponent.teamName} {match.opponent.seasonYear}</span>
              <span className="room-fixture-summary-outcomes">{[match, b.campaign.matches[index]].map((m, i) => <span key={i} className={`room-fixture-outcome room-fixture-outcome-${m.outcome.toLowerCase()}`} aria-label={`${i === 0 ? "A" : "B"} · ${entries[i].displayName}: ${m.outcome}${m.resultType === "super_over" ? ", Super Over" : ""}`}><b>{i === 0 ? "A" : "B"}</b> {m.outcome}{m.resultType === "super_over" && <small>Super Over</small>}</span>)}</span>
              <span className="room-fixture-summary-hint">Innings details</span>
            </summary>
            <div className="room-comparison-match-pair">{[match, b.campaign.matches[index]].map((m, i) => <div key={i}><p className="room-comparison-label">{i === 0 ? "A" : "B"} · {entries[i].displayName}</p><CampaignMatch match={m} entryName={entries[i].displayName} /></div>)}</div>
          </details>
        </li>)}</ol>
      </section>
    </>}
    {results && aligned && <a className="quiet-button" href="#comparison-selection">Change compared XIs ↑</a>}
    {aligned && inspection && results?.includes(inspection.result) && <PlayerInspector player={{ ...inspection.player, tierAppearance: appearance[inspection.player.qualityTier] }} onClose={() => setInspection(null)} />}
  </section>;
}
