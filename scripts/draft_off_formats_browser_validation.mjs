// Targeted local acceptance against the production Worker and a built frontend.
// DRAFT_OFF_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_BIN=/path/to/chrome node scripts/draft_off_formats_browser_validation.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntime } from '../backend/stage-d/runtime.mjs';
const { chromium } = await import(process.env.DRAFT_OFF_PLAYWRIGHT_MODULE ?? 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.env.DRAFT_OFF_BROWSER_OUTPUT ?? mkdtempSync(join(tmpdir(), 'draft-off-formats-browser-'));
mkdirSync(out, { recursive: true });
const state = mkdtempSync(join(tmpdir(), 'draft-off-formats-browser-state-'));
const frontend = 'http://127.0.0.1:5276';
process.chdir(join(root, 'backend/stage-d'));
const runtime = await startRuntime(state, { production: true, overrides: {
  requestsPerMinute: 50000, enrollmentPerMinute: 50000, readsPerMinute: 5000, readBurst: 1000,
  commandsPerMinute: 5000, commandBurst: 1000, ticketsPerMinute: 1000, ticketBurst: 100,
}, bindings: { ALLOWED_ORIGINS: JSON.stringify([frontend]) } });
let browser, server;
const evidence = { checks: [], pageErrors: 0, unexpectedResponses: [], output: out };
async function call(entry, suffix = '') {
  const response = await fetch(new URL(`/api/draft-off/v1/rooms/${entry.roomCode}${suffix}`, runtime.url), {
    headers: { Origin: frontend, 'CF-Connecting-IP': '198.18.0.61', Authorization: `Bearer ${entry.reconnectCredential}` },
  });
  assert.equal(response.status, 200); return response.json();
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}
try {
  const build = spawnSync(join(root, 'node_modules/.bin/vite'), ['build', '--outDir', join(out, 'web')], {
    cwd: root, env: { ...process.env, VITE_DRAFT_OFF_ENABLED: 'true', VITE_DRAFT_OFF_API_ORIGIN: runtime.url.origin }, encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr);
  server = spawn(join(root, 'node_modules/.bin/vite'), ['preview', '--outDir', join(out, 'web'), '--host', '127.0.0.1', '--port', '5276', '--strictPort'], { cwd: root, stdio: 'ignore' });
  for (let n = 0; n < 80; n++) { try { if ((await fetch(frontend)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true });
  evidence.browser = browser.version();
  for (const [format, eraId] of [['VARIED', 'era-foundation'], ['MIRROR', 'era-impact']]) {
    const label = format === 'VARIED' ? 'Varied Draft' : 'Mirror Draft';
    const contexts = [], players = [];
    let invite;
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ viewport: i ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        ...(i ? { isMobile: true, hasTouch: true } : {}), reducedMotion: 'reduce' });
      contexts.push(context);
      const page = await context.newPage();
      page.on('pageerror', () => evidence.pageErrors++);
      page.on('response', response => { if (response.status() >= 400 && new URL(response.url()).pathname !== '/favicon.ico') evidence.unexpectedResponses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
      await page.goto(i ? invite : frontend + '/draft-off');
      await page.getByLabel('Display name', { exact: true }).fill(`${format} ${i ? 'guest' : 'host'}`);
      if (!i) {
        const selector = page.getByRole('combobox', { name: /^Draft format/ });
        assert.equal(await selector.inputValue(), 'VARIED');
        if (format === 'MIRROR') await selector.selectOption(format);
        await page.getByRole('combobox', { name: /^Era/ }).selectOption(eraId);
        if (format === 'VARIED') await page.getByText(/Opportunities can be unequal/).waitFor();
      } else {
        await page.locator('.room-invite-settings strong').getByText(label, { exact: true }).waitFor();
        await page.getByText(/Settings are fixed/).waitFor();
      }
      await page.screenshot({ path: join(out, `${format}-${i ? 'invite-mobile' : 'create-desktop'}.png`) });
      await page.getByRole('button', { name: i ? 'Join private room' : 'Create private room', exact: true }).click();
      await page.getByRole('heading', { name: 'Same era. Your own XI.' }).waitFor();
      await page.locator('.room-bar-identity').getByText(`${label} · Private lobby`, { exact: true }).waitFor();
      assert.equal(await page.getByRole('combobox', { name: /^Draft format/ }).count(), 0);
      const roomCode = new URL(page.url()).pathname.split('/').at(-1);
      const credential = await page.evaluate(code => JSON.parse(localStorage.getItem('draft-off:credential:' + code)), roomCode);
      const entry = { roomCode, ...credential };
      const snapshot = await call(entry); assert.equal(snapshot.settings.format, format); assert.equal(snapshot.view.round.format, format);
      if (!i) invite = await page.getByLabel('Invite link', { exact: true }).inputValue();
      await page.reload(); await page.getByRole('heading', { name: 'Same era. Your own XI.' }).waitFor();
      await noOverflow(page); players.push({ page, entry });
    }
    await players[0].page.getByRole('button', { name: 'Start 15-minute draft', exact: true }).click();
    // First offers are compared only in Mirror; Varied offers may coincide.
    for (const { page } of players) await page.getByRole('button', { name: 'Spin franchise', exact: true }).click();
    for (const { page } of players) await page.locator('.candidate-card').first().waitFor();
    if (format === 'MIRROR') {
      const first = await Promise.all(players.map(async ({ entry }) => (await call(entry)).view.myDraft.currentSpin.teamSeasonId));
      assert.equal(first[0], first[1]);
    }
    for (const [i, { page }] of players.entries()) {
      await page.getByRole('button', { name: 'Respin · 1 left', exact: true }).click();
      await page.getByText('Respin used', { exact: true }).waitFor();
      for (let pick = 1; pick <= 11; pick++) {
        if (pick > 1) await page.getByRole('button', { name: 'Spin franchise', exact: true }).click();
        await page.locator('.candidate-card').first().waitFor();
        if (pick === 2) { await page.reload(); await page.locator('.candidate-card').first().waitFor(); }
        const choices = page.locator('.candidate-card:not([aria-disabled="true"]):enabled');
        await (i ? choices.last() : choices.first()).click();
        const positions = page.locator('.room-position-option:not(:disabled)');
        await (i ? positions.last() : positions.first()).click();
        await page.getByRole('button', { name: /Confirm pick · Slot/ }).click();
        await page.getByRole('button', { name: pick < 11 ? 'Spin franchise' : 'Submit XI', exact: true }).waitFor();
      }
      await page.getByRole('button', { name: 'Submit XI', exact: true }).click();
      await page.getByRole('button', { name: 'Submit and lock XI', exact: true }).click();
      if (!i) await page.getByRole('heading', { name: 'Your XI is locked in.' }).waitFor();
    }
    const results = [];
    for (const [i, { page, entry }] of players.entries()) {
      await page.locator('.room-revealed-player').first().waitFor();
      await page.locator('.room-bar-identity').getByText(`${label} · Final leaderboard`, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Compare two XIs', exact: true }).click();
      await page.locator('.room-comparison-players > li').first().waitFor();
      assert.equal(await page.locator('.room-comparison-players > li').count(), 11);
      assert.equal(await page.locator('.room-comparison-fixtures > li').count(), 20);
      const result = await call(entry, '/results/' + entry.participantId);
      assert.equal(result.campaign.matches.length, 20); results.push(result);
      await noOverflow(page); await page.screenshot({ path: join(out, `${format}-results-${i ? 'mobile' : 'desktop'}.png`) });
      await page.reload(); await page.locator('.room-revealed-player').first().waitFor();
    }
    const fixtures = rows => rows.map(row => [row.sequence, row.matchId, row.opponent.profileId]);
    assert.deepEqual(fixtures(results[0].campaign.matches), fixtures(results[1].campaign.matches));
    evidence.checks.push({ format, eraId, entrants: 2, creationDefaultVaried: true, selectedFormat: true, inviteMetadata: true,
      immutableLobbySettings: true, lobbyReload: true, completedUiDrafts: 2, respins: 2, activeReload: true,
      submissions: 2, comparisonPositions: 11, sharedFixtures: 20, resultsReload: true, desktopAndMobile: true, noOverflow: true });
    await Promise.all(contexts.map(context => context.close()));
    console.log(JSON.stringify({ format, passed: true }));
  }
  assert.equal(evidence.pageErrors, 0); assert.deepEqual(evidence.unexpectedResponses, []);
  writeFileSync(join(out, 'summary.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
} catch (error) {
  for (const [n, context] of (browser?.contexts() ?? []).entries()) await context.pages()[0]?.screenshot({ path: join(out, `failure-${n}.png`) }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); server?.kill('SIGTERM'); await runtime.mf.dispose(); rmSync(state, { recursive: true, force: true });
}
