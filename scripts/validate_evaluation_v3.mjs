/** Read-only balance/performance comparison. Never regenerates catalog or opponent data. */
import { performance } from 'node:perf_hooks';
import { loadEraDraftCatalog } from '../dist/eraDraftData.js';
import { evaluateCompletedEraXi, ERA_IDS } from '../dist/teamEvaluationV2.js';
import { evaluateCompletedEraXiV3 } from '../dist/teamEvaluationV3.js';
const catalog = loadEraDraftCatalog();
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = n => Math.round(n * 1e6) / 1e6;
const allInputs = [];
const eras = ERA_IDS.map(eraId => {
  const profiles = catalog.getOpponentProfiles(eraId);
  const input = profile => ({ era: catalog.getEra(eraId), players: profile.xi.map(row => {
    const player = catalog.getPlayer(row.playerTeamSeasonId);
    return { position: row.position, role: player.role, quality: player.quality, rosterStatus: player.rosterStatus };
  }) });
  const baselines = profiles.map(profile => {
    const xi = input(profile); allInputs.push(xi);
    return { profile, xi, v2: evaluateCompletedEraXi(xi), v3: evaluateCompletedEraXiV3(xi) };
  });
  const elite = baselines.flatMap(row => row.xi.players.filter(p => p.position <= 2 && p.role.battingFit.slots[p.position - 1].classification === 'NATURAL')
    .map(player => ({ ...row, player }))).sort((a, b) => b.player.quality.batting.battingRating - a.player.quality.batting.battingRating)[0];
  const compare = xi => {
    const v2 = evaluateCompletedEraXi(xi), v3 = evaluateCompletedEraXiV3(xi);
    return { battingV2: round(v2.adjustedStrength.batting), battingV3: round(v3.adjustedStrength.batting),
      overallV2: round(v2.adjustedStrength.overall), overallV3: round(v3.adjustedStrength.overall),
      fitDeductionV3: round(v3.diagnostics.appliedPositionFitDeduction),
      eliteContributionV3: round(v3.battingContributions.find(p => p.playerId === elite.player.quality.playerId).effectiveContribution) };
  };
  const swaps = Object.fromEntries([4, 8, 9, 10, 11].map(position => [position, compare({ ...elite.xi,
    players: elite.xi.players.map(p => ({ ...p, position: p.position === elite.player.position ? position : p.position === position ? elite.player.position : p.position })) })]));
  return { eraId, representativeCount: baselines.length,
    meanOverallChange: round(average(baselines.map(row => row.v3.adjustedStrength.overall - row.v2.adjustedStrength.overall))),
    representative: elite.profile.candidateId, elitePlayer: elite.player.quality.playerTeamSeasonId,
    swaps, reversed: compare({ ...elite.xi, players: elite.xi.players.map(p => ({ ...p, position: 12 - p.position })) }) };
});
function timing(evaluate) {
  for (let i = 0; i < 1000; i++) evaluate(allInputs[i % allInputs.length]);
  const samples = [];
  for (let i = 0; i < 10000; i++) { const start = performance.now(); evaluate(allInputs[i % allInputs.length]); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  return { calls: samples.length, meanMs: round(average(samples)), p95Ms: round(samples[Math.ceil(samples.length * .95) - 1]), maxMs: round(samples.at(-1)) };
}
console.log(JSON.stringify({ catalogFingerprint: catalog.fingerprint, eras,
  timing: { mode: 'OBSERVE', v2: timing(evaluateCompletedEraXi), v3: timing(evaluateCompletedEraXiV3),
    limitation: 'Local microbenchmark only. Stage E controlled workerd budgets remain the performance gate.' } }, null, 2));
