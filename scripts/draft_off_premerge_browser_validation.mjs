// Local production-build regression checks. No deployment, downloads or infrastructure.
// Use the existing installed Playwright module / Chrome via the same variables as the M5.6 walkthrough.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntime } from '../backend/stage-d/runtime.mjs';
const { chromium } = await import(process.env.DRAFT_OFF_PLAYWRIGHT_MODULE ?? 'playwright');
const root=fileURLToPath(new URL('../',import.meta.url)),frontend='http://127.0.0.1:5286';
const out=process.env.DRAFT_OFF_BROWSER_OUTPUT??mkdtempSync(join(tmpdir(),'draft-off-premerge-browser-'));
mkdirSync(out,{recursive:true});
const state=mkdtempSync(join(tmpdir(),'draft-off-premerge-state-'));
process.chdir(join(root,'backend/stage-d'));
const runtime=await startRuntime(state,{production:true,bindings:{ALLOWED_ORIGINS:JSON.stringify([frontend])}});
let browser,server;
const evidence={checks:[],browser:null,consolePageErrors:0};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const frame=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function stopServer(){if(!server)return;const current=server;server=undefined;if(current.exitCode!==null)return;await new Promise(resolve=>{current.once('exit',resolve);current.kill('SIGTERM');});}
async function buildAndServe(base,enabled){
  await stopServer();const dir=join(out,`${base==='/'?'root':'nested'}-${enabled?'enabled':'disabled'}`);
  const env={...process.env,VITE_DRAFT_OFF_API_ORIGIN:runtime.url.origin};delete env.VITE_DRAFT_OFF_ENABLED;
  if(enabled)env.VITE_DRAFT_OFF_ENABLED='true';
  const build=spawnSync(join(root,'node_modules/.bin/vite'),['build','--base',base,'--outDir',dir],{cwd:root,env,stdio:'pipe'});
  assert.equal(build.status,0,build.stderr?.toString());
  server=spawn(join(root,'node_modules/.bin/vite'),['preview','--base',base,'--outDir',dir,'--host','127.0.0.1','--port','5286','--strictPort'],{cwd:root,stdio:'ignore'});
  for(let i=0;i<80;i++){try{if((await fetch(frontend+base)).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error('Production preview did not start.');
}
async function newContext(){const context=await browser.newContext();context.on('page',page=>page.on('pageerror',()=>{evidence.consolePageErrors++;}));return context;}
const readIdentity=(page,code)=>page.evaluate(code=>JSON.parse(localStorage.getItem('draft-off:credential:'+code)),code);
async function enrollmentTabs(base,concurrent){
  const hostContext=await newContext(),host=await hostContext.newPage();await host.goto(frontend+base+'draft-off');
  await host.getByLabel('Display name',{exact:true}).fill(concurrent?'Concurrent host':'Sequential host');
  await host.getByRole('button',{name:'Create private room',exact:true}).click();await host.getByRole('heading',{name:'Same era. Your own XI.'}).waitFor();
  const invite=await host.getByLabel('Invite link',{exact:true}).inputValue(),code=new URL(invite).pathname.split('/').at(-1);
  const guestContext=await newContext(),a=await guestContext.newPage(),b=await guestContext.newPage();
  await Promise.all([a.goto(invite),b.goto(invite)]);
  await a.getByLabel('Display name',{exact:true}).fill('First guest');await b.getByLabel('Display name',{exact:true}).fill('Stale guest');
  let joins=0;const committed=deferred(),release=deferred();
  await guestContext.route('**/join',async route=>{joins++;const reply=await route.fetch();committed.resolve();if(concurrent)await release.promise;await route.fulfill({response:reply});});
  if(concurrent){
    await Promise.all([a.getByRole('button',{name:'Join private room',exact:true}).click(),b.getByRole('button',{name:'Join private room',exact:true}).click()]);
    await committed.promise;
    await b.waitForFunction(async()=>{const state=await navigator.locks.query();return state.pending.length===1;});
    assert.equal(joins,1);release.resolve();
  }else await a.getByRole('button',{name:'Join private room',exact:true}).click();
  await Promise.all([a.getByRole('heading',{name:'Same era. Your own XI.'}).waitFor(),b.getByRole('heading',{name:'Same era. Your own XI.'}).waitFor()]);
  const identity=await readIdentity(a,code);assert.deepEqual(await readIdentity(b,code),identity);assert.equal(joins,1);
  assert.equal(await b.evaluate(code=>localStorage.getItem('draft-off:pending:JOIN:'+code),code),null);
  await b.reload();await b.getByRole('heading',{name:'Same era. Your own XI.'}).waitFor();assert.deepEqual(await readIdentity(b,code),identity);
  const reply=await fetch(new URL(`/api/draft-off/v1/rooms/${code}`,runtime.url),{headers:{Origin:frontend,'CF-Connecting-IP':'198.18.0.99',Authorization:'Bearer '+identity.reconnectCredential}});
  assert.equal(reply.status,200);const body=await reply.json();assert.equal(body.view.participants.length,2);assert.equal(body.participantId,identity.participantId);
  await b.screenshot({path:join(out,concurrent?'concurrent-tabs.png':'stale-tabs.png')});
  evidence.checks.push({base,preOpenedTabs:true,concurrent,joinRequests:joins,oneGuestIdentity:true,reload:true,rosterSize:2});
  await guestContext.close();await hostContext.close();
}
async function soloRecovery(base){
  const context=await newContext(),page=await context.newPage();await page.goto(frontend+base);await page.locator('.era-card').first().waitFor();
  let held=deferred(),seen=deferred();
  const intercept=async route=>{const reply=await route.fetch();seen.resolve();await held.promise;await route.fulfill({response:reply});};
  await page.route('**/eras/*.json',intercept);
  await page.locator('.era-card').first().click();await page.locator('.start-draft-action').click();await seen.promise;
  await page.locator(`a[href="${base}draft-off"]`).click();await page.locator('.draft-off-shell').waitFor();
  await page.goBack();await page.locator('.era-picker').waitFor();held.resolve();
  await page.unrouteAll({behavior:'wait'});await page.waitForTimeout(200);await frame(page);
  assert.equal(new URL(page.url()).pathname,base);assert.equal(await page.evaluate(()=>localStorage.getItem('era-draft-ui-save/v1')),null);
  // New Start remains usable after canceling the obsolete generation.
  await page.locator('.era-card').first().click();await page.locator('.start-draft-action').click();await page.getByRole('button',{name:/^Spin franchise/}).waitFor();
  await page.getByRole('button',{name:/^Spin franchise/}).click();await page.locator('.candidate-card').first().waitFor();
  const save=await page.evaluate(()=>localStorage.getItem('era-draft-ui-save/v1'));assert.ok(save);
  await page.getByRole('button',{name:'Exit draft',exact:true}).click();await page.locator(`a[href="${base}draft-off"]`).click();await page.locator('.draft-off-shell').waitFor();
  await page.getByRole('link',{name:'Solo Era Draft',exact:true}).click();await page.reload();await page.locator('.landing-continue').waitFor();
  held=deferred();seen=deferred();await page.route('**/eras/*.json',intercept);
  await page.locator('.landing-continue').click();await seen.promise;
  await page.locator(`a[href="${base}draft-off"]`).click();await page.locator('.draft-off-shell').waitFor();held.resolve();
  await page.unrouteAll({behavior:'wait'});await page.waitForTimeout(200);await frame(page);
  assert.equal(new URL(page.url()).pathname,base+'draft-off');assert.equal(await page.evaluate(()=>localStorage.getItem('era-draft-ui-save/v1')),save);
  await page.getByRole('link',{name:'Solo Era Draft',exact:true}).click();await page.locator('.landing-continue').click();await page.locator('.candidate-card').first().waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('era-draft-ui-save/v1')),save);
  await page.screenshot({path:join(out,base==='/'?'solo-root-continue.png':'solo-nested-continue.png')});
  evidence.checks.push({base,delayedStartCanceled:true,awayAndBack:true,delayedContinueCanceled:true,originalSavePreserved:true,normalStartSpinContinue:true});await context.close();
}
try{
  browser=await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true});evidence.browser=browser.version();
  for(const base of ['/','/games/'])for(const enabled of [false,true]){
    await buildAndServe(base,enabled);const context=await newContext(),page=await context.newPage();let requests=0;
    page.on('request',request=>{if(request.url().startsWith(runtime.url.origin))requests++;});
    await page.goto(frontend+base);await page.locator('.era-picker').waitFor();assert.equal(await page.locator(`a[href="${base}draft-off"]`).count(),enabled?1:0);
    for(const path of ['draft-off','draft-off/rooms/0123456789AB']){
      await page.goto(frontend+base+path);
      if(enabled)await page.locator('.draft-off-shell form').waitFor();else{await page.getByRole('heading',{name:'That route is outside the boundary.'}).waitFor();assert.equal(await page.locator('.draft-off-shell').count(),0);}
    }
    assert.equal(requests,0);await page.screenshot({path:join(out,`${base==='/'?'root':'nested'}-${enabled?'enabled':'disabled'}.png`)});
    await page.goto(frontend+base+'classic');await page.waitForFunction(()=>document.querySelector('#app').textContent.includes('2016'));
    evidence.checks.push({base,enabled,apiOriginConfigured:true,directLanding:true,directRoom:true,navigation:enabled,classic:true,activationRequests:requests});await context.close();
    if(enabled){await soloRecovery(base);if(base==='/games/'){await enrollmentTabs(base,false);await enrollmentTabs(base,true);}}
    console.log(JSON.stringify({base,enabled,passed:true}));
  }
  assert.equal(evidence.consolePageErrors,0);writeFileSync(join(out,'summary.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{await browser?.close();await stopServer();await runtime.mf.dispose();rmSync(state,{recursive:true,force:true});}
