// Actual UI modules, bundled with Vite so build-time routing and CSS imports match the browser.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { enrollGuest } from '../dist/draftOffEnrollmentClient.js';
import { enrollDraftOffGuest } from '../dist/draftOffSession.js';
import { loadEraDraftCatalog } from '../dist/eraDraftData.js';
import { createEraDraftGame, reduceEraDraft } from '../dist/eraDraftEngine.js';
import { writeEraDraftUiSave } from '../dist/eraDraftUiPersistence.js';
const code = '0123456789AB', credential = {participantId:'p_'+'a'.repeat(32),reconnectCredential:'A'.repeat(43)};
const credentialSlot = `draft-off:credential:${code}`, pendingSlot = `draft-off:pending:JOIN:${code}`;
const storage = () => { const rows = new Map(); return {getItem:k=>rows.get(k)??null,setItem:(k,v)=>rows.set(k,v),removeItem:k=>rows.delete(k)}; };
const deferred = () => { let resolve, reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const flush = async () => { for(let i=0;i<10;i++) await new Promise(resolve=>setImmediate(resolve)); };
function mutex() { let tail=Promise.resolve(); return async (_name,work)=>{const prior=tail,done=deferred();tail=done.promise;await prior;try{return await work();}finally{done.resolve();}}; }
const success = (identity=credential) => Response.json({ok:true,roomCode:code,...identity},{status:201});

for(const sameName of [false,true])test(`concurrent JOIN forms serialize and resume one identity (${sameName?'same':'different'} names)`,async()=>{
  const saved=storage(), held=deferred(), withLock=mutex(), activations=[];let sends=0;
  const options={apiOrigin:'https://api.test',operation:'JOIN',roomCode:code,storage:saved,withLock,expectedPendingRecord:null,
    input:{displayName:'First'},isActive:()=>true,onEnrolled:(_code,value)=>activations.push(value.participantId),
    transport:async()=>{sends++;return held.promise;}};
  const first=enrollDraftOffGuest(options),second=enrollDraftOffGuest({...options,input:{displayName:sameName?'First':'Second'}});
  const completed=Promise.allSettled([first,second]);await flush();assert.equal(sends,1);
  held.resolve(success());const replies=await completed;
  assert.ok(replies.every(reply=>reply.status==='fulfilled'&&reply.value.activated));
  assert.equal(sends,1);assert.deepEqual(activations,[credential.participantId,credential.participantId]);
  assert.deepEqual(JSON.parse(saved.getItem(credentialSlot)),credential);assert.equal(saved.getItem(pendingSlot),null);
});

test('conflicting success cannot replace a current identity or remove exact recovery',async()=>{
  const saved=storage(), held=deferred();let activated=false;
  const pending=enrollGuest('https://api.test','JOIN',code,{displayName:'Old'},saved,()=>held.promise,()=>{activated=true;});
  const recovery=saved.getItem(pendingSlot);saved.setItem(credentialSlot,JSON.stringify(credential));
  held.resolve(success({participantId:'p_'+'b'.repeat(32),reconnectCredential:'B'.repeat(43)}));await pending;
  assert.deepEqual(JSON.parse(saved.getItem(credentialSlot)),credential);assert.equal(saved.getItem(pendingSlot),recovery);assert.equal(activated,false);
});

test('queued JOIN rechecks ownership, preserves lost-response key and never sends changed input',async()=>{
  const saved=storage(), held=deferred(), withLock=mutex(), requests=[];
  const options={apiOrigin:'https://api.test',operation:'JOIN',roomCode:code,storage:saved,withLock,expectedPendingRecord:null,
    input:{displayName:'First'},isActive:()=>true,onEnrolled(){},transport:async(_url,init)=>{requests.push(init);return held.promise;}};
  const first=enrollDraftOffGuest(options),second=enrollDraftOffGuest({...options,input:{displayName:'Second'}});
  const settled=Promise.allSettled([first,second]);await flush();held.reject(new Error('Lost reply'));await settled;
  assert.equal(requests.length,1);const record=saved.getItem(pendingSlot);assert.ok(record);
  await enrollDraftOffGuest({...options,expectedPendingRecord:record,transport:async(_url,init)=>{assert.equal(init.body,requests[0].body);assert.equal(new Headers(init.headers).get('Enrollment-Key'),new Headers(requests[0].headers).get('Enrollment-Key'));return success();}});
  assert.equal(saved.getItem(pendingSlot),null);
});

test('changed pending ownership and disposed queued forms cannot initiate enrollment',async()=>{
  const saved=storage(), record=JSON.stringify({key:'N'.repeat(43),input:JSON.stringify({displayName:'First'})});
  saved.setItem(pendingSlot,record);let sends=0,active=true;const lock=mutex(),hold=deferred();
  const options={apiOrigin:'https://api.test',operation:'JOIN',roomCode:code,storage:saved,expectedPendingRecord:null,
    input:{displayName:'First'},isActive:()=>active,onEnrolled(){},transport:async()=>{sends++;return success();}};
  await assert.rejects(enrollDraftOffGuest(options),/recovery changed/);assert.equal(saved.getItem(pendingSlot),record);
  const blocker=lock('room',()=>hold.promise);const queued=enrollDraftOffGuest({...options,withLock:lock,expectedPendingRecord:record});
  const rejected=assert.rejects(queued,/no longer active/);active=false;hold.resolve();await blocker;await rejected;assert.equal(sends,0);
});

for(const outcome of ['wrong-room','unreadable-identity'])test(`conflicting ${outcome} preserves credentials and enrollment recovery`,async()=>{
  const saved=storage(),held=deferred();const attempt=enrollGuest('https://api.test','JOIN',code,{displayName:'First'},saved,()=>held.promise);
  const record=saved.getItem(pendingSlot);if(outcome==='unreadable-identity')saved.setItem(credentialSlot,'{');
  held.resolve(outcome==='wrong-room'?Response.json({ok:true,roomCode:'0123456789AC',...credential},{status:201}):success());await attempt;
  assert.equal(saved.getItem(pendingSlot),record);assert.equal(saved.getItem(credentialSlot),outcome==='unreadable-identity'?'{':null);
  assert.equal(saved.getItem('draft-off:credential:0123456789AC'),null);
});

const root=resolve('.'), scratch=mkdtempSync(join(tmpdir(),'draft-off-premerge-')), apps=new Map();
before(async()=>{
  symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'));
  const entry=join(scratch,'entry.mjs');writeFileSync(entry,`export {EraDraftApp} from ${JSON.stringify(join(root,'src/eraDraftApp.tsx'))};export {default as DraftOffApp} from ${JSON.stringify(join(root,'src/draftOffApp.tsx'))};`);
  for(const base of ['/','/games/'])for(const enabled of [false,true]){
    const out=join(scratch,`${base==='/'?'root':'nested'}-${enabled}`);
    await build({configFile:false,logLevel:'silent',base,define:{'import.meta.env.BASE_URL':JSON.stringify(base),'import.meta.env.VITE_DRAFT_OFF_ENABLED':enabled?JSON.stringify('true'):'undefined','import.meta.env.VITE_DRAFT_OFF_API_ORIGIN':JSON.stringify('https://api.test')},build:{ssr:entry,outDir:out,rollupOptions:{output:{entryFileNames:'app.mjs'}}}});
    apps.set(`${base}:${enabled}`,await import(pathToFileURL(join(out,'app.mjs')).href));
  }
});
after(()=>rmSync(scratch,{recursive:true,force:true}));
async function mount(base='/',enabled=true,path=base,component='EraDraftApp',fetcher=async()=>new Response('{}',{status:503})){
  const dom=new JSDOM('<div id="root"></div>',{url:'https://frontend.test'+path});dom.window.scrollTo=()=>{};
  const keys=['window','document','HTMLElement','PopStateEvent','localStorage','sessionStorage','requestAnimationFrame','WebSocket','navigator','fetch','IS_REACT_ACT_ENVIRONMENT'];
  const previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.defineProperty(dom.window.navigator,'locks',{value:{request:mutex()}});
  const values={window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,PopStateEvent:dom.window.PopStateEvent,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,requestAnimationFrame:fn=>setTimeout(fn,0),WebSocket:class{close(){}},navigator:dom.window.navigator,fetch:fetcher,IS_REACT_ACT_ENVIRONMENT:true};
  for(const key of keys)Object.defineProperty(globalThis,key,{value:values[key],writable:true,configurable:true});
  const {createRoot}=await import('react-dom/client'),reactRoot=createRoot(document.getElementById('root'));
  const ui={dom,document:dom.window.document,
    async render(){await act(async()=>{reactRoot.render(createElement(apps.get(`${base}:${enabled}`)[component]));await flush();});},
    async click(selector){const el=document.querySelector(selector);assert.ok(el,selector);await act(async()=>{el.click();await flush();});},
    async navigate(path){await act(async()=>{window.history.pushState(null,'',path);window.dispatchEvent(new PopStateEvent('popstate'));await flush();await new Promise(resolve=>setTimeout(resolve,20));});},
    async close(){await act(async()=>reactRoot.unmount());dom.window.close();for(const [key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}}};
  return ui;
}
const publicDir=join(root,'data/processed/era-draft/web/v1/public');
function catalogs(held){return async input=>{const url=new URL(String(input),'https://frontend.test');if(url.pathname.startsWith('/api/'))return new Response('{}',{status:503});if(url.pathname.includes('/eras/')&&held)await held.promise;return new Response(readFileSync(join(publicDir,url.pathname.replace(/^\/games\//,'/'))));};}

for(const operation of ['START','CONTINUE'])test(`delayed solo ${operation} cannot publish after Draft-Off navigation, including away and back`,async()=>{
  const held=deferred(),ui=await mount('/' ,true,'/','EraDraftApp',catalogs(held));
  try{
    if(operation==='CONTINUE'){
      const catalog=loadEraDraftCatalog();const setup=createEraDraftGame({catalog,rootSeed:'premerge-continue'});
      const chosen=reduceEraDraft(catalog,setup,{type:'CHOOSE_ERA',eraId:'era-foundation'});assert.ok(chosen.ok);writeEraDraftUiSave(chosen.state,localStorage);
    }
    const original=localStorage.getItem('era-draft-ui-save/v1');await ui.render();
    if(operation==='START'){await ui.click('.era-card');await ui.click('.start-draft-action');}else await ui.click('.landing-continue');
    await ui.click('a[href="/draft-off"]');assert.equal(window.location.pathname,'/draft-off');
    await ui.navigate('/'); // Returning to the same route must not revive its old generation.
    await act(async()=>{held.resolve();await new Promise(resolve=>setTimeout(resolve,100));});
    assert.equal(window.location.pathname,'/');assert.equal(localStorage.getItem('era-draft-ui-save/v1'),original);
    if(operation==='CONTINUE'){await ui.click('.landing-continue');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,100));});assert.equal(window.location.pathname,'/era-draft');}
  }finally{held.resolve();await ui.close();}
});

for(const base of ['/','/games/'])for(const enabled of [false,true])test(`build gate: ${enabled?'enabled':'default disabled'}, base ${base}`,async()=>{
  let apiCalls=0;const ui=await mount(base,enabled,base,'EraDraftApp',async(input,init)=>{if(String(input).includes('/api/')){apiCalls++;return new Response('{}',{status:503});}return catalogs()(input,init);});
  try{
    await ui.render();assert.equal(document.querySelectorAll(`a[href="${base}draft-off"]`).length,enabled?1:0);
    for(const path of [`${base}draft-off`,`${base}draft-off/rooms/${code}`]){
      await ui.navigate(path);
      for(let i=0;enabled&&!document.querySelector('.draft-off-shell')&&i<40;i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});assert.equal(document.querySelectorAll('.draft-off-shell').length,enabled?1:0, path+': '+document.body.textContent);assert.equal(document.querySelectorAll('form').length,enabled?1:0,path+': '+document.body.textContent);
    }
    assert.equal(apiCalls,enabled?1:0);await ui.navigate(base);assert.ok(document.querySelector('.era-picker'));
  }finally{await ui.close();}
});

for(const notification of ['storage/focus','submit'])test(`pre-opened invitation form resumes on ${notification} without a second JOIN`,async()=>{
  let joins=0;const ui=await mount('/',true,`/draft-off/rooms/${code}`,'DraftOffApp',async(url)=>{
    if(String(url).endsWith('/join')){joins++;return success();}
    return new Response('{}',{status:503});
  });
  try{
    await ui.render();assert.ok(document.querySelector('form'));
    // The other tab completed enrollment while this tab's form was already mounted.
    localStorage.setItem(credentialSlot,JSON.stringify(credential));
    await act(async()=>{if(notification==='storage/focus'){window.dispatchEvent(new ui.dom.window.StorageEvent('storage',{key:credentialSlot}));window.dispatchEvent(new ui.dom.window.Event('focus'));}else document.querySelector('form').dispatchEvent(new ui.dom.window.Event('submit',{bubbles:true,cancelable:true}));await flush();});
    assert.equal(!!document.querySelector('form'),false);assert.equal(joins,0);assert.deepEqual(JSON.parse(localStorage.getItem(credentialSlot)),credential);
  }finally{await ui.close();}
});

for(const notification of ['storage','focus'])test(`JOIN form adopts another tab's pending CREATE on ${notification} and recovers without reload`,async()=>{
  const requests=[],held=deferred(),ui=await mount('/',true,'/draft-off','DraftOffApp',async(url,init)=>{
    if(String(url).endsWith('/rooms')){requests.push(init);return held.promise;}
    return new Response('{}',{status:503});
  });
  const slot='draft-off:pending:CREATE:',input=JSON.stringify({displayName:'Other tab',eraId:'era-transition',draftMinutes:10});
  const record=JSON.stringify({key:'K'.repeat(43),input});
  try{
    await ui.render();await ui.click('.draft-off-tabs button:nth-child(2)');
    // An unrelated event with no pending attempt must not reset the selected mode.
    await act(async()=>window.dispatchEvent(new ui.dom.window.StorageEvent('storage',{key:'unrelated'})));
    assert.equal(document.querySelector('.draft-off-tabs button:nth-child(2)').getAttribute('aria-pressed'),'true');
    localStorage.setItem(slot,record);
    await act(async()=>{window.dispatchEvent(notification==='storage'?new ui.dom.window.StorageEvent('storage',{key:slot}):new ui.dom.window.Event('focus'));await flush();});
    assert.equal(document.querySelector('.draft-off-tabs button:first-child').getAttribute('aria-pressed'),'true');
    assert.equal(document.querySelector('input').value,'Other tab');assert.equal(document.querySelectorAll('input').length,1);
    assert.deepEqual([...document.querySelectorAll('select')].map(el=>el.value),['era-transition','10','RECOVERY']);
    assert.match(document.body.textContent,/format will be confirmed after recovery/);
    assert.ok(document.querySelector('form').checkValidity());assert.equal(localStorage.getItem(slot),record);
    await ui.click('form button');assert.equal(requests.length,1);assert.equal(requests[0].body,input);
    assert.equal(new Headers(requests[0].headers).get('Enrollment-Key'),'K'.repeat(43));assert.equal(localStorage.getItem(slot),record);
    await act(async()=>{held.resolve(success());await flush();});
    assert.equal(window.location.pathname,`/draft-off/rooms/${code}`);assert.equal(localStorage.getItem(slot),null);
    assert.deepEqual(JSON.parse(localStorage.getItem(credentialSlot)),credential);
  }finally{held.resolve(success());await ui.close();}
});

test('room-scoped pending JOIN leaves the CREATE form alone and recovers on its own room route',async()=>{
  const requests=[],held=deferred(),ui=await mount('/',true,'/draft-off','DraftOffApp',async(url,init)=>{
    if(String(url).endsWith('/join')){requests.push(init);return held.promise;}
    return new Response('{}',{status:503});
  });
  const input=JSON.stringify({displayName:'Saved guest'}),record=JSON.stringify({key:'J'.repeat(43),input});
  try{
    await ui.render();localStorage.setItem(pendingSlot,record);
    await act(async()=>{window.dispatchEvent(new ui.dom.window.StorageEvent('storage',{key:pendingSlot}));window.dispatchEvent(new ui.dom.window.Event('focus'));});
    assert.equal(document.querySelector('.draft-off-tabs button:first-child').getAttribute('aria-pressed'),'true');
    assert.equal(document.querySelector('input').value,'');assert.equal(requests.length,0);
    // JOIN recovery is scoped to the invitation route, never adopted by a different form.
    localStorage.removeItem(pendingSlot);await ui.navigate(`/draft-off/rooms/${code}`);
    localStorage.setItem(pendingSlot,record);
    await act(async()=>{window.dispatchEvent(new ui.dom.window.Event('focus'));await flush();});
    assert.deepEqual([...document.querySelectorAll('input')].map(el=>el.value),[code,'Saved guest']);
    assert.ok(document.querySelector('form').checkValidity());assert.equal(localStorage.getItem(pendingSlot),record);
    await ui.click('form button');assert.equal(requests.length,1);assert.equal(requests[0].body,input);
    assert.equal(new Headers(requests[0].headers).get('Enrollment-Key'),'J'.repeat(43));
    await act(async()=>{held.resolve(success());await flush();});
    assert.equal(document.querySelector('form'),null);assert.equal(localStorage.getItem(pendingSlot),null);
    assert.deepEqual(JSON.parse(localStorage.getItem(credentialSlot)),credential);
  }finally{held.resolve(success());await ui.close();}
});
