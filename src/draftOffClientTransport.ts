/** Shared request bounds/cooldown for enrollment, commands and the unchanged M4 realtime helper. */
export function draftOffApiOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Invalid Draft-Off API origin.");
  }
  return url.origin;
}

export function createDraftOffTransport(options: {
  fetch?: typeof fetch; now?: () => number; timeoutMs?: number; maxBytes?: number;
} = {}) {
  const send = options.fetch ?? fetch, now = options.now ?? Date.now;
  let until = 0, stopped = false;
  const active = new Set<AbortController>();
  const cooldownListeners = new Set<() => void>();
  const transport: typeof fetch = async (input, init) => {
    if (stopped) throw new Error("TRANSPORT_STOPPED");
    if (now() < until) throw new Error("HTTP_COOLDOWN");
    const controller = new AbortController(); active.add(controller);
    const cancel = () => controller.abort();
    const parent = init?.signal;
    parent?.addEventListener("abort", cancel, { once: true });
    if (parent?.aborted) cancel();
    const timer = setTimeout(cancel, options.timeoutMs ?? 10_000);
    let interrupted!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      interrupted = () => reject(new Error("HTTP_REQUEST_ABORTED"));
      controller.signal.addEventListener("abort", interrupted, { once: true });
      if (controller.signal.aborted) interrupted();
    });
    const operation = (async () => {
      const response = await send(input, { ...init, credentials: "omit", cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error("HTTP_REQUEST_ABORTED"); }
      if (response.status === 429) {
        const header = response.headers.get("Retry-After"), time = now();
        const target = header && /^\d+$/.test(header.trim()) ? time + Number(header) * 1000 : Date.parse(header ?? "");
        const next = Math.max(until, Number.isSafeInteger(target) ? Math.max(time, target) : time + 60_000);
        if (next !== until) {
          until = next;
          // Read-only observers cannot change request/cooldown semantics or fail a fetch.
          for (const listener of cooldownListeners) { try { listener(); } catch { /* Presentation only. */ } }
        }
      }
      const max = options.maxBytes ?? 2_097_152, declared = response.headers.get("Content-Length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) {
        void response.body?.cancel().catch(() => {}); throw new Error("INVALID_HTTP_RESPONSE_SIZE");
      }
      if (!response.body) throw new Error("INVALID_HTTP_RESPONSE");
      const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
      const cancelBody = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", cancelBody, { once: true });
      try {
        for (;;) {
          controller.signal.throwIfAborted();
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > max) { void reader.cancel().catch(() => {}); throw new Error("HTTP_RESPONSE_TOO_LARGE"); }
          parts.push(chunk.value);
        }
        controller.signal.throwIfAborted();
      } finally { controller.signal.removeEventListener("abort", cancelBody); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      return new Response(bytes, { status: response.status, headers: response.headers });
    })();
    try { return await Promise.race([operation, aborted]); }
    finally { clearTimeout(timer); active.delete(controller); parent?.removeEventListener("abort", cancel); controller.signal.removeEventListener("abort", interrupted); }
  };
  return { fetch: transport, cooldownUntil: () => until,
    subscribeCooldown(listener: () => void) { cooldownListeners.add(listener); return () => { cooldownListeners.delete(listener); }; },
    stop() { stopped = true; cooldownListeners.clear(); active.forEach(controller => controller.abort()); active.clear(); } };
}
