import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type RefObject } from "react";

import type { EraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { projectEraDraftPublicState, projectEraDraftRevealState } from "./eraDraftProjection.js";
import type {
  DraftCandidateIdentityView,
  DraftPickView,
  DraftPresentationFit,
  EraDraftRevealView,
  EraDraftPublicView,
  EraDraftTransitionResult,
  RevealPlayerView,
} from "./eraDraftTypes.js";
import {
  clearEraDraftUiSave,
  loadAndRestoreEraDraftUiSave,
  persistAcceptedEraDraftTransition,
  readEraDraftUiSave,
  type EraDraftUiSaveReadResult,
  type Phase2EraDraftState,
} from "./eraDraftUiPersistence.js";
import { fetchEraDraftManifest, fetchScopedEraDraftCatalog, eraDraftManifestUrl, type EraDraftWebManifest } from "./eraDraftWebData.js";
import { ERA_IDS, type EraId } from "./teamEvaluationV2.js";
import { appRoutePath, matchAppRoute, navigateToAppRoute, type AppRoute } from "./webRoutes.js";

const ERA_COPY: Readonly<Record<EraId, { ordinal: string; title: string; years: string; flavor: string }>> = {
  "era-foundation": { ordinal: "01", title: "Foundation", years: "2008–2010", flavor: "The first blueprints. Raw squads, instant icons." },
  "era-expansion": { ordinal: "02", title: "Expansion", years: "2011–2013", flavor: "New teams arrive and the league finds its shape." },
  "era-transition": { ordinal: "03", title: "Transition", years: "2014–2017", flavor: "Power shifts, new homes, and changing dynasties." },
  "era-modern-pre-impact": { ordinal: "04", title: "Modern Pre-Impact", years: "2018–2022", flavor: "Deep analytics meet settled franchise identities." },
  "era-impact": { ordinal: "05", title: "Impact", years: "2023–2026", flavor: "The newest tactical era at full intensity." },
};

type DraftSession = { readonly catalog: EraDraftCatalog; readonly state: Phase2EraDraftState };

export function EraDraftApp(): ReactElement {
  const [route, setRoute] = useState<AppRoute | null>(() => matchAppRoute(window.location.pathname));
  const [manifest, setManifest] = useState<EraDraftWebManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [loadingEra, setLoadingEra] = useState<EraId | null>(null);
  const [selectedEra, setSelectedEra] = useState<EraId | null>(null);
  const [session, setSession] = useState<DraftSession | null>(null);
  const [savedGame, setSavedGame] = useState<EraDraftUiSaveReadResult>(() => readEraDraftUiSave());
  const [loadingContinue, setLoadingContinue] = useState(false);
  const [overwriteEra, setOverwriteEra] = useState<EraId | null>(null);
  const [landingNotice, setLandingNotice] = useState<string | null>(null);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);

  useEffect(() => {
    const onPopState = (): void => setRoute(matchAppRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [route]);

  useEffect(() => {
    if (route !== "ERA_DRAFT" || session) return;
    setLandingNotice("No active draft is loaded. Continue a saved game or start a new draft.");
    navigateToAppRoute("HOME", { replace: true });
  }, [route, session]);

  useEffect(() => {
    const url = eraDraftManifestUrl(import.meta.env.BASE_URL);
    void fetchEraDraftManifest(url).then(setManifest).catch((error: unknown) => {
      setManifestError(error instanceof Error ? error.message : "Era data could not be loaded.");
    });
  }, []);

  const navigate = (next: AppRoute): void => navigateToAppRoute(next);

  const acceptTransition = (catalog: EraDraftCatalog, result: EraDraftTransitionResult): string | null => {
    if (!result.ok) return null;
    if (result.state.phase === "SETUP" || result.state.phase === "GAME_COMPLETE") {
      throw new Error(`Phase 2 cannot present ${result.state.phase}.`);
    }
    setSession({ catalog, state: result.state });
    try {
      const persisted = persistAcceptedEraDraftTransition(result);
      if (persisted.kind === "SAVED") setSavedGame({ kind: "CANDIDATE", save: persisted.save });
      setPersistenceWarning(null);
      return null;
    } catch (error) {
      const warning = error instanceof Error ? error.message : "This update could not be saved locally.";
      setPersistenceWarning(warning);
      return warning;
    }
  };

  const startDraft = async (eraId: EraId): Promise<void> => {
    if (!manifest || loadingEra) return;
    setLoadingEra(eraId);
    setManifestError(null);
    try {
      const manifestUrl = eraDraftManifestUrl(import.meta.env.BASE_URL);
      const catalog = await fetchScopedEraDraftCatalog({ manifest, manifestUrl, eraId });
      const setup = createEraDraftGame({ catalog, rootSeed: createRootSeed() });
      const chosen = reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId });
      if (!chosen.ok || chosen.state.phase !== "AWAITING_SPIN") throw new Error("The selected era could not start.");
      acceptTransition(catalog, chosen);
      setOverwriteEra(null);
      navigate("ERA_DRAFT");
    } catch (error) {
      setManifestError(error instanceof Error ? error.message : "The selected era could not be loaded.");
    } finally {
      setLoadingEra(null);
    }
  };

  const requestStart = (eraId: EraId): void => {
    if (savedGame.kind === "INVALID") {
      setLandingNotice("Discard the invalid local save before starting a new draft.");
      return;
    }
    if (savedGame.kind === "CANDIDATE") {
      setOverwriteEra(eraId);
      return;
    }
    void startDraft(eraId);
  };

  const continueGame = async (): Promise<void> => {
    if (!manifest || savedGame.kind !== "CANDIDATE" || loadingContinue) return;
    setLoadingContinue(true);
    setLandingNotice(null);
    try {
      const manifestUrl = eraDraftManifestUrl(import.meta.env.BASE_URL);
      const restored = await loadAndRestoreEraDraftUiSave({ save: savedGame.save, manifest, manifestUrl });
      setSession(restored);
      setPersistenceWarning(null);
      navigate("ERA_DRAFT");
    } catch (error) {
      setSavedGame({ kind: "INVALID", message: error instanceof Error ? error.message : "The local save could not be restored." });
    } finally {
      setLoadingContinue(false);
    }
  };

  const discardSave = (): boolean => {
    try {
      clearEraDraftUiSave();
      setSavedGame({ kind: "EMPTY" });
      setOverwriteEra(null);
      setLandingNotice("Local save discarded. You can start a new draft.");
      return true;
    } catch (error) {
      setLandingNotice(error instanceof Error ? error.message : "The local save could not be removed.");
      return false;
    }
  };

  if (route === "ERA_DRAFT") {
    if (!session) return <LoadingSession />;
    return session.state.phase === "REVEALED"
      ? <RevealedExperience session={{ catalog: session.catalog, state: session.state }} persistenceWarning={persistenceWarning} onExit={() => navigate("HOME")} />
      : <DraftExperience session={{ catalog: session.catalog, state: session.state }}
          persistenceWarning={persistenceWarning} onAccepted={(result) => acceptTransition(session.catalog, result)} onExit={() => navigate("HOME")} />;
  }
  if (route === null) return <NotFound onExit={() => navigate("HOME")} />;
  return <Landing manifest={manifest} error={manifestError} loadingEra={loadingEra} selectedEra={selectedEra}
    savedGame={savedGame} loadingContinue={loadingContinue} overwriteEra={overwriteEra} notice={landingNotice}
    onContinue={() => void continueGame()} onDiscardSave={discardSave} onCancelOverwrite={() => setOverwriteEra(null)}
    onConfirmOverwrite={(eraId) => void startDraft(eraId)}
    onSelect={(eraId) => {
      setSelectedEra(eraId);
      setOverwriteEra(null);
      setManifestError(null);
    }} onStart={requestStart} />;
}

export function Landing(props: {
  manifest: EraDraftWebManifest | null;
  error: string | null;
  loadingEra: EraId | null;
  selectedEra: EraId | null;
  savedGame: EraDraftUiSaveReadResult;
  loadingContinue: boolean;
  overwriteEra: EraId | null;
  notice: string | null;
  basePath?: string;
  onContinue: () => void;
  onDiscardSave: () => boolean;
  onCancelOverwrite: () => void;
  onConfirmOverwrite: (eraId: EraId) => void;
  onSelect: (eraId: EraId) => void;
  onStart: (eraId: EraId) => void;
}): ReactElement {
  const selected = props.selectedEra ? ERA_COPY[props.selectedEra] : null;
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const eraPickerTitleRef = useRef<HTMLHeadingElement>(null);
  return (
    <main className="era-shell landing-shell">
      <header className="game-header">
        <a className="wordmark" href={appRoutePath("HOME", props.basePath)} aria-label="Era Draft home">
          <span className="wordmark-mark">ED</span><span>ERA DRAFT</span>
        </a>
        <a className="classic-link" href={appRoutePath("CLASSIC", props.basePath)}>Classic 2016 <span aria-hidden="true">↗</span></a>
      </header>

      <section className="landing-intro" aria-labelledby="landing-title">
        <p className="eyebrow">Historical IPL team builder</p>
        <h1 id="landing-title">Build an XI across IPL history.</h1>
        <p className="hero-copy">Choose a period, spin through its franchise-seasons, and make eleven permanent calls.</p>
      </section>

      {props.savedGame.kind === "CANDIDATE" && (
        <section className="continue-panel" aria-labelledby="continue-title">
          <div><p className="eyebrow">Saved locally</p><h2 id="continue-title">Continue {ERA_COPY[props.savedGame.save.summary.eraId].title}</h2>
            <p>{saveSummaryLabel(props.savedGame.save.summary.phase, props.savedGame.save.summary.pickCount)}</p></div>
          <button className="primary-action" disabled={!props.manifest || props.loadingContinue} onClick={props.onContinue}>
            {props.loadingContinue ? "Restoring…" : "Continue game"}<span aria-hidden="true">→</span>
          </button>
        </section>
      )}
      {props.savedGame.kind === "INVALID" && (
        <section className="save-recovery" role="alert" aria-labelledby="save-recovery-title">
          <div><p className="eyebrow">Save recovery</p><h2 id="save-recovery-title">Saved game unavailable</h2><p>{props.savedGame.message}</p></div>
          <button className="secondary-action" onClick={() => {
            if (props.onDiscardSave()) requestAnimationFrame(() => eraPickerTitleRef.current?.focus());
          }}>Discard local save</button>
        </section>
      )}
      {props.savedGame.kind === "UNAVAILABLE" && <p className="storage-notice" role="status">{props.savedGame.message} You can still play without autosave.</p>}
      {props.notice && <p className="storage-notice" role="status">{props.notice}</p>}

      <section className="era-picker" aria-labelledby="era-picker-title">
        <div className="section-heading">
          <div><p className="eyebrow">Primary mode</p><h2 ref={eraPickerTitleRef} tabIndex={-1} id="era-picker-title">Choose an era</h2></div>
          <p className="section-note">Five periods. Eleven permanent decisions.</p>
        </div>
        <div className="era-selection-layout">
          <div className="era-grid" aria-label="IPL eras">
            {ERA_IDS.map((eraId) => {
              const era = ERA_COPY[eraId];
              const isSelected = props.selectedEra === eraId;
              return (
                <button className={`era-card${isSelected ? " era-card-selected" : ""}`} key={eraId}
                  disabled={!props.manifest || props.loadingEra !== null} aria-pressed={isSelected}
                  onClick={() => props.onSelect(eraId)} aria-label={`Select ${era.title}, ${era.years}`}>
                  <span className="era-ordinal">{era.ordinal}</span>
                  <span className="era-card-main"><strong>{era.title}</strong><span className="era-years">{era.years}</span></span>
                  <span className="era-arrow" aria-hidden="true">→</span>
                </button>
              );
            })}
          </div>
          <aside className={`era-detail${selected ? " era-detail-selected" : ""}`} aria-live="polite">
            {selected && props.selectedEra ? (
              <>
                <div className="era-detail-kicker"><span>Selected era</span><strong>{selected.ordinal}</strong></div>
                <div><p className="era-detail-years">{selected.years}</p><h3>{selected.title}</h3></div>
                <p className="era-detail-copy">{selected.flavor}</p>
                <div className="era-mode"><span>Game mode</span><strong>Era Draft</strong></div>
                {props.overwriteEra === props.selectedEra ? (
                  <div className="overwrite-confirm" role="alert">
                    <p>Starting a new draft will replace your current saved draft.</p>
                    <div><button className="quiet-button" onClick={() => {
                      props.onCancelOverwrite();
                      requestAnimationFrame(() => startButtonRef.current?.focus());
                    }}>Cancel</button>
                      <button className="secondary-action" onClick={() => props.onConfirmOverwrite(props.selectedEra!)}>Start new draft</button></div>
                  </div>
                ) : (
                  <button ref={startButtonRef} className="primary-action start-draft-action" disabled={props.loadingEra !== null}
                    onClick={() => props.onStart(props.selectedEra!)}>
                    {props.loadingEra === props.selectedEra ? "Loading verified era…" : "Start draft"}<span aria-hidden="true">→</span>
                  </button>
                )}
              </>
            ) : (
              <div className="era-detail-empty"><span className="era-detail-mark" aria-hidden="true">ED</span>
                <div><h3>Select an era</h3><p>Review its years and character before starting the draft.</p></div></div>
            )}
          </aside>
        </div>
        {!props.manifest && !props.error && <p className="load-status" role="status">Loading era index…</p>}
        {props.error && <p className="load-error" role="alert">{props.error}</p>}
      </section>
    </main>
  );
}

function DraftExperience(props: {
  session: { readonly catalog: EraDraftCatalog; readonly state: Exclude<Phase2EraDraftState, { phase: "REVEALED" }> };
  persistenceWarning: string | null;
  onAccepted: (result: EraDraftTransitionResult) => string | null;
  onExit: () => void;
}): ReactElement {
  const { catalog } = props.session;
  const state = props.session.state;
  const view = useMemo(() => projectEraDraftPublicState(catalog, state), [catalog, state]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("Spin to reveal a franchise-season.");
  const nextActionRef = useRef<HTMLButtonElement>(null);
  const era = ERA_COPY[view.phase === "SETUP" ? "era-foundation" : view.eraId];

  const transition = (command: Parameters<typeof reduceEraDraft>[2]): void => {
    const result = reduceEraDraft(catalog, state, command);
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    const saveWarning = props.onAccepted(result);
    setSelectedId(null);
    const acceptedMessage = command.type === "LOCK_PLAYER"
      ? result.state.phase === "XI_COMPLETE" ? "Pick 11 locked. Your XI is complete." : `Pick ${result.state.picks.length} locked. Spin again.`
      : command.type === "RESPIN" ? "Respin used. A new franchise-season is ready."
        : command.type === "REVEAL_XI" ? "Team revealed. Ratings are now available."
          : "Franchise-season revealed. Choose one player.";
    setMessage(saveWarning ? `${acceptedMessage} ${saveWarning}` : acceptedMessage);
    if (command.type === "LOCK_PLAYER") requestAnimationFrame(() => nextActionRef.current?.focus());
  };

  const selected = view.phase === "AWAITING_PICK" ? view.candidates.find((candidate) => candidate.playerTeamSeasonId === selectedId) : undefined;
  return (
    <main className="era-shell draft-shell">
      <header className="game-header draft-header">
        <button className="wordmark wordmark-button" onClick={props.onExit} aria-label="Return to era selection">
          <span className="wordmark-mark">ED</span><span>ERA DRAFT</span>
        </button>
        <div className="draft-era-id"><span>{era.title}</span><strong>{era.years}</strong></div>
        <button className="quiet-button" onClick={props.onExit}>Exit draft</button>
      </header>

      <div className="draft-layout">
        <section className="draft-stage" aria-labelledby="draft-stage-title">
          {view.phase !== "SETUP" && <DraftControlRegion view={view} era={era} primaryActionRef={nextActionRef} onTransition={transition} />}
          {props.persistenceWarning && <p className="draft-warning" role="status">{props.persistenceWarning}</p>}

          {view.phase === "AWAITING_SPIN" && (
            <div className="roster-empty-state">
              <span className="roster-empty-index" aria-hidden="true">{String(view.status.pickCount + 1).padStart(2, "0")}</span>
              <div><h2>{view.status.pickCount === 0 ? "Your first squad is waiting." : "Ready for the next spin."}</h2>
                <p>The verified roster will appear here without changing your playing XI.</p></div>
            </div>
          )}

          {view.phase === "AWAITING_PICK" && (
            <CandidateGallery view={view} selectedId={selectedId} selected={selected} onSelect={(candidate) => {
              setSelectedId(candidate.playerTeamSeasonId);
              setMessage(`${candidate.playerName} selected. Choose an open batting position.`);
            }} />
          )}

          {view.phase === "XI_COMPLETE" && (
            <div className="complete-state"><p className="eyebrow">Draft complete</p><h2>Your XI is locked.</h2>
              <p>Every position is permanent. Reveal ratings and review how the team was constructed.</p>
              <button ref={nextActionRef} className="primary-action reveal-team-action" onClick={() => transition({ type: "REVEAL_XI" })}>Reveal team <span aria-hidden="true">→</span></button></div>
          )}
          <p className="sr-status" aria-live="polite">{message}</p>
        </section>

        {view.phase !== "SETUP" && <XiPanel view={view} selected={selected} onLock={(playerTeamSeasonId, battingPosition) =>
          transition({ type: "LOCK_PLAYER", playerTeamSeasonId, battingPosition })} />}
      </div>
    </main>
  );
}

function CandidateGallery(props: {
  view: Extract<EraDraftPublicView, { phase: "AWAITING_PICK" }>;
  selectedId: string | null;
  selected?: DraftCandidateIdentityView;
  onSelect: (candidate: DraftCandidateIdentityView) => void;
}): ReactElement {
  return (
    <div className="candidate-section">
      <div className="candidate-heading"><h3>Eligible squad</h3><span>{props.view.candidates.length} players</span></div>
      <div className="candidate-grid">
        {props.view.candidates.map((candidate) => {
          const selected = candidate.playerTeamSeasonId === props.selectedId;
          return (
            <button key={candidate.playerTeamSeasonId} className={`candidate-card${selected ? " candidate-card-selected" : ""}`}
              disabled={!candidate.available} aria-pressed={selected}
              title={!candidate.available ? candidate.positions.flatMap((position) => position.reasons)[0]?.message : undefined}
              onClick={() => props.onSelect(candidate)}>
              <span className="portrait-placeholder" aria-hidden="true"><span>{monogram(candidate.playerName)}</span></span>
              <span className="candidate-body"><strong>{candidate.playerName}</strong><span>{friendly(candidate.derivedRole)}</span>
                <span className="candidate-meta">{candidate.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}
                  {candidate.keeperCapability === "CONFIRMED" ? " · WK" : ""}</span></span>
              <span className="select-mark" aria-hidden="true">{selected ? "✓" : "+"}</span>
            </button>
          );
        })}
      </div>
      {props.selected && <SelectedPlayerDetail candidate={props.selected} />}
    </div>
  );
}

function SelectedPlayerDetail({ candidate }: { candidate: DraftCandidateIdentityView }): ReactElement {
  const availablePositions = candidate.positions.filter((position) => position.available);
  return <section className="selected-player-detail" aria-labelledby="selected-player-title">
    <span className="selected-player-portrait" aria-hidden="true">{monogram(candidate.playerName)}</span>
    <div className="selected-player-copy">
      <p className="eyebrow">Selected player</p><h3 id="selected-player-title">{candidate.playerName}</h3>
      <p>{candidate.teamName} · {candidate.seasonYear}</p>
      <div className="selected-player-meta">
        <span>{friendly(candidate.derivedRole)}</span>
        <span>{candidate.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}</span>
        {candidate.keeperCapability === "CONFIRMED" && <span>Wicketkeeper</span>}
        <span>{friendly(candidate.bowlingWorkloadClass)} bowling</span>
        <span>{friendly(candidate.bowlingFamily)}</span>
      </div>
    </div>
    <div className="selected-player-instruction"><strong>Choose a batting position</strong>
      <span>{availablePositions.length} of 11 slots currently available</span></div>
  </section>;
}

function RevealedExperience(props: {
  session: { readonly catalog: EraDraftCatalog; readonly state: Extract<Phase2EraDraftState, { phase: "REVEALED" }> };
  persistenceWarning: string | null;
  onExit: () => void;
}): ReactElement {
  const view = useMemo(
    () => projectEraDraftRevealState(props.session.catalog, props.session.state),
    [props.session.catalog, props.session.state],
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const era = ERA_COPY[view.eraId];
  useEffect(() => headingRef.current?.focus(), []);
  return <main className="era-shell draft-shell revealed-shell">
    <header className="game-header draft-header">
      <button className="wordmark wordmark-button" onClick={props.onExit} aria-label="Return to era selection">
        <span className="wordmark-mark">ED</span><span>ERA DRAFT</span>
      </button>
      <div className="draft-era-id"><span>{era.title}</span><strong>{era.years}</strong></div>
      <button className="quiet-button" onClick={props.onExit}>Exit draft</button>
    </header>
    <div className="draft-layout reveal-layout">
      <section className="draft-stage reveal-stage" aria-labelledby="reveal-title">
        {props.persistenceWarning && <p className="draft-warning" role="status">{props.persistenceWarning}</p>}
        <div className="reveal-intro"><p className="eyebrow">{era.title} · {era.years}</p>
          <h1 ref={headingRef} tabIndex={-1} id="reveal-title">Your team, revealed.</h1>
          <p>Ratings reflect each historical player-season and the batting position where you locked it.</p></div>
        <div className="strength-grid" aria-label="Team strength ratings">
          <RevealMetric label="Overall" value={view.evaluation.strength.overall} featured />
          <RevealMetric label="Batting" value={view.evaluation.strength.batting} />
          <RevealMetric label="Bowling" value={view.evaluation.strength.bowling} />
        </div>
        <section className="evaluation-summary" aria-labelledby="evaluation-title">
          <div className="candidate-heading"><h2 id="evaluation-title">Team construction</h2><span>Evaluation V2</span></div>
          <EvaluationRow label="Quality tiers" value={countSummary(view.evaluation.tierCounts, ["S", "A", "B", "C", "D"])} />
          <EvaluationRow label="Position fit" value={countSummary(view.evaluation.fitCounts, ["NATURAL", "ACCEPTABLE", "STRETCH", "MAJOR_STRETCH", "UNKNOWN"])} />
          <EvaluationRow label="Overseas" value={`${view.evaluation.construction.overseasCount}/${view.evaluation.construction.overseasLimit}`} />
          <EvaluationRow label="Wicketkeeper" value={view.evaluation.construction.hasWicketkeeper ? "Covered" : "Not covered"} />
          <EvaluationRow label="Bowling deployment" value={`${formatRating(view.evaluation.construction.deployedBowlingUnits)}/${view.evaluation.construction.requiredBowlingUnits} units`} />
          <EvaluationRow label="Bowling options" value={`${view.evaluation.construction.frontlineBowlers} frontline · ${view.evaluation.construction.supportBowlers} support`} />
        </section>
        <div className="phase-boundary"><p className="eyebrow">Next phase</p><h2>Take this XI into a season.</h2>
          <p>League simulation and playoffs begin in Phase 3.</p><button className="primary-action" disabled>Begin season</button></div>
        <p className="sr-status" aria-live="polite">Team revealed. Player and team ratings are now visible.</p>
      </section>
      <XiPanel view={view} />
    </div>
  </main>;
}

function RevealMetric({ label, value, featured = false }: { label: string; value: number; featured?: boolean }): ReactElement {
  return <div className={`reveal-metric${featured ? " reveal-metric-featured" : ""}`}><span>{label}</span><strong>{formatRating(value)}</strong></div>;
}

function EvaluationRow({ label, value }: { label: string; value: string }): ReactElement {
  return <div className="evaluation-row"><span>{label}</span><strong>{value}</strong></div>;
}

function XiPanel(props: {
  view: Exclude<EraDraftPublicView, { phase: "SETUP" }> | EraDraftRevealView;
  selected?: DraftCandidateIdentityView;
  onLock?: (playerTeamSeasonId: string, battingPosition: number) => void;
}): ReactElement {
  const positions = Array.from({ length: 11 }, (_, index) => index + 1);
  const revealed = props.view.phase === "REVEALED";
  return (
    <aside className="xi-panel" aria-labelledby="xi-title">
      <div className="xi-heading"><div><p className="eyebrow">{revealed ? "Final team" : "Construction"}</p><h2 id="xi-title">{revealed ? "Your revealed XI" : "Your playing XI"}</h2></div>
        <span className="pick-counter">{String(props.view.status.pickCount).padStart(2, "0")}<small>/11</small></span></div>
      <div className="draft-status" aria-label="Draft status">
        <Status label="Overseas" value={`${props.view.status.overseasCount}/4`} />
        <Status label="Keeper" value={props.view.status.hasWicketkeeper ? "Ready" : "Needed"} active={props.view.status.hasWicketkeeper} />
        <Status label={revealed ? "State" : "Respin"} value={revealed ? "Revealed" : friendly(props.view.status.respinStatus)} active={revealed} />
      </div>
      <div className="xi-slots">
        {positions.map((position) => {
          const pick = props.view.picks.find((item) => item.battingPosition === position);
          const revealPlayer = props.view.phase === "REVEALED"
            ? props.view.players.find((item) => item.battingPosition === position)
            : undefined;
          const option = props.selected?.positions.find((item) => item.battingPosition === position);
          return pick
            ? <XiPlayerCard key={position} position={position} pick={pick} revealed={revealPlayer} />
            : <button key={position} className={`xi-slot${props.selected ? " xi-slot-active" : ""}${option ? ` xi-target-${fitClass(option.presentationFit)}` : ""}`}
                disabled={!props.selected || !option?.available}
                title={!option?.available && option?.reasons[0] ? option.reasons[0].message : undefined}
                onClick={() => props.selected && props.onLock?.(props.selected.playerTeamSeasonId, position)}>
                <span className="position-number">{String(position).padStart(2, "0")}</span>
                <span className="xi-portrait xi-portrait-empty" aria-hidden="true"><span>+</span></span>
                <span className="empty-slot-copy"><strong>{props.selected ? option?.available ? "Lock player here" : "Position unavailable" : "Open position"}</strong>
                  <small>Batting position {String(position).padStart(2, "0")}</small></span>
                <span className="xi-card-rail">{props.selected && option && <FitBadge fit={option.presentationFit} />}</span>
              </button>;
        })}
      </div>
      {(props.view.phase === "XI_COMPLETE" || revealed) && <div className="xi-complete-mark"><span>11/11</span><strong>{revealed ? "Team revealed" : "XI complete"}</strong></div>}
    </aside>
  );
}

function XiPlayerCard({ position, pick, revealed }: { position: number; pick: DraftPickView; revealed?: RevealPlayerView }): ReactElement {
  const style = { "--reveal-order": position - 1 } as CSSProperties;
  return <article style={style} className={`xi-slot xi-slot-locked xi-fit-${fitClass(pick.presentationFit)}${revealed ? " xi-slot-revealed" : ""}`}>
    <span className="position-number">{String(position).padStart(2, "0")}</span>
    <span className="xi-portrait" aria-hidden="true"><span>{monogram(pick.playerName)}</span></span>
    <span className="locked-player"><strong>{pick.playerName}</strong><small>{pick.teamName} · {pick.seasonYear}</small>
      <span>{friendly(pick.derivedRole)} · {pick.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}{pick.keeperCapability === "CONFIRMED" ? " · WK" : ""}</span></span>
    <span className="xi-card-rail">
      {revealed && <><span className={`quality-tier tier-${revealed.qualityTier.toLowerCase()}`}>{revealed.qualityTier}</span>
        <strong className="overall-rating" aria-label={`Overall rating ${formatRating(revealed.overallRating)}`}>{formatRating(revealed.overallRating)}</strong>
        <span className="component-ratings"><small>BAT {nullableRating(revealed.battingRating)}</small><small>BWL {nullableRating(revealed.bowlingRating)}</small></span></>}
      <FitBadge fit={pick.presentationFit} />
    </span>
  </article>;
}

function DraftControlRegion(props: {
  view: Exclude<EraDraftPublicView, { phase: "SETUP" }>;
  era: (typeof ERA_COPY)[EraId];
  primaryActionRef: RefObject<HTMLButtonElement | null>;
  onTransition: (command: Parameters<typeof reduceEraDraft>[2]) => void;
}): ReactElement {
  const spinVisible = props.view.phase === "AWAITING_SPIN";
  const respinVisible = props.view.phase === "AWAITING_PICK" && props.view.status.respinStatus === "AVAILABLE";
  return <div className="draft-control-region">
    <div className="draft-control-labels"><p className="eyebrow">{props.era.title} · {props.era.years}</p>
      <span>Pick {String(Math.min(props.view.status.pickCount + 1, 11)).padStart(2, "0")} / 11</span></div>
    <div className="draft-control-main"><h1 id="draft-stage-title">{stageTitle(props.view)}</h1>
      <div className="draft-control-actions">
        {spinVisible && <button ref={props.primaryActionRef} className="primary-action" onClick={() => props.onTransition({ type: "SPIN" })}>Spin franchise <span aria-hidden="true">→</span></button>}
        {respinVisible && <button className="secondary-action" onClick={() => props.onTransition({ type: "RESPIN" })}>Respin</button>}
      </div>
    </div>
    <div className="draft-context-strip">
      <div className="franchise-context">
        {props.view.phase === "AWAITING_PICK" ? <><strong>{props.view.currentSpin.teamName}</strong><span>{props.view.currentSpin.seasonYear}</span></>
          : props.view.phase === "XI_COMPLETE" ? <><strong>Playing XI complete</strong><span>11 locked</span></>
          : <><strong>Franchise-season</strong><span>Awaiting spin</span></>}
      </div>
      <span className={`respin-status respin-${props.view.status.respinStatus.toLowerCase()}`}>Respin · {friendly(props.view.status.respinStatus)}</span>
    </div>
  </div>;
}

function FitBadge({ fit }: { fit: DraftPresentationFit }): ReactElement {
  return <span className={`fit-badge fit-${fitClass(fit)}`}>{friendly(fit)}</span>;
}

function Status({ label, value, active = false }: { label: string; value: string; active?: boolean }): ReactElement {
  return <span className={active ? "status-ready" : undefined}><small>{label}</small><strong>{value}</strong></span>;
}

function LoadingSession(): ReactElement {
  return <main className="era-shell centered-state" aria-live="polite"><p className="eyebrow">Era Draft</p><h1>Returning to era selection…</h1></main>;
}

function NotFound({ onExit }: { onExit: () => void }): ReactElement {
  return <main className="era-shell centered-state"><p className="eyebrow">404</p><h1>That route is outside the boundary.</h1>
    <button className="primary-action" onClick={onExit}>Return home</button></main>;
}

function stageTitle(view: EraDraftPublicView): string {
  if (view.phase === "SETUP") return "Start the draft";
  if (view.phase === "AWAITING_PICK") return "Choose one player";
  if (view.phase === "XI_COMPLETE") return "XI complete";
  return view.status.pickCount === 0 ? "Ready to draft" : "Ready for the next spin";
}

function monogram(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function friendly(value: string): string {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fitClass(fit: DraftPresentationFit): string {
  return fit.toLowerCase().replaceAll("_", "-");
}

function formatRating(value: number): string {
  return value.toFixed(1);
}

function nullableRating(value: number | null): string {
  return value === null ? "—" : formatRating(value);
}

function countSummary<T extends string>(counts: Readonly<Record<T, number>>, order: readonly T[]): string {
  return order.filter((key) => counts[key] > 0).map((key) => `${friendly(key)} ${counts[key]}`).join(" · ") || "None";
}

function saveSummaryLabel(phase: Phase2EraDraftState["phase"], pickCount: number): string {
  if (phase === "REVEALED") return "Team revealed · 11/11 locked";
  if (phase === "XI_COMPLETE") return "Ready to reveal · 11/11 locked";
  if (phase === "AWAITING_PICK") return `Player selection open · ${pickCount}/11 locked`;
  return `Ready to spin · ${pickCount}/11 locked`;
}

function createRootSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `era-draft-web-v1:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
