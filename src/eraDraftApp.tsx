import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type RefObject } from "react";

import type { EraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { projectEraDraftGameCompleteState, projectEraDraftPublicState, projectEraDraftRevealState } from "./eraDraftProjection.js";
import type {
  DraftCandidateIdentityView,
  DraftPickView,
  DraftPresentationFit,
  EraDraftRevealView,
  EraDraftGameCompleteView,
  EraDraftPublicView,
  EraDraftTransitionResult,
  RevealPlayerView,
} from "./eraDraftTypes.js";
import {
  clearEraDraftUiSave,
  loadAndRestoreEraDraftUiSave,
  persistAcceptedEraDraftTransition,
  readEraDraftUiSave,
  writeEraDraftUiSave,
  type EraDraftPresentationCursor,
  type EraDraftUiSaveReadResult,
  type PersistableEraDraftState,
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

type DraftSession = {
  readonly catalog: EraDraftCatalog;
  readonly state: PersistableEraDraftState;
  readonly presentationCursor: EraDraftPresentationCursor | null;
};

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

  const acceptTransition = (
    catalog: EraDraftCatalog,
    result: EraDraftTransitionResult,
    presentationCursor: EraDraftPresentationCursor | null = null,
  ): string | null => {
    if (!result.ok) return null;
    if (result.state.phase === "SETUP") throw new Error("The web UI cannot present SETUP.");
    setSession({ catalog, state: result.state, presentationCursor });
    try {
      const persisted = persistAcceptedEraDraftTransition(result, undefined, presentationCursor);
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

  const setSeasonCursor = (cursor: EraDraftPresentationCursor): void => {
    if (!session || session.state.phase !== "GAME_COMPLETE") return;
    setSession({ ...session, presentationCursor: cursor });
    try {
      const save = writeEraDraftUiSave(session.state, undefined, cursor);
      setSavedGame({ kind: "CANDIDATE", save });
      setPersistenceWarning(null);
    } catch (error) {
      setPersistenceWarning(error instanceof Error ? error.message : "This checkpoint could not be saved locally.");
    }
  };

  if (route === "ERA_DRAFT") {
    if (!session) return <LoadingSession />;
    if (session.state.phase === "GAME_COMPLETE") {
      if (!session.presentationCursor) throw new Error("Completed season is missing its presentation cursor.");
      return <SeasonExperience session={{ catalog: session.catalog, state: session.state, cursor: session.presentationCursor }}
        persistenceWarning={persistenceWarning} onCursor={setSeasonCursor} onExit={() => navigate("HOME")}
        onSameEra={() => void startDraft(session.state.eraId)} onNewEra={() => {
          if (discardSave()) {
            setLandingNotice(null);
            setSelectedEra(null);
            navigate("HOME");
          }
        }} />;
    }
    return session.state.phase === "REVEALED"
      ? <RevealedExperience session={{ catalog: session.catalog, state: session.state }} persistenceWarning={persistenceWarning}
          onBeginSeason={() => {
            const result = reduceEraDraft(session.catalog, session.state, { type: "SIMULATE_SEASON" });
            if (!result.ok || result.state.phase !== "GAME_COMPLETE") throw new Error("The season could not be simulated.");
            acceptTransition(session.catalog, result, { phase: "LEAGUE", revealedUserMatches: 1 });
          }} onExit={() => navigate("HOME")} />
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
            <p>{saveSummaryLabel(props.savedGame.save.summary.phase, props.savedGame.save.summary.pickCount,
              props.savedGame.save.envelope.presentationCursor)}</p></div>
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

export function DraftExperience(props: {
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

  useEffect(() => {
    if (selectedId === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setSelectedId(null);
      setMessage("Player selection cleared.");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);

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
              if (candidate.playerTeamSeasonId === selectedId) {
                setSelectedId(null);
                setMessage("Player selection cleared.");
                return;
              }
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
  let previousGroup: DraftCandidateIdentityView["presentationGroup"] | null = null;
  return (
    <div className="candidate-section">
      <div className="candidate-heading"><h3>Eligible squad</h3><span>{props.view.candidates.length} players</span></div>
      <div className="candidate-grid">
        {props.view.candidates.map((candidate) => {
          const selected = candidate.playerTeamSeasonId === props.selectedId;
          const showGroup = candidate.presentationGroup !== previousGroup;
          previousGroup = candidate.presentationGroup;
          return (
            <div className="candidate-entry" key={candidate.playerTeamSeasonId}>
              {showGroup && <div className="candidate-group-label"><span>{friendly(candidate.presentationGroup)}</span></div>}
              <button className={`candidate-card${selected ? " candidate-card-selected" : ""}`}
                disabled={!candidate.available} aria-pressed={selected}
                title={!candidate.available ? candidate.positions.flatMap((position) => position.reasons)[0]?.message : undefined}
                onClick={() => props.onSelect(candidate)}>
                <span className="portrait-placeholder" aria-hidden="true"><span>{monogram(candidate.playerName)}</span></span>
                <span className="candidate-body"><strong>{candidate.playerName}</strong><span>{friendly(candidate.derivedRole)}</span>
                  <span className="candidate-meta">{candidate.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}
                    {candidate.keeperCapability === "CONFIRMED" ? " · WK" : ""}</span></span>
                <span className="candidate-quick-stats">
                  {candidateQuickStats(candidate).map((line) => <span key={line}>{line}</span>)}
                </span>
                <span className="select-mark" aria-hidden="true">{selected ? "✓" : "+"}</span>
              </button>
            </div>
          );
        })}
      </div>
      {props.selected && <SelectedPlayerDetail candidate={props.selected} />}
    </div>
  );
}

function SelectedPlayerDetail({ candidate }: { candidate: DraftCandidateIdentityView }): ReactElement {
  const availablePositions = candidate.positions.filter((position) => position.available);
  const showBatting = candidate.derivedRole !== "BOWLER" && candidate.derivedRole !== "UNKNOWN";
  const showBowling = candidate.derivedRole === "BOWLER" || candidate.derivedRole === "ALL_ROUNDER";
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
      <CurrentSeasonStats candidate={candidate} batting={showBatting} bowling={showBowling} />
    </div>
    <div className="selected-player-instruction"><strong>Choose a batting position</strong>
      <span>{availablePositions.length} of 11 slots currently available</span></div>
  </section>;
}

function CurrentSeasonStats(props: {
  candidate: DraftCandidateIdentityView;
  batting: boolean;
  bowling: boolean;
}): ReactElement {
  const { batting, bowling } = props.candidate.historicalStats.currentSeason;
  const lines: string[] = [];
  if (props.batting) {
    lines.push(`${props.bowling ? "BAT · " : ""}${batting.runs} runs${batting.strikeRate === null ? "" : ` · ${formatOneDecimal(batting.strikeRate)} SR`}${batting.average === null ? "" : ` · ${formatOneDecimal(batting.average)} avg`}`);
  }
  if (props.bowling) {
    lines.push(`${props.batting ? "BOWL · " : ""}${bowling.wickets} wickets${bowling.economy === null ? "" : ` · ${formatTwoDecimals(bowling.economy)} econ`}`);
  }
  return <div className="current-season-stats" aria-label={`${props.candidate.seasonYear} current season statistics`}>
    <span>{props.candidate.seasonYear} season</span>
    {lines.length > 0 ? lines.map((line) => <strong key={line}>{line}</strong>) : <strong>No recorded statistics</strong>}
  </div>;
}

function RevealedExperience(props: {
  session: { readonly catalog: EraDraftCatalog; readonly state: Extract<Phase2EraDraftState, { phase: "REVEALED" }> };
  persistenceWarning: string | null;
  onBeginSeason: () => void;
  onExit: () => void;
}): ReactElement {
  const view = useMemo(
    () => projectEraDraftRevealState(props.session.catalog, props.session.state),
    [props.session.catalog, props.session.state],
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const beginStartedRef = useRef(false);
  const [beginStarted, setBeginStarted] = useState(false);
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
        <div className="phase-boundary"><p className="eyebrow">Season ready</p><h2>Take this XI into a season.</h2>
          <p>One complete league and playoff result will be frozen when you begin.</p>
          <button className="primary-action" disabled={beginStarted} onClick={() => {
            if (beginStartedRef.current) return;
            beginStartedRef.current = true;
            setBeginStarted(true);
            props.onBeginSeason();
          }}>{beginStarted ? "Simulating season…" : "Begin season"} <span aria-hidden="true">→</span></button></div>
        <p className="sr-status" aria-live="polite">Team revealed. Player and team ratings are now visible.</p>
      </section>
      <XiPanel view={view} />
    </div>
  </main>;
}

export function SeasonExperience(props: {
  session: {
    readonly catalog: EraDraftCatalog;
    readonly state: Extract<PersistableEraDraftState, { phase: "GAME_COMPLETE" }>;
    readonly cursor: EraDraftPresentationCursor;
  };
  persistenceWarning: string | null;
  onCursor: (cursor: EraDraftPresentationCursor) => void;
  onExit: () => void;
  onSameEra: () => void;
  onNewEra: () => void;
}): ReactElement {
  const view = useMemo(() => projectEraDraftGameCompleteState(props.session.catalog, props.session.state),
    [props.session.catalog, props.session.state]);
  const { cursor } = props.session;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), [cursor]);
  const era = ERA_COPY[view.eraId];
  return <main className="era-shell season-shell">
    <header className="game-header draft-header">
      <button className="wordmark wordmark-button" onClick={props.onExit} aria-label="Return to era selection">
        <span className="wordmark-mark">ED</span><span>ERA DRAFT</span>
      </button>
      <div className="draft-era-id"><span>{era.title}</span><strong>{era.years}</strong></div>
      <button className="quiet-button" onClick={props.onExit}>Exit season</button>
    </header>
    {props.persistenceWarning && <p className="draft-warning" role="status">{props.persistenceWarning}</p>}
    {cursor.phase === "LEAGUE" && <LeagueCheckpoint view={view} revealed={cursor.revealedUserMatches}
      headingRef={headingRef} onNext={() => props.onCursor(cursor.revealedUserMatches < 14
        ? { phase: "LEAGUE", revealedUserMatches: cursor.revealedUserMatches + 1 }
        : { phase: "LEAGUE_COMPLETE" })}
      onSimRemaining={() => props.onCursor({ phase: "LEAGUE_COMPLETE" })} />}
    {cursor.phase === "LEAGUE_COMPLETE" && <LeagueComplete view={view} headingRef={headingRef}
      onContinue={() => props.onCursor(view.league.qualified
        ? { phase: "PLAYOFFS", revealedPlayoffMatches: 1 }
        : { phase: "COMPLETE" })} />}
    {cursor.phase === "PLAYOFFS" && <PlayoffExperience view={view} revealed={cursor.revealedPlayoffMatches}
      headingRef={headingRef} onNext={() => props.onCursor(cursor.revealedPlayoffMatches < view.playoffs.userMatches.length
        ? { phase: "PLAYOFFS", revealedPlayoffMatches: cursor.revealedPlayoffMatches + 1 }
        : { phase: "COMPLETE" })}
      onSimToEnd={() => props.onCursor({ phase: "COMPLETE" })} />}
    {cursor.phase === "COMPLETE" && <TerminalExperience view={view} headingRef={headingRef}
      onSameEra={props.onSameEra} onNewEra={props.onNewEra} />}
  </main>;
}

function LeagueCheckpoint(props: {
  view: EraDraftGameCompleteView;
  revealed: number;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onNext: () => void;
  onSimRemaining: () => void;
}): ReactElement {
  const checkpoint = props.view.league.userMatches[props.revealed - 1]!;
  return <div className="season-layout season-layout-progress">
    <section className="season-primary" aria-labelledby="season-match-title">
      <div className="season-kicker"><p className="eyebrow">League stage</p><span>Match {String(checkpoint.matchNumber).padStart(2, "0")} / 14</span></div>
      <h1 ref={props.headingRef} tabIndex={-1} id="season-match-title">{checkpoint.match.opponent?.teamName}</h1>
      <MatchResult match={checkpoint.match} />
      <LeagueProgressStrip matches={props.view.league.userMatches} revealed={props.revealed} />
      <div className="season-progress-summary">
        <div><span>Season record</span><strong>{checkpoint.record.won}–{checkpoint.record.lost}</strong></div>
        <div><span>League position</span><strong>{ordinal(checkpoint.position)}</strong>
          <small>{movementLabel(checkpoint.movement, checkpoint.previousPosition)}</small></div>
      </div>
      <div className="season-actions">
        <button className="primary-action" onClick={props.onNext}>{props.revealed === 14 ? "View final table" : "Next match"}<span aria-hidden="true">→</span></button>
        {props.revealed < 14 && <button className="secondary-action" onClick={props.onSimRemaining}>Sim remaining</button>}
      </div>
      <p className="sr-status" aria-live="polite">Match {checkpoint.matchNumber} revealed. {checkpoint.match.resultLabel}. Record {checkpoint.record.won} wins and {checkpoint.record.lost} losses. Position {checkpoint.position}.</p>
    </section>
    {checkpoint.matchNumber < 14
      ? <details className="league-standings-disclosure"><summary><span>Provisional standings</span>
          <strong>Your XI · {ordinal(checkpoint.position)}</strong></summary>
          <StandingsTable rows={checkpoint.standings} provisional />
        </details>
      : <StandingsTable rows={checkpoint.standings} provisional={false} />}
  </div>;
}

function LeagueProgressStrip(props: {
  matches: EraDraftGameCompleteView["league"]["userMatches"];
  revealed: number;
}): ReactElement {
  return <ol className="league-progress-strip" aria-label={`League progress: ${props.revealed} of 14 matches revealed`}>
    {props.matches.map((checkpoint, index) => {
      const visible = index < props.revealed;
      const result = checkpoint.match.result === "WIN" ? "W" : "L";
      const current = index === props.revealed - 1;
      return <li key={checkpoint.match.matchId} className={visible ? `progress-${result.toLowerCase()}${current ? " progress-current" : ""}` : "progress-upcoming"}
        aria-label={visible ? `Match ${index + 1}: ${result === "W" ? "win" : "loss"}` : `Match ${index + 1}: upcoming`}
        aria-current={current ? "step" : undefined}>
        <span>{String(index + 1).padStart(2, "0")}</span><strong>{visible ? result : "·"}</strong>
      </li>;
    })}
  </ol>;
}

function LeagueComplete(props: {
  view: EraDraftGameCompleteView;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onContinue: () => void;
}): ReactElement {
  return <div className="season-layout">
    <section className="season-primary league-complete-panel" aria-labelledby="league-complete-title">
      <p className="eyebrow">League complete</p>
      <h1 ref={props.headingRef} tabIndex={-1} id="league-complete-title">{props.view.league.qualified ? "Playoffs secured." : "Season ends here."}</h1>
      <p className="season-outcome-copy">Your XI finished {ordinal(props.view.league.userFinalPosition)} with a {props.view.league.userRecord.won}–{props.view.league.userRecord.lost} record.</p>
      <div className={`qualification-state ${props.view.league.qualified ? "qualified" : "eliminated"}`}>
        <span>{props.view.league.qualified ? "Qualified" : "Not qualified"}</span>
        <strong>{props.view.league.qualified ? "The playoff route is ready." : `Eventual champion: ${props.view.champion.teamName}`}</strong>
      </div>
      <button className="primary-action" onClick={props.onContinue}>{props.view.league.qualified ? "Begin playoffs" : "View season result"}<span aria-hidden="true">→</span></button>
      <p className="sr-status" aria-live="polite">Final league standings revealed. Your XI finished position {props.view.league.userFinalPosition} and {props.view.league.qualified ? "qualified" : "did not qualify"}.</p>
    </section>
    <StandingsTable rows={props.view.league.finalStandings} provisional={false} />
  </div>;
}

function PlayoffExperience(props: {
  view: EraDraftGameCompleteView;
  revealed: number;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onNext: () => void;
  onSimToEnd: () => void;
}): ReactElement {
  const match = props.view.playoffs.userMatches[props.revealed - 1]!;
  const allIndex = props.view.playoffs.allMatches.findIndex((item) => item.matchId === match.matchId);
  return <div className="season-layout playoff-layout">
    <section className="season-primary" aria-labelledby="playoff-match-title">
      <div className="season-kicker"><p className="eyebrow">Playoffs</p><span>{stageLabel(match.stage)}</span></div>
      <h1 ref={props.headingRef} tabIndex={-1} id="playoff-match-title">{match.opponent?.teamName}</h1>
      <MatchResult match={match} />
      <div className="season-actions"><button className="primary-action" onClick={props.onNext}>
        {props.revealed < props.view.playoffs.userMatches.length ? "Next match" : "View season result"}<span aria-hidden="true">→</span></button>
        <button className="secondary-action" onClick={props.onSimToEnd}>Sim to end</button></div>
      <p className="sr-status" aria-live="polite">{stageLabel(match.stage)} revealed. {match.resultLabel}.</p>
    </section>
    <PlayoffRoute matches={props.view.playoffs.allMatches.slice(0, allIndex + 1)} activeMatchId={match.matchId} />
  </div>;
}

function TerminalExperience(props: {
  view: EraDraftGameCompleteView;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onSameEra: () => void;
  onNewEra: () => void;
}): ReactElement {
  return <section className={`terminal-screen${props.view.champion.isUser ? " terminal-champion" : ""}`} aria-labelledby="terminal-title">
    <p className="eyebrow">Season complete</p>
    <h1 ref={props.headingRef} tabIndex={-1} id="terminal-title">{props.view.champion.isUser ? "Your XI are champions." : `${props.view.champion.teamName} are champions.`}</h1>
    <p className="champion-line">{props.view.champion.teamName}<span>IPL Era Draft champion</span></p>
    <div className="terminal-summary">
      <div><span>League finish</span><strong>{ordinal(props.view.league.userFinalPosition)}</strong></div>
      <div><span>Record</span><strong>{props.view.league.userRecord.won}–{props.view.league.userRecord.lost}</strong></div>
      <div><span>Season result</span><strong>{props.view.playoffs.userResult}</strong></div>
    </div>
    {props.view.league.qualified && <PlayoffRoute matches={props.view.playoffs.allMatches} />}
    <div className="terminal-actions"><button className="primary-action" onClick={props.onNewEra}>New Era Draft</button>
      <button className="secondary-action" onClick={props.onSameEra}>Draft same era again</button></div>
    <p className="sr-status" aria-live="polite">Season complete. {props.view.champion.teamName} are champions.</p>
  </section>;
}

function MatchResult({ match }: { match: EraDraftGameCompleteView["league"]["userMatches"][number]["match"] }): ReactElement {
  return <article className={`match-result match-result-${match.result.toLowerCase()}`} aria-label={match.resultLabel}>
    <div className="innings-row"><span><small>{match.firstInnings.teamId === "user" ? "Your XI" : match.firstInnings.teamName}</small><strong>{match.firstInnings.teamName}</strong></span>
      <b>{formatInnings(match.firstInnings.runs, match.firstInnings.wickets)}</b></div>
    <div className="innings-row"><span><small>{match.secondInnings.teamId === "user" ? "Your XI" : match.secondInnings.teamName}</small><strong>{match.secondInnings.teamName}</strong></span>
      <b>{formatInnings(match.secondInnings.runs, match.secondInnings.wickets)}</b></div>
    <div className="match-verdict"><span>{match.result === "AI_RESULT" ? "Result" : match.result}</span><strong>{match.resultLabel}</strong></div>
  </article>;
}

function StandingsTable({ rows, provisional }: { rows: EraDraftGameCompleteView["league"]["finalStandings"]; provisional: boolean }): ReactElement {
  return <section className="standings-panel" aria-labelledby="standings-title">
    <div className="candidate-heading"><h2 id="standings-title">{provisional ? "Provisional table" : "Final standings"}</h2><span>{provisional ? "In progress" : "14 matches"}</span></div>
    <div className="standings-scroll"><table><thead><tr><th scope="col">Pos</th><th scope="col">Team</th><th scope="col">P</th><th scope="col">W</th><th scope="col">L</th><th scope="col">Pts</th><th scope="col">NRR</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.teamId} className={row.isUser ? "user-standing" : undefined}>
        <td>{row.position}</td><th scope="row">{row.teamName}{row.isUser && <small>Your XI</small>}{row.qualified === true && <small>Qualified</small>}</th>
        <td>{row.played}</td><td>{row.won}</td><td>{row.lost}</td><td>{row.points}</td><td>{formatSigned(row.netRunRate)}</td>
      </tr>)}</tbody></table></div>
  </section>;
}

function PlayoffRoute({ matches, activeMatchId }: { matches: EraDraftGameCompleteView["playoffs"]["allMatches"]; activeMatchId?: string }): ReactElement {
  return <section className="playoff-route" aria-labelledby="playoff-route-title"><div className="candidate-heading"><h2 id="playoff-route-title">Playoff route</h2><span>Frozen result</span></div>
    <ol>{matches.map((match) => <li key={match.matchId} className={match.matchId === activeMatchId ? "active-playoff" : undefined}>
      <span>{stageLabel(match.stage)}</span><strong>{match.resultLabel}</strong>
    </li>)}</ol>
  </section>;
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

function candidateQuickStats(candidate: DraftCandidateIdentityView): string[] {
  const { batting, bowling } = candidate.historicalStats.currentSeason;
  const battingLine = `${batting.runs} runs${batting.strikeRate === null ? "" : ` · ${formatOneDecimal(batting.strikeRate)} SR`}`;
  const bowlingLine = `${bowling.wickets} ${bowling.wickets === 1 ? "wkt" : "wkts"}${bowling.economy === null ? "" : ` · ${formatTwoDecimals(bowling.economy)} econ`}`;
  if (candidate.derivedRole === "ALL_ROUNDER") return [battingLine, bowlingLine];
  if (candidate.derivedRole === "BOWLER" || candidate.derivedRole === "UNKNOWN") return [bowlingLine];
  return [battingLine];
}

function formatOneDecimal(value: number): string { return value.toFixed(1); }
function formatTwoDecimals(value: number): string { return value.toFixed(2); }
function formatInnings(runs: number, wickets: number): string { return wickets === 10 ? `${runs}` : `${runs}/${wickets}`; }
function formatSigned(value: number): string { return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`; }
function ordinal(value: number): string {
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? "th"
    : value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th";
  return `${value}${suffix}`;
}
function movementLabel(movement: "UP" | "DOWN" | "SAME" | "FIRST", previous: number | null): string {
  if (movement === "FIRST") return "Opening position";
  if (movement === "SAME") return "No movement";
  return `${movement === "UP" ? "Up" : "Down"} from ${ordinal(previous!)}`;
}
function stageLabel(stage: "LEAGUE" | "QUALIFIER_1" | "ELIMINATOR" | "QUALIFIER_2" | "FINAL"): string {
  if (stage === "QUALIFIER_1") return "Qualifier 1";
  if (stage === "QUALIFIER_2") return "Qualifier 2";
  if (stage === "ELIMINATOR") return "Eliminator";
  if (stage === "FINAL") return "Final";
  return "League";
}

function saveSummaryLabel(
  phase: PersistableEraDraftState["phase"],
  pickCount: number,
  cursor: EraDraftPresentationCursor | null = null,
): string {
  if (phase === "GAME_COMPLETE") {
    if (cursor?.phase === "LEAGUE") return `League match ${cursor.revealedUserMatches} / 14`;
    if (cursor?.phase === "LEAGUE_COMPLETE") return "Final standings ready";
    if (cursor?.phase === "PLAYOFFS") return "Playoffs in progress";
    return "Season complete";
  }
  if (phase === "REVEALED") return "Team revealed · 11/11 locked";
  if (phase === "XI_COMPLETE") return "Ready to reveal · 11/11 locked";
  if (phase === "AWAITING_PICK") return `Player selection open · ${pickCount}/11 locked`;
  return `Ready to spin · ${pickCount}/11 locked`;
}

function createRootSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `era-draft-web-v1:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
