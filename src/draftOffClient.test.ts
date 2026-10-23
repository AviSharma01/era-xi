import assert from "node:assert/strict";
import test from "node:test";
import { createDraftOffTransport, draftOffApiOrigin } from "./draftOffClientTransport.js";
import { enrollDraftOffGuest, createDraftOffSession } from "./draftOffSession.js";
import { appRoutePath, draftOffRoomCode, draftOffRoomPath, matchAppRoute } from "./webRoutes.js";
import { enrollGuest, type EnrollmentStorage } from "./draftOffEnrollmentClient.js";
import type { SnapshotSuccess } from "./draftOffClientTypes.js";

const code = "0123456789AB", credential = { participantId: "p_" + "a".repeat(32), reconnectCredential: "C".repeat(43) };
const storage = () => { const rows = new Map<string, string>(); return { rows, getItem: (key: string) => rows.get(key) ?? null,
  setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } }; };
function snapshot(revision = 2, draftRevision = 1): SnapshotSuccess {
  return { ok: true, roomCode: code, participantId: credential.participantId, settings: { draftMinutes: 15 }, serverTimeMs: 1000,
    view: { roomId: code, revision, phase: "IN_PROGRESS", participants: [{ participantId: credential.participantId, role: "HOST", membershipStatus: "JOINED", displayName: "Host" }],
      round: { roundId: "r1", roundOrdinal: 1, eraId: "era-foundation", label: "Draft-Off", phase: "DRAFTING" },
      myDraft: { phase: "AWAITING_SPIN", revision: draftRevision } } } as unknown as SnapshotSuccess;
}
// Socket factory deliberately has no frames: authenticated HTTP must stand alone.
const silentSocket = () => ({ protocol: "draft-off.v1", close() {} }) as unknown as WebSocket;
const response = (body: unknown, status = 200) => Response.json(body, { status });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function setup(send: typeof fetch, journalStorage = storage(), credentialStorage?: EnrollmentStorage, timeoutMs?: number) {
  let latest: ReturnType<ReturnType<typeof createDraftOffSession>["getState"]> | undefined;
  const client = createDraftOffSession({ apiOrigin: "https://api.test", roomCode: code, credential, journalStorage,
    credentialStorage, transport: createDraftOffTransport({ fetch: send, timeoutMs }), realtime: { createSocket: silentSocket, events: { addEventListener() {}, removeEventListener() {} } },
    onChange: state => { latest = state; } });
  return { client, journalStorage, latest: () => latest };
}
function server(command: (init: RequestInit) => Promise<Response>, read = () => snapshot()): typeof fetch {
  return async (url, init) => String(url).endsWith("/commands") ? command(init!) : String(url).endsWith("/socket-tickets")
    ? response({ ok: true, ticket: "T".repeat(43), expiresAtMs: 30000 }) : response(read());
}

test("Draft-Off routing respects nested bases, codes and existing routes", () => {
  assert.equal(appRoutePath("DRAFT_OFF", "/games/"), "/games/draft-off");
  assert.equal(draftOffRoomPath(code.toLowerCase(), "/games/"), "/games/draft-off/rooms/0123456789AB");
  assert.equal(matchAppRoute("/games/draft-off/rooms/0123456789ab/", "/games/"), "DRAFT_OFF");
  for (const path of ["/draft-off/rooms/0123456789AB", "/games/draft-off/rooms/0123456789AB/extra", "/games/draft-off/rooms/invalid"]) assert.equal(draftOffRoomCode(path, "/games/"), null);
  assert.equal(matchAppRoute("/classic", "/"), "CLASSIC");
  assert.equal(matchAppRoute("/era-draft", "/"), "ERA_DRAFT");
});

test("API origin is explicit, rooted and restricted to HTTPS or loopback HTTP", () => {
  assert.equal(draftOffApiOrigin(undefined), null);
  assert.equal(draftOffApiOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(draftOffApiOrigin("https://api.test/"), "https://api.test");
  for (const bad of ["http://remote.test", "https://user:pass@api.test", "https://api.test/prefix", "https://api.test/?token=x", "https://api.test/#secret"]) assert.throws(() => draftOffApiOrigin(bad));
});

test("shared request cooldown gates every caller and honors Retry-After", async () => {
  let calls = 0, now = 1000;
  const transport = createDraftOffTransport({ now: () => now, fetch: async () => { calls++; return new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }); } });
  await transport.fetch("https://api.test/commands");
  await assert.rejects(transport.fetch("https://api.test/socket-tickets"), /COOLDOWN/);
  await assert.rejects(transport.fetch("https://api.test/rooms"), /COOLDOWN/);
  assert.equal(calls, 1); now = 3000; await transport.fetch("https://api.test/rooms"); assert.equal(calls, 2); transport.stop();
});

test("request timeout, cancellation and body limits preserve bounded operations", async () => {
  const stalled = createDraftOffTransport({ timeoutMs: 10, fetch: () => new Promise(() => {}) });
  await assert.rejects(stalled.fetch("https://api.test"), /ABORTED/); stalled.stop();
  const body = createDraftOffTransport({ timeoutMs: 10, fetch: async () => new Response(new ReadableStream({ start() {} })) });
  await assert.rejects(body.fetch("https://api.test"), /ABORTED/); body.stop();
  const oversized = createDraftOffTransport({ maxBytes: 2, fetch: async () => new Response("large") });
  await assert.rejects(oversized.fetch("https://api.test"), /TOO_LARGE/); oversized.stop();
  const aborted = createDraftOffTransport({ fetch: () => new Promise(() => {}) });
  const request = aborted.fetch("https://api.test"); aborted.stop(); await assert.rejects(request, /ABORTED/);
});

test("immutable intents serialize commands, choose private revision and ignore receipt views", async () => {
  let finish!: (value: Response) => void, sent: Record<string, unknown> | undefined, revision = 2;
  const fixture = setup(server(async init => { sent = JSON.parse(init.body as string); return new Promise(resolve => { finish = resolve; }); }, () => snapshot(revision)));
  try {
    await fixture.client.start();
    const intent = { type: "LOCK_PLAYER" as const, playerTeamSeasonId: "original", battingPosition: 1 };
    const pending = fixture.client.command(intent);
    intent.playerTeamSeasonId = "mutated"; intent.battingPosition = 2;
    await assert.rejects(fixture.client.command({ type: "SPIN" }), /not ready/);
    assert.equal(sent!.expectedDraftRevision, 1); assert.equal(sent!.expectedRoomRevision, undefined);
    assert.deepEqual(sent!.command, { type: "LOCK_PLAYER", playerTeamSeasonId: "original", battingPosition: 1 });
    assert.equal(fixture.journalStorage.rows.size, 1);
    revision = 3; finish(response({ ok: true, changed: true, roomRevision: 3, view: { secretReceiptSentinel: true } }));
    await pending; assert.equal(fixture.journalStorage.rows.size, 0);
    assert.equal(fixture.latest()!.snapshot!.view.revision, 3); assert.equal(fixture.latest()!.pending, false);
    assert.doesNotMatch(JSON.stringify(fixture.latest()), /secretReceiptSentinel/);
  } finally { fixture.client.stop(); }
});

test("lost command responses survive refresh and retry the exact journal, including room revision", async () => {
  const saved = storage(), sent: string[] = [];
  let revision = 2;
  const first = setup(server(async init => { sent.push(init.body as string); revision = 3; throw new Error("lost after commit"); }, () => snapshot(revision)), saved);
  await first.client.start(); await first.client.command({ type: "LEAVE" });
  assert.equal(first.latest()!.pending, true); assert.equal(saved.rows.size, 1); first.client.stop();
  const second = setup(server(async init => { sent.push(init.body as string); return response({ ok: true, changed: true, roomRevision: 3 }); }, () => snapshot(revision)), saved);
  try {
    await second.client.start();
    assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]);
    assert.equal(JSON.parse(sent[0]).expectedRoomRevision, 2); assert.equal(saved.rows.size, 0);
  } finally { second.client.stop(); }
});

test("unverified journal storage prevents network commands; invalid recovery fails closed", async () => {
  let commands = 0;
  const saved = storage();
  saved.setItem = () => {};
  const fixture = setup(server(async () => { commands++; return response({ ok: true }); }), saved);
  try { await fixture.client.start(); await assert.rejects(fixture.client.command({ type: "SPIN" }), /storage/); assert.equal(commands, 0); }
  finally { fixture.client.stop(); }
  const corrupt = storage(); corrupt.rows.set(`draft-off:command:${code}:${credential.participantId}`, '{"version":99}');
  assert.throws(() => setup(server(async () => response({})), corrupt), /recovered/);
});

test("definitive stale rejection clears intent and resyncs; uncertain malformed reply keeps exact intent", async () => {
  let good = false;
  const fixture = setup(server(async () => good ? response({ ok: false, error: { code: "STALE_DRAFT_REVISION" }, roomRevision: 2 }, 409) : response({ ok: true })));
  try {
    await fixture.client.start(); await fixture.client.command({ type: "SPIN" });
    assert.equal(fixture.latest()!.pending, true); good = true; await fixture.client.retry();
    assert.equal(fixture.latest()!.pending, false); assert.equal(fixture.journalStorage.rows.size, 0);
    assert.match(fixture.latest()!.error!, /STALE_DRAFT_REVISION/);
  } finally { fixture.client.stop(); }
});

test("stopped session cannot publish delayed reads or clean another session's journal", async () => {
  let finish!: (reply: Response) => void;
  const fixture = setup(server(async () => new Promise(resolve => { finish = resolve; })));
  await fixture.client.start(); const request = fixture.client.command({ type: "SPIN" }); await flush();
  fixture.client.stop(); const last = fixture.latest();
  finish(response({ ok: true, changed: true, roomRevision: 3 })); await request;
  assert.equal(fixture.latest(), last); assert.equal(fixture.journalStorage.rows.size, 1);
});


test("a confirmed receipt cannot unlock new intents until authenticated reconciliation succeeds", async () => {
  let readsUnavailable = false;
  const send: typeof fetch = async (url) => {
    if (String(url).endsWith("/commands")) { readsUnavailable = true; return response({ ok: false, error: { code: "STALE_DRAFT_REVISION" }, roomRevision: 2 }, 409); }
    if (String(url).endsWith("/socket-tickets")) return response({ ok: true, ticket: "T".repeat(43), expiresAtMs: 30000 });
    return readsUnavailable ? response({ ok: false }, 503) : response(snapshot());
  };
  const fixture = setup(send);
  try {
    await fixture.client.start(); await fixture.client.command({ type: "SPIN" });
    assert.equal(fixture.journalStorage.rows.size, 0); assert.equal(fixture.latest()!.pending, true);
    await assert.rejects(fixture.client.command({ type: "SPIN" }), /not ready/);
    readsUnavailable = false; await fixture.client.resync(); assert.equal(fixture.latest()!.pending, false);
  } finally { fixture.client.stop(); }
});


function enrollmentReply(roomCode = code, participantId = credential.participantId, reconnectCredential = credential.reconnectCredential) {
  return response({ ok: true, roomCode, participantId, reconnectCredential }, 201);
}
function enrollmentOptions(saved: EnrollmentStorage, transport: typeof fetch, onEnrolled: (room: string) => void) {
  return { apiOrigin: "https://api.test", operation: "CREATE" as "CREATE" | "JOIN", input: { displayName: "A" },
    storage: saved, transport, isActive: () => true, onEnrolled };
}

for (const operation of ["CREATE", "JOIN"] as const) {
  test(`${operation}: delayed enrollment A cannot navigate over another tab's recoverable enrollment B`, async () => {
    const saved = storage(), navigations: string[] = [];
    const requests: { init: RequestInit; resolve: (value: Response) => void; reject: (reason: Error) => void }[] = [];
    const transport: typeof fetch = (_url, init) => new Promise((resolve, reject) => { requests.push({ init: init!, resolve, reject }); });
    const roomCode = operation === "JOIN" ? code : undefined;
    const options = { ...enrollmentOptions(saved, transport, room => { navigations.push(room); }), operation, roomCode };
    const slot = `draft-off:pending:${operation}:${roomCode ?? ""}`;
    const old = enrollDraftOffGuest(options);
    // Another tab recovers A successfully, leaving matching credentials in storage.
    const duplicate = enrollGuest(options.apiOrigin, operation, roomCode, options.input, saved, transport);
    requests[1].resolve(enrollmentReply()); await duplicate;
    assert.equal(saved.getItem(slot), null);
    const newer = enrollDraftOffGuest({ ...options, input: { displayName: "B" } });
    const pendingB = saved.getItem(slot); assert.ok(pendingB);
    requests[0].resolve(enrollmentReply());
    assert.equal((await old).activated, false);
    assert.deepEqual(navigations, [], "Matching credentials must not authorize a stale room/session change");
    assert.equal(saved.getItem(slot), pendingB);
    requests[2].reject(new Error("B response lost")); await assert.rejects(newer, /B response lost/);
    assert.equal(saved.getItem(slot), pendingB);
    const recovered = enrollDraftOffGuest({ ...options, input: { displayName: "B" } });
    assert.equal(new Headers(requests[3].init.headers).get("Enrollment-Key"), new Headers(requests[2].init.headers).get("Enrollment-Key"));
    assert.equal(requests[3].init.body, requests[2].init.body);
    const nextRoom = operation === "JOIN" ? code : "0123456789AC";
    requests[3].resolve(enrollmentReply(nextRoom, "p_" + "b".repeat(32), "D".repeat(43)));
    assert.equal((await recovered).activated, true);
    assert.deepEqual(navigations, [nextRoom]); assert.equal(saved.getItem(slot), null);
  });
}

for (const stage of ["credential-write", "helper-readback", "activation-readback"] as const) {
  test(`enrollment activation rechecks persisted ownership across ${stage}`, async () => {
    const saved = storage(), slot = "draft-off:pending:CREATE:", navigations: string[] = [];
    const pendingB = JSON.stringify({ key: "N".repeat(43), input: JSON.stringify({ displayName: "B" }) });
    let reads = 0;
    const changing: EnrollmentStorage = { ...saved,
      setItem(key, value) {
        saved.setItem(key, value);
        if (stage === "credential-write" && key.startsWith("draft-off:credential:")) saved.setItem(slot, pendingB);
      },
      getItem(key) {
        const value = saved.getItem(key);
        if (key.startsWith("draft-off:credential:")) {
          reads++;
          if ((stage === "helper-readback" && reads === 1) || (stage === "activation-readback" && reads === 2)) saved.setItem(slot, pendingB);
        }
        return value;
      },
    };
    const result = await enrollDraftOffGuest(enrollmentOptions(changing, async () => enrollmentReply(), room => { navigations.push(room); }));
    assert.equal(result.activated, false); assert.deepEqual(navigations, []); assert.equal(saved.getItem(slot), pendingB);
  });
}

test("enrollment ownership is checked after asynchronous response-body consumption", async () => {
  const saved = storage(), slot = "draft-off:pending:CREATE:", navigations: string[] = [];
  let finish!: (body: unknown) => void;
  const reply = enrollmentReply();
  reply.json = () => new Promise(resolve => { finish = resolve; });
  const attempt = enrollDraftOffGuest(enrollmentOptions(saved, async () => reply, room => { navigations.push(room); }));
  await flush();
  const pendingB = JSON.stringify({ key: "N".repeat(43), input: JSON.stringify({ displayName: "B" }) });
  saved.setItem(slot, pendingB);
  finish({ ok: true, roomCode: code, ...credential });
  assert.equal((await attempt).activated, false); assert.deepEqual(navigations, []); assert.equal(saved.getItem(slot), pendingB);
});

test("successful handoff precedes cleanup, and navigation cannot delete a newer pending enrollment", async () => {
  const saved = storage(), slot = "draft-off:pending:CREATE:";
  const pendingB = JSON.stringify({ key: "N".repeat(43), input: JSON.stringify({ displayName: "B" }) });
  let activations = 0;
  const result = await enrollDraftOffGuest(enrollmentOptions(saved, async () => enrollmentReply(), () => {
    assert.equal(JSON.parse(saved.getItem(slot)!).input, JSON.stringify({ displayName: "A" }));
    activations++;
    // Simulate a newer attempt being installed by the navigation handoff.
    saved.setItem(slot, pendingB);
  }));
  assert.equal(result.activated, true); assert.equal(activations, 1); assert.equal(saved.getItem(slot), pendingB);
});

test("response loss retains exact enrollment recovery and disposed UI cannot activate a session", async () => {
  const saved = storage(), slot = "draft-off:pending:CREATE:";
  const requests: RequestInit[] = []; let fail = true, active = true, activations = 0;
  const options = { ...enrollmentOptions(saved, async (_url, init) => {
    requests.push(init!); if (fail) throw new Error("lost"); return enrollmentReply();
  }, () => { activations++; }), isActive: () => active };
  await assert.rejects(enrollDraftOffGuest(options), /lost/);
  const pending = saved.getItem(slot); assert.ok(pending);
  fail = false;
  assert.equal((await enrollDraftOffGuest(options)).activated, true);
  assert.equal(new Headers(requests[0].headers).get("Enrollment-Key"), new Headers(requests[1].headers).get("Enrollment-Key"));
  assert.equal(requests[0].body, requests[1].body); assert.equal(saved.getItem(slot), null);
  active = false;
  assert.equal((await enrollDraftOffGuest(options)).activated, false); assert.equal(activations, 1);
});

test("authentication loss clears the private snapshot and stops further old-session requests", async () => {
  let expired = false, reads = 0;
  const fixture = setup(async (url) => {
    reads++;
    return expired ? response({ ok: false, error: { code: "AUTHENTICATION_FAILED" } }, 401)
      : String(url).endsWith('/socket-tickets') ? response({ ok: true, ticket: 'T'.repeat(43), expiresAtMs: 30000 }) : response(snapshot());
  });
  try {
    await fixture.client.start(); assert.ok(fixture.latest()!.snapshot!.view.myDraft);
    expired = true; await fixture.client.resync();
    assert.equal(fixture.latest()!.accessUnavailable, true);
    assert.equal(fixture.latest()!.snapshot, null);
    const before = reads; await fixture.client.resync(); assert.equal(reads, before);
  } finally { fixture.client.stop(); }
});

for (const change of ['removed', 'replaced', 'unreadable'] as const) {
  test(`credential ${change} invalidates private session state before another request`, async () => {
    const saved = storage(), journal = storage(), slot = `draft-off:credential:${code}`;
    saved.setItem(slot, JSON.stringify(credential));
    let requests = 0;
    const fixture = setup(server(async () => response({ ok: true, changed: true, roomRevision: 3 }), () => {
      requests++; return snapshot();
    }), journal, saved);
    try {
      await fixture.client.start();
      if (change === 'removed') saved.removeItem(slot);
      if (change === 'replaced') saved.setItem(slot, JSON.stringify({ ...credential, reconnectCredential: 'D'.repeat(43) }));
      if (change === 'unreadable') saved.getItem = () => { throw new Error('storage unavailable'); };
      const before = requests;
      await fixture.client.resync();
      assert.equal(fixture.latest()!.accessUnavailable, true);
      assert.equal(fixture.latest()!.snapshot, null);
      assert.equal(requests, before);
      await assert.rejects(fixture.client.command({ type: 'SPIN' }), /not ready/);
      assert.equal(journal.rows.size, 0);
    } finally { fixture.client.stop(); }
  });
}

test("cleanup interrupted after journal deletion can recover the confirmed exact command without a reload", async () => {
  const saved = storage(), remove = saved.removeItem, sent: string[] = [];
  let fail = true;
  saved.removeItem = key => { remove(key); if (fail) { fail = false; throw new Error('storage interrupted after deletion'); } };
  const fixture = setup(server(async init => {
    sent.push(init.body as string); return response({ ok: true, changed: true, roomRevision: 3 });
  }, () => snapshot(3)), saved);
  try {
    await fixture.client.start(); await fixture.client.command({ type: 'SPIN' });
    assert.equal(fixture.latest()!.pending, true); assert.equal(saved.rows.size, 0);
    await fixture.client.retry();
    assert.equal(fixture.latest()!.pending, false);
    assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]);
  } finally { fixture.client.stop(); }
});

test("503 and stalled committed bodies preserve the same envelope until a verified receipt and fresh GET", async () => {
  const sent: string[] = []; let cancelled = false;
  const fixture = setup(server(async init => {
    sent.push(init.body as string);
    if (sent.length === 1) return response({ ok: false, error: { code: 'TEMPORARY_UNAVAILABLE' } }, 503);
    if (sent.length === 2) return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    return response({ ok: true, changed: true, roomRevision: 3, view: { privateReceiptSentinel: true } });
  }, () => snapshot(3)), storage(), undefined, 20);
  try {
    await fixture.client.start(); await fixture.client.command({ type: 'SPIN' });
    const journal = [...fixture.journalStorage.rows.values()][0];
    assert.equal(fixture.latest()!.retryAvailable, true);
    await fixture.client.retry();
    assert.equal(cancelled, true); assert.equal([...fixture.journalStorage.rows.values()][0], journal);
    await fixture.client.retry(); assert.equal(fixture.latest()!.pending, false);
    assert.equal(sent.length, 3); assert.ok(sent.every(body => body === sent[0]));
    assert.doesNotMatch(JSON.stringify(fixture.latest()), /privateReceiptSentinel/);
  } finally { fixture.client.stop(); }
});

test("cleanup recovery never deletes a different session's journal", async () => {
  const saved = storage(); let commands = 0;
  const fixture = setup(server(async () => { commands++; return response({ ok: true, changed: true, roomRevision: 3 }); }), saved);
  const replacement = 'newer-session-record';
  saved.removeItem = key => { saved.setItem(key, replacement); throw new Error('another session replaced storage'); };
  try {
    await fixture.client.start(); await fixture.client.command({ type: 'SPIN' });
    await fixture.client.retry();
    assert.equal(commands, 1); assert.deepEqual([...saved.rows.values()], [replacement]);
    assert.equal(fixture.latest()!.pending, true);
  } finally { fixture.client.stop(); }
});
