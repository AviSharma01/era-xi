// Local M5.5/M5.6 browser acceptance; extends the existing walkthrough. Uses the production Worker and built frontend.
// Provide a locally installed Playwright module and Chrome binary; no dependency download.
// DRAFT_OFF_PLAYWRIGHT_MODULE=/absolute/path/playwright/index.mjs CHROME_BIN=/path/to/chrome node scripts/draft_off_m55_browser_validation.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRuntime } from '../backend/stage-d/runtime.mjs';
const { chromium } = await import(process.env.DRAFT_OFF_PLAYWRIGHT_MODULE ?? 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const eraId = process.env.DRAFT_OFF_BROWSER_ERA ?? 'era-transition';
const minutes = Number(process.env.DRAFT_OFF_BROWSER_MINUTES ?? 10);
assert.ok([10,15].includes(minutes));
const frontend = 'http://127.0.0.1:5275';
const out = process.env.DRAFT_OFF_BROWSER_OUTPUT ?? mkdtempSync(join(tmpdir(), 'draft-off-m55-browser-'));
mkdirSync(out, { recursive: true });
const statePath = mkdtempSync(join(tmpdir(), 'draft-off-m55-state-'));
process.chdir(join(root, 'backend/stage-d'));
// Permissive budgets only for accelerated local automation; product defaults unchanged.
const runtime = await startRuntime(statePath, { production: true,
  overrides: { requestsPerMinute:50000,enrollmentPerMinute:50000,readBurst:1000,readsPerMinute:5000,commandsPerMinute:5000,commandBurst:1000,ticketsPerMinute:1000,ticketBurst:100 },
  bindings: { ALLOWED_ORIGINS: JSON.stringify([frontend]) } });
let server, browser;
const evidence = { checks: [], output: out, viewports: ['1440×1000 desktop','390×844 touch','320×640 narrow touch','720×500 desktop reflow'], reducedMotion: true, eraId, minutes };
async function call(path, { method='GET', body, token, enroll }={}) {
  const reply = await fetch(new URL('/api/draft-off/v1'+path,runtime.url), { method, headers: { Origin:frontend,'CF-Connecting-IP':'198.18.50.55',
    ...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(enroll?{'Enrollment-Key':enroll}:{}) },...(body?{body:JSON.stringify(body)}:{}) });
  assert.ok(reply.status<300,'HTTP '+reply.status); return reply.json();
}
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function shot(page, name, selector) {
  if(selector) await page.locator(selector).evaluate(el => el.scrollIntoView({block:'start'}));
  await frame(page); await page.screenshot({path:join(out,name+'.png')});
}
async function noOverflow(page) {
  const bounds = await page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(bounds.scroll<=bounds.width,JSON.stringify(bounds));
}
async function checkPlacement(page, width, pending=false) {
  await page.setViewportSize({width,height:width===320?640:844});await frame(page);
  const body=page.locator('.room-placement-body'), footer=page.locator('.room-sheet-confirm');
  const selected=await body.locator('.selected-player-copy h3').textContent();
  assert.equal(await footer.locator('.room-placement-context strong').textContent(),selected);
  for(let i=0;i<11;i++) {
    const row=body.locator('.room-xi li').nth(i);await row.scrollIntoViewIfNeeded();await frame(page);
    const box=await row.boundingBox(), bounds=await body.boundingBox(), end=await footer.boundingBox();
    assert.ok(box&&bounds&&end);
    assert.ok(box.y>=bounds.y-1&&box.y+box.height<=bounds.y+bounds.height+1,`Position ${i+1} obstructed at ${width}px`);
    assert.ok(box.y+box.height<=end.y+1,`Position ${i+1} behind footer`);
    assert.equal(await row.evaluate(el=>document.elementFromPoint(el.getBoundingClientRect().x+el.getBoundingClientRect().width/2,el.getBoundingClientRect().y+el.getBoundingClientRect().height/2)?.closest('li')===el),true);
  }
  const end=await footer.boundingBox();assert.ok(end.y>=0&&end.y+end.height<=(width===320?640:844)+1);
  if(pending) assert.equal(await footer.locator('button').textContent(),'Waiting for server…');
  await noOverflow(page);await shot(page,`placement-${width}${pending?'-pending':''}`);
}
const authoritativeResults=new Map();
async function checkComparisonIdentity(page, entry) {
  const ids=await page.locator('.room-comparison-selectors select').evaluateAll(nodes=>nodes.map(node=>node.value));
  for(const [side,id] of ids.entries()) {
    if(!authoritativeResults.has(id)) authoritativeResults.set(id,await call('/rooms/'+entry.roomCode+'/results/'+id,{token:entry.reconnectCredential}));
    const result=authoritativeResults.get(id), label=`${side===0?'A':'B'} · ${result.displayName}`;
    for(const section of ['comparison-players','comparison-teams','comparison-campaign']) {
      const labels=await page.locator(`#${section} .room-comparison-row`).evaluateAll((rows,side)=>rows.map(row=>row.querySelectorAll('.room-comparison-label')[side].textContent),side);
      assert.ok(labels.every(value=>value===label));
    }
    for(const [n,p] of result.players.entries()) assert.equal(await page.locator('.room-comparison-players > li').nth(n).locator('.room-comparison-player').nth(side).locator('strong').textContent(),p.playerName);
    assert.equal(await page.locator('#comparison-teams .room-comparison-row').first().locator('.room-comparison-value > strong').nth(side).textContent(),result.evaluation.strength.overall.toFixed(1));
    assert.equal(await page.locator('#comparison-campaign .room-comparison-row').nth(2).locator('.room-comparison-value > strong').nth(side).textContent(),String(result.campaign.aggregate.won));
    assert.equal(await page.locator('.room-fixture-legend p').nth(side).textContent(),label);
    for(const [n,m] of result.campaign.matches.entries()) {
      const row=page.locator('.room-comparison-fixtures > li').nth(n);
      assert.equal(await row.locator('.room-fixture-outcome').nth(side).getAttribute('aria-label'),`${label}: ${m.outcome}${m.resultType==='super_over'?', Super Over':''}`);
      assert.equal(await row.locator('.room-comparison-match-pair > div > .room-comparison-label').nth(side).textContent(),label);
      assert.equal(await row.locator('.match-outcome').nth(side).textContent(),m.outcome);
    }
  }
}

process.once('SIGTERM',async()=>{ await browser?.close();server?.kill('SIGTERM');await runtime.mf.dispose();rmSync(statePath,{recursive:true,force:true});process.exit(1); });
try {
  const build = spawnSync(join(root,'node_modules/.bin/vite'), ['build','--outDir',join(out,'web')], {cwd:root,env:{...process.env,VITE_DRAFT_OFF_ENABLED:'true',VITE_DRAFT_OFF_API_ORIGIN:runtime.url.origin},stdio:'pipe'});
  assert.equal(build.status,0,build.stderr?.toString());
  server = spawn(join(root,'node_modules/.bin/vite'),['preview','--outDir',join(out,'web'),'--host','127.0.0.1','--port','5275','--strictPort'],{cwd:root,stdio:'ignore'});
  for(let n=0;n<80;n++){try{if((await fetch(frontend)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal((await fetch(new URL('/__test/anything/inspect',runtime.url))).status,404);
  browser = await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true});
  evidence.browser=browser.version();
  const guests=[], entries=[];
  let invite;
  for(let i=0;i<2;i++) {
    const context=await browser.newContext({viewport:i===0?{width:1440,height:1000}:{width:390,height:844},...(i===1?{isMobile:true,hasTouch:true}:{}),reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
    const page=await context.newPage(),errors=[],targets=[],failed=[],observations=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',msg=>{
      if(msg.type()!=='error')return;
      const item={message:msg.text(),url:msg.location().url};
      // Existing optional icon is absent. Record this cosmetic design-pass item;
      // every other console error and every failed application request still fails.
      if(item.url===frontend+'/favicon.ico'&&item.message==='Failed to load resource: the server responded with a status of 404 (Not Found)') observations.push('Optional favicon.ico returned 404');
      else errors.push(item);
    });
    page.on('response',response=>{if(response.status()>=400)failed.push({path:new URL(response.url()).pathname,status:response.status()});});
    page.on('requestfailed',request=>{if(request.failure()?.errorText!=='net::ERR_ABORTED')failed.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText});});
    page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.includes('/results/'))targets.push(path.split('/').at(-1));});
    console.log(JSON.stringify({enrollment:i,step:'open'}));
    await page.goto(i===0?frontend+'/draft-off':invite);
    await page.getByLabel('Display name',{exact:true}).fill(i===0?'Desktop entrant':'Mobile entrant with a long display name');
    if(i===0) {
      await page.getByRole('combobox',{name:/^Era/}).selectOption(eraId);
      await page.getByRole('combobox',{name:/^Draft time/}).selectOption(String(minutes));
    }
    await page.getByRole('button',{name:i===0?'Create private room':'Join private room',exact:true}).click();
    await page.getByRole('heading',{name:'Same era. Your own XI.'}).waitFor();
    console.log(JSON.stringify({enrollment:i,step:'lobby'}));
    const code=new URL(page.url()).pathname.split('/').at(-1);
    const credential=await page.evaluate(code=>JSON.parse(localStorage.getItem('draft-off:credential:'+code)),code);
    const entry={roomCode:code,...credential};entries.push(entry);
    assert.equal(await page.getByRole('combobox',{name:/^Era/}).count(),0);
    if(i===0) {
      invite=await page.getByLabel('Invite link',{exact:true}).inputValue();
      assert.equal(invite,frontend+'/draft-off/rooms/'+code);
      await page.getByRole('button',{name:'Copy invite link',exact:true}).click();
      await page.getByText('Invite link copied.',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>Promise.race([navigator.clipboard.readText(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Clipboard read timed out')),3000))])),invite);
      assert.equal(await page.getByRole('button',{name:`Start ${minutes}-minute draft`}).isDisabled(),true);
    } else {
      assert.equal(await page.getByRole('button',{name:/Start .*minute draft/}).count(),0);
      await page.getByRole('button',{name:'Leave lobby',exact:true}).click();
      await page.getByRole('button',{name:'Rejoin lobby',exact:true}).click();
      await page.getByRole('button',{name:'Leave lobby',exact:true}).waitFor();
    }
    await page.reload();await page.getByRole('heading',{name:'Same era. Your own XI.'}).waitFor();
    assert.deepEqual(await page.evaluate(code=>JSON.parse(localStorage.getItem('draft-off:credential:'+code)),code),credential);
    guests.push({page,context,entry,errors,targets,failed,observations});
  }
  await guests[0].page.getByRole('button',{name:`Start ${minutes}-minute draft`}).click();
  evidence.checks.push({uiCreateJoin:true,codeOnlyInvite:true,clipboard:true,fixedSettings:true,hostOnlyStart:true,leaveRejoin:true,lobbyReload:true});
  for(const [i,{page}] of guests.entries()) {
    let releaseLock;
    const heldLock=new Promise(resolve=>{releaseLock=resolve;});
    let hold=true;
    await page.route('**/commands',async route=>{
      if(hold&&route.request().postDataJSON()?.command?.type==='LOCK_PLAYER') {
        hold=false;const response=await route.fetch();await heldLock;await route.fulfill({response});
      } else await route.continue();
    });
    for(let pick=1;pick<=11;pick++) {
      await page.getByRole('button',{name:'Spin franchise',exact:true}).click();
      if(pick===1) {
        await page.getByRole('button',{name:'Respin · 1 left',exact:true}).click();
        await page.getByText('Respin used',{exact:true}).waitFor();
      }
      if(pick===2) { await page.reload(); await page.locator('.candidate-card').first().waitFor(); }
      const choices=page.locator('.candidate-card:not([aria-disabled="true"]):enabled');
      const candidate=i===0?choices.first():choices.last();
      await candidate.waitFor(); await frame(page); await candidate.focus(); await page.keyboard.press('Enter');
      await page.locator('.room-position-option:not(:disabled)').first().waitFor();
      if(pick===1) {
        await shot(page,i===0?'desktop-placement':'mobile-placement'); await noOverflow(page);
        if(i===1) {
          await page.getByRole('button',{name:'Inspect season',exact:true}).click();
          await page.locator('.player-inspector[open] [role="timer"]').waitFor();
          await shot(page,'mobile-candidate-inspection');
          await page.keyboard.press('Tab');assert.equal(await page.locator('.player-inspector button').evaluate(el=>el===document.activeElement),true);
          await page.keyboard.press('Escape'); await page.locator('.player-inspector').waitFor({state:'detached'});
          await frame(page);assert.equal(await page.getByRole('button',{name:'Inspect season',exact:true}).evaluate(el=>el===document.activeElement),true);
        }
      }
      if(i===1&&pick===1) {for(const width of [390,320])await checkPlacement(page,width);await page.setViewportSize({width:390,height:844});}
      const positions=page.locator('.room-position-option:not(:disabled)');
      await (i===0?positions.first():positions.last()).click();
      if(i===1&&pick===1) await shot(page,'mobile-placement-scrolled');
      await page.getByRole('button',{name:/Confirm pick · Slot/}).click();
      if(pick===1) {
        const pending=page.locator(i===1?'.room-placement-sheet [role="status"]':'.draft-off-recovery');
        await pending.waitFor();assert.match(await pending.textContent(),/Waiting for server confirmation|Confirming your pick/);
        assert.equal(await page.locator('.room-confirm-pick').textContent(),'Waiting for server…');
        await shot(page,i===0?'desktop-pending':'mobile-pending');
        if(i===1) {for(const width of [390,320])await checkPlacement(page,width,true);await page.setViewportSize({width:390,height:844});}
        releaseLock();
      }
      if(pick<11) await page.getByRole('button',{name:'Spin franchise',exact:true}).waitFor({state:'visible'});
      else await page.getByRole('button',{name:'Submit XI',exact:true}).waitFor();
      console.log(JSON.stringify({draft:i,pick}));
    }
    if(i===1) {
      await page.getByRole('button',{name:'Your XI · 11/11'}).click();
      await page.locator('.room-dialog[open] [role="timer"]').waitFor();
      await page.locator('.room-dialog .room-locked-player').last().focus();await page.keyboard.press('Enter');
      await page.locator('.player-inspector[open] [role="timer"]').waitFor();
      await shot(page,'mobile-locked-inspection');await page.keyboard.press('Escape');await page.locator('.player-inspector').waitFor({state:'detached'});
      await page.keyboard.press('Escape');await page.locator('.room-dialog').waitFor({state:'detached'});
    }
    await page.getByRole('button',{name:'Submit XI',exact:true}).click();
    await page.locator('.room-dialog[open] [role="timer"]').waitFor();await shot(page,i===0?'desktop-submit':'mobile-submit');
    await page.getByRole('button',{name:'Submit and lock XI',exact:true}).click();
    if(i===0) {
      await page.getByRole('heading',{name:'Your XI is locked in.'}).waitFor();
      await page.locator('.room-locked-player').first().click();
      await page.locator('.player-inspector[open] [role="timer"]').waitFor();await shot(page,'desktop-waiting-inspection');await page.keyboard.press('Escape');
    }
    evidence.checks.push({gameplay:i===0?'desktop':'mobile',uiPicks:11,respin:true,activeDraftReload:true,keyboardSelection:true,modalClock:true,pendingFeedback:true,submission:true});
  }
  const submissions=await Promise.all(entries.map(async entry=>(await call('/rooms/'+entry.roomCode+'/results/'+entry.participantId,{token:entry.reconnectCredential})).players.map(p=>[p.battingPosition,p.playerTeamSeasonId])));
  assert.notDeepEqual(submissions[0],submissions[1]);evidence.distinctSubmittedXIs=true;
  for(const [i,guest] of guests.entries()) {
    const {page,entry,targets}=guest,name=i===0?'desktop':'mobile';
    await page.locator('.room-revealed-player').first().waitFor();
    assert.equal(targets.length,1);assert.equal(targets[0],entry.participantId);
    await page.getByRole('button',{name:'Compare two XIs',exact:true}).click();
    await page.locator('.room-comparison-players > li').first().waitFor();
    assert.equal(targets.length,2);
    assert.equal(await page.locator('.room-comparison-players > li').count(),11);
    assert.equal(await page.locator('.room-comparison-fixtures > li').count(),20);
    assert.equal(await page.locator('.room-comparison-fixtures .match-result').count(),40);
    await noOverflow(page);
    await checkComparisonIdentity(page,entry);
    // Match the rendered pairs with real, authenticated production results and exact server ranks.
    const ids=await page.locator('.room-comparison-selectors select').evaluateAll(nodes=>nodes.map(node=>node.value));
    const current=await call('/rooms/'+entry.roomCode,{token:entry.reconnectCredential});
    for(const [side,id] of ids.entries()) {
      const result=await call('/rooms/'+entry.roomCode+'/results/'+id,{token:entry.reconnectCredential});
      for(const [n,p] of result.players.entries()) assert.equal(await page.locator('.room-comparison-players > li').nth(n).locator('.room-comparison-player').nth(side).locator('strong').textContent(),p.playerName);
      for(const [n,m] of result.campaign.matches.entries()) assert.equal(await page.locator('.room-comparison-fixtures > li').nth(n).locator('.match-outcome').nth(side).textContent(),m.outcome);
      const rank=current.view.resolution.leaderboard.find(row=>row.participantId===id).rank;
      assert.match(await page.locator('#comparison-campaign .room-comparison-row').first().locator('.room-comparison-value').nth(side).textContent(),new RegExp('Rank '+rank));
    }
    await shot(page,name+'-comparison-campaign','#xi-comparison');
    await shot(page,name+'-comparison-assessment','#comparison-teams');
    await shot(page,name+'-comparison-order','#comparison-players');
    await page.getByRole('link',{name:'Change XIs ↑',exact:true}).click();await frame(page);
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'comparison-selection');
    await shot(page,name+'-comparison-selection');
    const inspector=page.locator('.room-comparison-player button').first();await inspector.click();await page.locator('.player-inspector[open]').waitFor();
    await page.keyboard.press('Shift+Tab');assert.equal(await page.locator('.player-inspector button').evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Escape');await page.locator('.player-inspector').waitFor({state:'detached'});await frame(page);assert.equal(await inspector.evaluate(el=>el===document.activeElement),true);
    await shot(page,name+'-comparison-fixtures','#comparison-fixtures');
    if(i===1) {
      for(const width of [390,320]) {
        await page.setViewportSize({width,height:width===320?640:844});await noOverflow(page);
        assert.equal(await page.locator('.room-comparison-fixture[open]').count(),0);
        assert.equal(await page.locator('.room-comparison-fixtures .match-result:visible').count(),0);
        await shot(page,`fixtures-${width}-overview`,'#comparison-fixtures');
        const summary=page.locator('.room-comparison-fixture > summary').first();await summary.focus();await page.keyboard.press('Enter');
        assert.equal(await page.locator('.room-comparison-fixture[open]').count(),1);
        assert.equal(await page.locator('.room-comparison-fixtures .match-result:visible').count(),2);
        await noOverflow(page);await shot(page,`fixtures-${width}-expanded`,'#comparison-fixtures');
        await summary.focus();await page.keyboard.press('Space');assert.equal(await page.locator('.room-comparison-fixture[open]').count(),0);
      }
      await page.setViewportSize({width:390,height:844});
    }
    await page.getByRole('button',{name:'Swap XIs'}).click();await page.locator('.room-comparison-players > li').first().waitFor();assert.equal(targets.length,2);
    await checkComparisonIdentity(page,entry);
    await page.getByRole('button',{name:'Individual results',exact:true}).click();await page.locator('.room-revealed-player').first().waitFor();
    await page.getByRole('button',{name:'Compare two XIs',exact:true}).click();await page.locator('.room-comparison-players > li').first().waitFor();assert.equal(targets.length,2);
    if(i===1) {
      await page.setViewportSize({width:320,height:640});await noOverflow(page);await shot(page,'narrow-comparison-order','#comparison-players');
      await page.getByRole('button',{name:'Individual results',exact:true}).click();await page.locator('.room-revealed-player').first().waitFor();await noOverflow(page);await shot(page,'narrow-individual-results','#participant-results');
    } else {
      await page.setViewportSize({width:720,height:500});await noOverflow(page);await shot(page,'desktop-reflow-comparison','#comparison-teams');
    }
    await page.reload();await page.locator('.room-revealed-player').first().waitFor();assert.equal(targets.length,3);
    // A real storage event from a second tab invalidates both private results and cached access.
    await page.getByRole('button',{name:'Compare two XIs',exact:true}).click();await page.locator('.room-comparison-players > li').first().waitFor();
    const storageTab=await guest.context.newPage();await storageTab.goto(frontend);
    await storageTab.evaluate(code=>localStorage.removeItem('draft-off:credential:'+code),entry.roomCode);
    await page.getByRole('heading',{name:'Room access unavailable',exact:true}).waitFor();assert.equal(await page.locator('#xi-comparison').count(),0);await storageTab.close();
    const meta=await page.locator('meta[name="viewport"]').getAttribute('content');
    assert.doesNotMatch(meta??'',/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(?:\D|$)/i);
    assert.deepEqual(guest.failed,[]);assert.deepEqual(guest.errors,[]);
    evidence.checks.push({context:name,consoleErrors:0,unexpectedFailedRequests:0,observations:guest.observations});
    evidence.checks.push({results:name,pairedPositions:11,pairedFixtures:20,serverAlignment:true,identityAfterSwap:true,fixtureDisclosures:true,cacheReuse:true,reload:true,storageEventInvalidation:true,noHorizontalOverflow:true});
  }
  // Existing V1 route remains independently loadable in the same built frontend.
  const solo=await browser.newPage({viewport:{width:1440,height:1000}});await solo.goto(frontend+'/era-draft');await solo.getByRole('heading',{name:'Choose your chapter.'}).waitFor({timeout:10000});
  evidence.checks.push({soloRoute:true});
  writeFileSync(join(out,'summary.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
} catch(error) {
  for(const [n,context] of (browser?.contexts()??[]).entries()) { const page=context.pages()[0];if(page) await page.screenshot({path:join(out,`failure-${n}.png`)}).catch(()=>{}); }
  throw error;
} finally {
  await browser?.close();server?.kill('SIGTERM');await runtime.mf.dispose();rmSync(statePath,{recursive:true,force:true});
}
