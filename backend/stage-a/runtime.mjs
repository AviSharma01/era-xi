import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { request as httpRequest } from 'node:http';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

export function fixture(era, count, stage) {
  return JSON.parse(readFileSync(new URL(`.generated/fixtures/${era}-${count}-${stage}.json`, import.meta.url)));
}
export async function startRuntime(statePath) {
  mkdirSync(statePath, { recursive: true });
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'stage-a',
    modules: true, scriptPath: new URL('.generated/worker.js', import.meta.url).pathname,
    compatibilityDate: '2026-10-01',
    bindings: { STAGE_A_ONLY: 'local-workerd-fixtures-only' },
    durableObjects: { ROOMS: { className: 'StageARoom', useSQLite: true } },
    resourcePersistencePath: statePath, host: '127.0.0.1', port: 0,
    telemetry: { enabled: false }, cf: false,
    inspectorPort: 0, log: new Log(LogLevel.ERROR),
  }));
  const url = await mf.ready;
  return { mf, url };
}
export async function request(runtime, room, action, input, participant = 'p0') {
  const url = new URL(`/room/${room}/${action}?participant=${participant}`, runtime.url);
  const body = input === undefined ? undefined : JSON.stringify(input);
  const begin = performance.now();
  const response = await new Promise((resolve,reject)=>{
    const headers = { connection: 'close' };
    if(body!==undefined)Object.assign(headers,{'content-type':'application/json','content-length':Buffer.byteLength(body)});
    const outgoing = httpRequest(url,{method:body===undefined?'GET':'POST',headers,agent:false},incoming=>{
      const chunks=[];
      incoming.on('data',chunk=>chunks.push(chunk));
      incoming.on('error',reject);
      incoming.on('aborted',()=>reject(new Error('Stage A HTTP response aborted')));
      incoming.on('end',()=>resolve({statusCode:incoming.statusCode,headers:incoming.headers,text:Buffer.concat(chunks).toString('utf8')}));
    });
    outgoing.on('error',reject);
    outgoing.setTimeout(180000,()=>outgoing.destroy(new Error('Stage A HTTP socket timeout')));
    outgoing.end(body);
  }).catch(error=>{error.stageASample={clientMs:performance.now()-begin,clientDriver:'node-http-agent-false',room,action,participant};throw error;});
  const text = response.text;
  const clientMs = performance.now() - begin;
  assert.ok(response.statusCode>=200&&response.statusCode<300, `${action}: ${response.statusCode} ${text.slice(0, 500)}`);
  const metrics = JSON.parse(response.headers['x-stage-a-metrics'] ?? '{}');
  return { result: JSON.parse(text), sample: { clientMs, metrics, responseBytes: Buffer.byteLength(text),
    clientDriver:'node-http-agent-false',instanceId: response.headers['x-stage-a-instance'], queueAndTransportEstimateMs: metrics.serviceMs === undefined ? undefined : Math.max(0, clientMs - metrics.serviceMs) } };
}
export async function seed(runtime, room, data, logicalNow = 100, warm = true) {
  await request(runtime, room, 'seed', { fixture: data, logicalNow, warm });
}
export async function evict(runtime, room) {
  await runtime.mf.unsafeEvictDurableObject('stage-a', 'StageARoom', { name: room });
}
export const envelope = (commandId, revision, command) => ({ roomId: 'fixture-room', commandId, expectedDraftRevision: revision, command });
export function legalLock(view) {
  // Use only the participant-safe projection. No extra private reducer/read is
  // performed inside the measured HTTP operation to select a benchmark action.
  assert.equal(view.myDraft.phase, 'AWAITING_PICK');
  for (const candidate of view.myDraft.candidates) {
    for (const slot of candidate.positions) {
      if (slot.available) return { type: 'LOCK_PLAYER', playerTeamSeasonId: candidate.playerTeamSeasonId, battingPosition: slot.battingPosition };
    }
  }
  throw new Error('Inspect the candidate projection contract before using legalLock');
}
export function summary(samples) {
  const sorted = samples.map(s => s.clientMs).sort((a,b) => a-b);
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length*p)-1)];
  return { count: sorted.length, minMs: sorted[0], p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: sorted.at(-1),
    meanRestoreCalls: samples.reduce((sum,s) => sum+(s.metrics.restoreCalls ?? 0),0)/samples.length,
    meanServiceMs: samples.reduce((sum,s) => sum+(s.metrics.serviceMs ?? 0),0)/samples.length,
    maxResponseBytes: Math.max(...samples.map(s => s.responseBytes)) };
}
