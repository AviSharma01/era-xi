import { isDraftOffFormat } from "./draftOffFormat.js";
import { ERA_IDS } from "./teamEvaluationV2.js";
import type { DraftOffInvite } from "./draftOffClientTypes.js";

/** Public invite metadata only; use the shared bounded transport. */
export async function readDraftOffInvite(apiOrigin: string, roomCode: string, transport: typeof fetch, signal?: AbortSignal): Promise<DraftOffInvite> {
  const response = await transport(new URL(`/api/draft-off/v1/rooms/${encodeURIComponent(roomCode)}/invite`, apiOrigin),
    { credentials: "omit", cache: "no-store", signal });
  if (!response.ok) throw new Error("INVITE_UNAVAILABLE");
  const row = await response.json();
  const keys = ["ok", "version", "roomCode", "eraId", "draftMinutes", "format"];
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== keys.length
    || !keys.every(key => Object.hasOwn(row, key)) || row.ok !== true || row.version !== 2 || row.roomCode !== roomCode
    || !ERA_IDS.includes(row.eraId) || ![10, 15].includes(row.draftMinutes) || !isDraftOffFormat(row.format)) throw new Error("INVALID_INVITE");
  return row;
}
