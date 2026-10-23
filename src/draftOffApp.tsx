import { useEffect, useRef, useState, type FormEvent } from "react";
import { createDraftOffTransport, draftOffApiOrigin } from "./draftOffClientTransport.js";
import { enrollDraftOffGuest, createDraftOffSession, readDraftOffCredential, type DraftOffSessionState } from "./draftOffSession.js";
import { DraftOffRoomExperience, DRAFT_OFF_ERA_LABELS as ERAS, INITIAL_ROOM } from "./draftOffRoom.js";
import { appRoutePath, draftOffRoomCode, normalizeDraftOffCode, navigateToAppRoute, navigateToDraftOffRoom } from "./webRoutes.js";
import { ERA_IDS, type EraId } from "./teamEvaluationV2.js";
import "./draftOff.css";

type PendingEnrollment = { record?: string; operation: "CREATE" | "JOIN"; roomCode?: string; input: { displayName: string; eraId?: EraId; draftMinutes?: 10 | 15 } };
function pendingEnrollment(code: string | null): PendingEnrollment | null {
  const operation = code ? "JOIN" : "CREATE";
  const raw = localStorage.getItem(`draft-off:pending:${operation}:${code ?? ""}`);
  if (raw === null) return null;
  const record = JSON.parse(raw);
  if (!record || !/^[A-Za-z0-9_-]{43}$/.test(record.key) || typeof record.input !== "string") throw new Error("Saved enrollment cannot be safely read.");
  const input = JSON.parse(record.input);
  if (!input || typeof input.displayName !== "string") throw new Error("Saved enrollment cannot be safely read.");
  return { record: raw, operation, ...(code ? { roomCode: code } : {}), input };
}

export default function DraftOffApp() {
  const [path, setPath] = useState(window.location.pathname);
  const code = draftOffRoomCode(path);
  const [configured] = useState(() => { try { return { origin: draftOffApiOrigin(import.meta.env.VITE_DRAFT_OFF_API_ORIGIN), error: null }; }
    catch { return { origin: null, error: "Draft-Off API configuration is invalid." }; } });
  useEffect(() => { const onRoute = () => setPath(window.location.pathname); window.addEventListener("popstate", onRoute); return () => window.removeEventListener("popstate", onRoute); }, []);
  return <main className="era-shell gameplay-shell draft-off-shell">
    <div className="gameplay-atmosphere" aria-hidden="true" />
    <header className="game-header"><a className="wordmark" href={appRoutePath("HOME")} onClick={event => {
      if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigateToAppRoute("HOME"); }
    }}>ERA DRAFT</a><span>Draft-Off</span><a href={appRoutePath("HOME")} onClick={event => {
      if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigateToAppRoute("HOME"); }
    }}>Solo Era Draft</a></header>
    <div className="draft-off-content">
      {!configured.origin ? <section className="draft-off-panel"><h1>Draft-Off</h1><p>{configured.error ?? "Draft-Off is not connected to a backend in this build."}</p><p>Solo Era Draft remains available.</p></section>
        : <RoomEntry key={code ?? "entry"} apiOrigin={configured.origin} code={code} />}
    </div>
  </main>;
}

function RoomEntry({ apiOrigin, code }: { apiOrigin: string; code: string | null }) {
  const [initial] = useState(() => { try { return { credential: code ? readDraftOffCredential(localStorage, code) : null, pending: pendingEnrollment(code), error: null }; }
    catch { return { credential: null, pending: null, error: "Browser storage is unavailable or contains unreadable room recovery. Restore storage access before enrolling; saved recovery has been preserved." }; } });
  const [credential, setCredential] = useState(initial.credential);
  const [operation, setOperation] = useState<"CREATE" | "JOIN">(initial.pending?.operation ?? (code ? "JOIN" : "CREATE"));
  const [name, setName] = useState(initial.pending?.input.displayName ?? "");
  const [room, setRoom] = useState(code ?? "");
  const [era, setEra] = useState<EraId>(initial.pending?.input.eraId ?? "era-foundation");
  const [minutes, setMinutes] = useState<10 | 15>(initial.pending?.input.draftMinutes ?? 15);
  const [pending, setPending] = useState(initial.pending);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(initial.error);
  const [unavailable, setUnavailable] = useState(false);
  const [resumeCode, setResumeCode] = useState<string | null>(() => { try { return normalizeDraftOffCode(localStorage.getItem("draft-off:last-room") ?? ""); } catch { return null; } });
  const owner = useRef(0), inFlight = useRef(false);
  const transport = useRef<ReturnType<typeof createDraftOffTransport> | null>(null);
  useEffect(() => {
    transport.current = createDraftOffTransport();
    return () => { owner.current++; transport.current?.stop(); };
  }, []);
  if (credential && code) return <RoomBootstrap apiOrigin={apiOrigin} code={code} credential={credential} />;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (inFlight.current || initial.error) return;
    const normalized = operation === "JOIN" ? normalizeDraftOffCode(room) : undefined;
    if (operation === "JOIN" && !normalized) { setMessage("Enter the complete 12-character room code."); return; }
    if (!pending && operation === "JOIN" && !code) { navigateToDraftOffRoom(normalized!); return; }
    const intent: PendingEnrollment = pending ?? { operation, ...(normalized ? { roomCode: normalized } : {}),
      input: operation === "CREATE" ? { displayName: name.trim(), eraId: era, draftMinutes: minutes } : { displayName: name.trim() } };
    inFlight.current = true; const generation = ++owner.current; setBusy(true); setMessage(null); setUnavailable(false);
    try {
      const reply = await enrollDraftOffGuest({ apiOrigin, operation: intent.operation, roomCode: intent.roomCode,
        input: intent.input, storage: localStorage, transport: transport.current!.fetch,
        isActive: () => generation === owner.current,
        onEnrolled(roomCode, credential) {
          // Activation runs synchronously while this exact persisted attempt owns recovery.
          if (code === roomCode) setCredential(credential); else navigateToDraftOffRoom(roomCode);
          try { localStorage.setItem("draft-off:last-room", roomCode); } catch { /* Verified credentials remain the recovery authority. */ }
          setResumeCode(roomCode);
        },
      });
      if (generation !== owner.current) return;
      const result = reply.body;
      if (reply.status === 201 && result.ok && result.roomCode && result.participantId && result.reconnectCredential) {
        if (!reply.activated) setMessage("Enrollment changed in another tab. Current room recovery was preserved.");
        // Never activate from this possibly historical reply; only the guarded handoff above may do so.
        return;
      }
      setUnavailable(result.error?.code === "ROOM_CODE_UNAVAILABLE");
      setMessage(result.error?.code === "ROOM_CODE_COLLISION" ? "Room-code collision. Retry the saved enrollment with its replacement key."
        : `Enrollment not completed (${result.error?.code ?? "UNCONFIRMED"}). Saved recovery is preserved where required.`);
    } catch { if (generation === owner.current) setMessage("Enrollment is not confirmed. Restore storage/network access and retry the saved attempt with the same name and settings."); }
    finally {
      if (generation === owner.current) {
        try { setPending(pendingEnrollment(intent.roomCode ?? null)); } catch { setMessage("Enrollment recovery storage cannot be read. No replacement identity was created."); }
        inFlight.current = false; setBusy(false);
      }
    }
  }
  return <>
    <section className="draft-off-intro"><p className="eyebrow">Private multiplayer · 2–8 players</p><h1>Build your XI. Settle it on the pitch.</h1>
      <p>Draft independently against a shared deadline. Every eligible XI faces the same twenty historical fixtures, ranked by points and net run rate.</p></section>
    {resumeCode && !code && <button className="secondary-action" onClick={() => navigateToDraftOffRoom(resumeCode)}>Resume remembered room · {resumeCode}</button>}
    <section className="draft-off-panel" aria-labelledby="enrollment-title">
      <h2 id="enrollment-title">{code ? `Join room ${code}` : "Enter Draft-Off"}</h2>
      {!code && <div className="draft-off-tabs"><button className="secondary-action" disabled={busy || !!pending} aria-pressed={operation === "CREATE"} onClick={() => setOperation("CREATE")}>Create room</button>
        <button className="secondary-action" disabled={busy || !!pending} aria-pressed={operation === "JOIN"} onClick={() => setOperation("JOIN")}>Join room</button></div>}
      {pending && <p role="status">Saved enrollment awaiting confirmation. Retry uses the exact original name, settings and recovery key.</p>}
      <form onSubmit={event => void submit(event)} aria-busy={busy}>
        {operation === "JOIN" && <label>Room code<input value={room} required readOnly={!!code || !!pending} disabled={busy} autoCapitalize="characters" spellCheck={false} onChange={event => setRoom(event.target.value)} /></label>}
        {(operation === "CREATE" || code) && <label>Display name<input value={pending?.input.displayName ?? name} required readOnly={!!pending} disabled={busy} autoComplete="nickname" onChange={event => setName(event.target.value)} /></label>}
        {operation === "CREATE" && <><label>Era<select value={pending?.input.eraId ?? era} disabled={busy || !!pending} onChange={event => setEra(event.target.value as EraId)}>{ERA_IDS.map(id => <option key={id} value={id}>{ERAS[id]}</option>)}</select></label>
          <label>Draft time<select value={pending?.input.draftMinutes ?? minutes} disabled={busy || !!pending} onChange={event => setMinutes(Number(event.target.value) as 10 | 15)}><option value={10}>10 minutes</option><option value={15}>15 minutes</option></select></label>
          <p>Era and time are fixed when the room is created.</p></>}
        <button className="primary-action" disabled={busy || !!initial.error}>{busy ? "Confirming enrollment…" : pending ? "Retry saved enrollment" : operation === "CREATE" ? "Create private room" : code ? "Join private room" : "Continue to room"}</button>
      </form>
      {message && <p className="draft-off-notice" role="status">{message}</p>}
      {unavailable && pending?.operation === "CREATE" && <button className="secondary-action" onClick={() => {
        if (!window.confirm("Abandon this unavailable room creation? Its recovery key will be forgotten. This does not create or join another room.")) return;
        try {
          if (localStorage.getItem("draft-off:pending:CREATE:") !== pending.record) throw new Error("Enrollment changed.");
          localStorage.removeItem("draft-off:pending:CREATE:");
          if (localStorage.getItem("draft-off:pending:CREATE:") !== null) throw new Error("Storage cleanup failed.");
          setPending(null); setUnavailable(false); setMessage("Unavailable creation abandoned. You may create a different room."); }
        catch { setMessage("Recovery could not be cleared. The saved attempt is preserved."); }
      }}>Abandon unavailable creation</button>}
    </section>
    <p className="draft-off-footnote">Room access is remembered in this browser profile. Each player needs a separate browser profile, private context or device. Invite links contain only the room code.</p>
  </>;
}

function RoomBootstrap({ apiOrigin, code, credential }: { apiOrigin: string; code: string; credential: NonNullable<ReturnType<typeof readDraftOffCredential>> }) {
  const [state, setState] = useState<DraftOffSessionState>(INITIAL_ROOM);
  const session = useRef<ReturnType<typeof createDraftOffSession> | null>(null);
  useEffect(() => {
    try {
      const client = createDraftOffSession({ apiOrigin, roomCode: code, credential, journalStorage: sessionStorage, onChange: setState });
      session.current = client; void client.start();
      return () => { client.stop(); session.current = null; };
    } catch { setState(current => ({ ...current, error: "Room recovery storage cannot be safely read. Saved access has been preserved." })); }
  }, [apiOrigin, code, credential]);
  return <DraftOffRoomExperience code={code} state={state} actions={{
    command: command => session.current ? session.current.command(command) : Promise.reject(new Error("Room is not connected.")),
    retry: () => session.current?.retry() ?? Promise.resolve(),
    resync: () => session.current?.resync() ?? Promise.resolve(),
  }} />;
}
