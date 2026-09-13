import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
const code=html.match(/\/\/ ONE ACCOUNT SYNC BEGIN([\s\S]*?)\/\/ ONE ACCOUNT SYNC END/)?.[1];
assert.ok(code,'native shared sync UI must exist');
const calls=[];let timer;
const ctx={console, document:{getElementById:()=>null,addEventListener:()=>{},visibilityState:'visible'},window:{addEventListener:()=>{}},setTimeout:f=>{timer=f;return 1},clearTimeout:()=>{},invoke:async(name,args)=>{calls.push([name,args]);return {enabled:true,account_id:'7',state:'current',consent_context:'synthetic-context',conflicts:[]}},escapeHtml:s=>String(s),showToast:()=>{},confirm:async()=>false,uiConfirm:async()=>true};
vm.createContext(ctx);vm.runInContext(code,ctx);
await ctx.oneAccountSyncEnable();
const enabled=calls.find(c=>c[0]==='enable_account_sync');assert.ok(enabled);assert.equal(enabled[1].consent,true);assert.equal(enabled[1].consentContext,'synthetic-context');
assert.ok(calls.some(c=>c[0]==='sync_account_now'),'enable performs actual synchronization');
calls.length=0;
ctx.oneAccountSyncSchedule();ctx.oneAccountSyncSchedule();await timer();
assert.equal(calls.filter(c=>c[0]==='sync_account_now').length,1,'save bursts coalesce');
await ctx.oneAccountSyncResolve('document','safe-id','remote');
assert.ok(calls.some(c=>c[0]==='resolve_account_sync_conflict'&&c[1].choice==='remote'));
console.log('one-account-sync UI integration PASS');

// An unrelated/background GET must not replace the version displayed in a form.
ctx.oneAccountCapture('document',{id:'doc',sync_revision:1},true);
ctx.oneAccountCapture('document',{id:'doc',sync_revision:2},false);
assert.equal(ctx.oneAccountDisplayed['document:doc'],1);
ctx.window.__TAURI__={};ctx.window.__SKIPI_WEBDESKTOP__={};
ctx.invoke=async(name,args)=>{calls.push([name,args]);return {sync_revision:3};};
ctx.oneAccountSyncInstall();
await ctx.invoke('update_doc_field',{id:'doc',field:'title',value:'mine'});
assert.equal(calls.at(-1)[1].expectedRevision,1,'save carries displayed version even after background data changed');
assert.equal(ctx.oneAccountDisplayed['document:doc'],3,'only own successful acknowledgement advances the form');
console.log('shared displayed-version CAS PASS');
// A child acknowledgement is not a fresh display of the parent form.
ctx.oneAccountCapture('experience',{id:'work',sync_revision:4},true);
ctx.invoke=async()=>({sync_revision:8,parent_revision:10,parent_id:'work'});
ctx.oneAccountSyncInstall();
await ctx.invoke('attach_work_file',{entryId:'work'});
assert.equal(ctx.oneAccountDisplayed['experience:work'],4,'child ack cannot absorb unseen parent edits');
ctx.oneAccountCapture('experience_file',{id:'file',sync_revision:7},true);
await ctx.invoke('delete_work_file',{id:'file'});
assert.equal(ctx.oneAccountDisplayed['experience:work'],4,'deleting evidence cannot advance an open parent form');
console.log('child acknowledgement isolation PASS');
// SaaS photo CAS belongs to the shim's displayed photo, not profile/main.
ctx.oneAccountCapture('profile',{sync_revision:11},true);
ctx.invoke=async(name,args)=>{calls.push([name,args]);return {sync_revision:29};};
ctx.oneAccountSyncInstall();
await ctx.invoke('upload_profile_photo_bytes',{fileName:'photo.png',dataBase64:'cGhvdG8='});
assert.equal(calls.at(-1)[1].expectedRevision,undefined,'SaaS photo must not send profile revision');
assert.equal(ctx.oneAccountDisplayed['profile:main'],11,'photo ack cannot advance profile form');
ctx.window.__SKIPI_WEBDESKTOP__=false;
ctx.invoke=async(name,args)=>{calls.push([name,args]);return {sync_revision:'native-photo-ack'};};
ctx.oneAccountSyncInstall();
await ctx.invoke('clear_profile_photo',{});
assert.equal(calls.at(-1)[1].expectedRevision,11,'native photo keeps the complete local profile fingerprint');
console.log('SaaS/native photo revision isolation PASS');

// Exercise the actual unified Settings post-mount callback, not a direct sync render.
const scheduleCode=html.slice(html.indexOf('    var _spEmbedTimer = null;'),html.indexOf('    function seafarerSection(){'));
assert.ok(scheduleCode.includes('function scheduleSeafarerFormLoad()'));
function mountedSyncSettings(){
    const scheduled=[];const requests=[];let loads=0;let shown=true;
    function panel(){return {isConnected:true,buttons:[],children:[],style:{},appendChild(child){this.children.push(child);},html:'',set innerHTML(value){this.html=value;this.children=[];this.buttons=value.includes('data-sync-action="enable"')?[{getAttribute:()=> 'enable'}]:[];},get innerHTML(){return this.html;},querySelectorAll(){return this.buttons;}};}
    const active=panel(),competing=panel();let livePanel=active;
    const root={isConnected:true,querySelector:s=>s==='#sp-photo-box'?{}:s==='#one-account-sync'?livePanel:null};let currentRoot=root;
    const legacy={innerHTML:'<input id="sp-old">'};
    const overlay={classList:{contains:()=>shown}};
    const doc={addEventListener:()=>{},createElement:()=>panel(),getElementById:id=>({'settings-root':currentRoot,'skipi-settings-overlay':overlay,'settings-body':legacy,'settings-overlay':{classList:{contains:()=>false}},'one-account-sync':competing}[id]||null)};
    const sandbox={document:doc,window:{addEventListener:()=>{}},console,Promise,setTimeout:f=>{scheduled.push(f);return scheduled.length;},clearTimeout:()=>{},spLoad:()=>{loads++;},logError:()=>{},invoke:name=>new Promise((resolve,reject)=>{requests.push({name,resolve,reject});})};
    vm.createContext(sandbox);vm.runInContext(code,sandbox);vm.runInContext(scheduleCode,sandbox);
    return {sandbox,active,competing,root,legacy,requests,scheduled,loads:()=>loads,close:()=>{shown=false;},replace:()=>{livePanel=panel();return livePanel;},replaceRoot:()=>{currentRoot={isConnected:true,querySelector:root.querySelector};}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function mountSync(){const s=mountedSyncSettings();s.sandbox.scheduleSeafarerFormLoad();s.scheduled.shift()();await flush();assert.equal(s.loads(),1,'actual callback still loads profile');assert.equal(s.legacy.innerHTML,'','stale legacy form still cleared');assert.equal(s.requests.length,1,'actual unified post-mount callback requests sync status');assert.equal(s.requests[0].name,'get_account_sync_status');return s;}
let mounted=await mountSync();
mounted.requests[0].resolve({enabled:false,state:'disabled',account_email:'synthetic@example.invalid',conflicts:[]});await flush();
assert.equal(mounted.active.buttons.length,1,'actual callback/status response renders Enable in mounted unified panel');
assert.ok(mounted.active.html.includes('Enable account sync'));
assert.equal(mounted.competing.innerHTML,'','competing mobile/legacy copy never receives unified status');
assert.equal(mounted.requests.length,1,'mount never enables synchronization automatically');
for(const change of ['close','replace','replaceRoot']){
    const s=await mountSync();s[change]();s.requests[0].resolve({enabled:false,state:'disabled',conflicts:[]});await flush();assert.equal(s.active.innerHTML,'',`${change}: delayed response cannot fill old panel`);assert.equal(s.competing.innerHTML,'');
}
mounted=await mountSync();mounted.root.isConnected=false;mounted.requests[0].reject(new Error('late closed error'));await flush();assert.equal(mounted.active.innerHTML,'','detached panel does not receive late error');
mounted=await mountSync();mounted.requests[0].reject(new Error('synthetic status unavailable'));await flush();assert.ok(mounted.active.html.includes('synthetic status unavailable'),'live panel shows status failure');
mounted=await mountSync();mounted.sandbox.scheduleSeafarerFormLoad();mounted.scheduled.shift()();await flush();mounted.requests[0].resolve({enabled:false,state:'disabled',account_email:'stale',conflicts:[]});await flush();assert.equal(mounted.active.innerHTML,'','superseded request cannot overwrite current request');mounted.requests[1].resolve({enabled:false,state:'disabled',account_email:'fresh',conflicts:[]});await flush();assert.ok(mounted.active.html.includes('fresh'));
console.log('unified Settings actual post-mount sync control and stale-response isolation PASS');

// Subsequent sync updates prefer the open unified panel over an earlier hidden copy.
mounted.sandbox.oneAccountSyncRender({enabled:true,state:'current',consent_context:'synthetic-context',conflicts:[]});
assert.ok(mounted.active.html.includes('documents are synchronized'));assert.equal(mounted.competing.innerHTML,'');
for(const language of ['en','ru']){
    const s=await mountSync();s.sandbox.getUiLang=()=>language;
    s.requests[0].resolve({enabled:false,state:'disabled',conflicts:[]});await flush();
    assert.ok(s.active.html.includes(language==='ru'?'Включить синхронизацию':'Enable account sync'));
    s.sandbox.oneAccountSyncRender({enabled:true,state:'conflict',conflicts:[{kind:'profile',id:'main',local:{name:'local'},remote:{name:'remote'},revision:1}]},s.active);
    const row=s.active.children[0];assert.equal(row.children[2].textContent,language==='ru'?'Оставить версию устройства':'Keep this device version');assert.equal(row.children[3].textContent,language==='ru'?'Использовать версию аккаунта':'Use account version');assert.ok(row.children[1].textContent.startsWith(language==='ru'?'На устройстве: ':'This device: '));
    s.sandbox.oneAccountSyncRender({state:'error',error:'raw server error <retry>',conflicts:[]},s.active);assert.ok(s.active.html.includes(language==='ru'?'Синхронизация требует внимания':'Sync needs attention'));assert.ok(s.active.html.includes('raw server error &lt;retry&gt;'));
    s.sandbox.invoke=async()=>({consent_context:'synthetic-context'});let consent;s.sandbox.uiConfirm=async message=>{consent=message;return false;};s.sandbox.confirm=message=>{consent=message;return false;};await s.sandbox.oneAccountSyncEnable();assert.ok(consent.startsWith(language==='ru'?'Синхронизировать профиль':'Sync this signed-in'));assert.equal(s.requests.length,1,'declined real consent never enables sync');
}
mounted=mountedSyncSettings();mounted.root.querySelector=()=>null;mounted.sandbox.scheduleSeafarerFormLoad();let ticks=0;while(mounted.scheduled.length){mounted.scheduled.shift()();assert.ok(++ticks<=42,'post-mount polling stays bounded');}assert.equal(mounted.requests.length,0,'unmounted form never requests sync');
console.log('sync control RU/EN, explicit consent, errors and bounded mount wait PASS');

for(const language of ['en','ru']){
    const s=mountedSyncSettings();s.sandbox.getUiLang=()=>language;
    s.sandbox.oneAccountSyncRender({web_account:true,account_id:'opaque-account',state:'account'},s.active);
    assert.ok(s.active.html.includes('opaque-account'));
    assert.ok(s.active.html.includes(language==='ru'?'Данные сохранены в этом аккаунте':'Data is saved in this account'));
    assert.ok(!s.active.html.includes('data-sync-action'),'web account has no native sync actions');
    s.sandbox.window.__SKIPI_WEBDESKTOP__={};
    for(const status of [{state:'error',error:'actual manifest failure'},{state:'disabled'},{state:'conflict',conflicts:[{kind:'profile',id:'main',revision:1}]}]){
        s.sandbox.oneAccountSyncRender(status,s.active);
        assert.ok(!s.active.html.includes('data-sync-action'),'real web surface suppresses native actions even without status marker');
        assert.equal(s.active.children.length,0,'web surface has no native conflict choices');
        assert.ok(!s.active.html.includes(language==='ru'?'Данные сохранены':'Data is saved'),'failed/unconfirmed web read does not claim saved');
        if(status.error)assert.ok(s.active.html.includes(status.error),'actual web error remains visible');
    }
}
console.log('web account success/error/native-control suppression RU/EN PASS');

// Tauri's global confirm is asynchronous and may reject. Only the app's awaited
// custom dialog, with a strict affirmative result, can authorize native sync.
for(const outcome of [false,'reject',null,'yes',1,true]){
    const s=mountedSyncSettings(),sent=[];let decide,rejectDecision;
    s.sandbox.confirm=async()=>false; // exact former Promise-truthiness trap
    s.sandbox.uiConfirm=()=>new Promise((resolve,reject)=>{decide=resolve;rejectDecision=reject;});
    s.sandbox.invoke=async(name,args)=>{sent.push([name,args]);return {enabled:true,state:'current',consent_context:'synthetic-context',conflicts:[]};};
    const operation=s.sandbox.oneAccountSyncEnable();await flush();
    assert.equal(sent.filter(c=>c[0]!=='get_account_sync_status').length,0,'pending asynchronous consent makes ZERO mutating calls');
    if(outcome==='reject')rejectDecision(new Error('synthetic consent unavailable'));else decide(outcome);
    await operation;await flush();
    if(outcome===true){
        assert.equal(sent.filter(c=>c[0]==='enable_account_sync').length,1);
        assert.equal(sent.find(c=>c[0]==='enable_account_sync')[1].consent,true);
        assert.equal(sent.find(c=>c[0]==='enable_account_sync')[1].consentContext,'synthetic-context');
        assert.deepEqual(sent.slice(0,3).map(c=>c[0]),['get_account_sync_status','get_account_sync_status','enable_account_sync']);
        assert.equal(sent.filter(c=>c[0]==='sync_account_now').length,1);
        assert.ok(sent.findIndex(c=>c[0]==='enable_account_sync')<sent.findIndex(c=>c[0]==='sync_account_now'));
    }else assert.equal(sent.filter(c=>c[0]!=='get_account_sync_status').length,0,'false/rejected/non-boolean consent makes ZERO enable or sync calls');
    if(outcome==='reject')assert.ok(s.active.innerHTML.includes('synthetic consent unavailable'));
}
const dialogCode=html.slice(html.indexOf('function uiConfirm(msg, opts){'),html.indexOf('\nfunction uiPrompt('));
assert.ok(dialogCode.includes("box.querySelector('#uic-cancel').onclick"));
for(const language of ['en','ru'])for(const accept of [false,true]){
    const s=mountedSyncSettings(),sent=[],overlays=[];s.sandbox.getUiLang=()=>language;
    s.sandbox.esc=v=>String(v);s.sandbox.document.body={appendChild:el=>overlays.push(el),removeChild:el=>{const i=overlays.indexOf(el);assert.ok(i>=0);overlays.splice(i,1);}};
    s.sandbox.document.createElement=()=>({style:{},children:[],appendChild(el){this.children.push(el);},set innerHTML(v){this.html=v;this.controls={'#uic-ok':{},'#uic-cancel':{}};},querySelector(selector){return this.controls[selector];}});
    s.sandbox.invoke=async(name,args)=>{sent.push([name,args]);return {enabled:true,state:'current',consent_context:'synthetic-context',conflicts:[]};};
    vm.runInContext(dialogCode,s.sandbox);const operation=s.sandbox.oneAccountSyncEnable();await flush();
    assert.equal(overlays.length,1,'actual uiConfirm creates one visible DOM dialog');assert.equal(sent.filter(c=>c[0]!=='get_account_sync_status').length,0);
    const box=overlays[0].children[0];assert.ok(box.html.includes(language==='ru'?'Отмена':'Cancel'));assert.ok(box.html.includes(language==='ru'?'Включить синхронизацию':'Enable account sync'));
    box.querySelector(accept?'#uic-ok':'#uic-cancel').onclick();await operation;
    assert.equal(overlays.length,0,'actual decision removes dialog');assert.equal(sent.filter(c=>c[0]==='enable_account_sync').length,accept?1:0);assert.equal(sent.filter(c=>c[0]==='sync_account_now').length,accept?1:0);
}
console.log('deferred strict consent and actual DOM dialog RU/EN cancellation/affirmative PASS');

// The authoritative context must survive the dialog; a stale DOM status is not consent.
for(const change of ['path','epoch','parent']){
    const s=mountedSyncSettings(),sent=[];let decide,context='original-'+change;
    s.sandbox.uiConfirm=()=>new Promise(resolve=>{decide=resolve;});
    s.sandbox.invoke=async(name,args)=>{sent.push([name,args]);return {consent_context:context};};
    s.sandbox.oneAccountSyncLast={consent_context:'stale-rendered-context'};
    const operation=s.sandbox.oneAccountSyncEnable();await flush();
    assert.deepEqual(sent.map(c=>c[0]),['get_account_sync_status']);
    context='changed-'+change;decide(true);await operation;
    assert.deepEqual(sent.map(c=>c[0]),['get_account_sync_status','get_account_sync_status']);
    assert.ok(s.active.html.includes('changed'),'changed context is a visible failure');
}
for(const context of [undefined,null,'']){
    const s=mountedSyncSettings(),sent=[];let dialogs=0;
    s.sandbox.uiConfirm=async()=>{dialogs++;return true;};
    s.sandbox.invoke=async(name,args)=>{sent.push([name,args]);return {consent_context:context};};
    await s.sandbox.oneAccountSyncEnable();
    assert.equal(dialogs,0,'missing context cannot request usable consent');
    assert.deepEqual(sent.map(c=>c[0]),['get_account_sync_status']);
}
console.log('authoritative consent context capture and pending account/vault change isolation PASS');

// A backend freshness rejection after the UI reread must never start sync.
{
    const s=mountedSyncSettings(),sent=[];s.sandbox.uiConfirm=async()=>true;
    s.sandbox.invoke=async(name,args)=>{sent.push([name,args]);if(name==='enable_account_sync')throw new Error('Vault or login changed during consent');return {consent_context:'synthetic-context'};};
    await s.sandbox.oneAccountSyncEnable();
    assert.deepEqual(sent.map(c=>c[0]),['get_account_sync_status','get_account_sync_status','enable_account_sync']);
    assert.ok(s.active.html.includes('Vault or login changed during consent'));
    sent.length=0;s.sandbox.window.__SKIPI_WEBDESKTOP__={};await s.sandbox.oneAccountSyncEnable();assert.equal(sent.length,0);
}
console.log('backend context rejection blocks sync and web never requests native consent PASS');

// Required counters use the active template universe, not retained document rows.
{
    const counter={activeTemplateIds:['passport','sid','passport'],activeTemplateIdsLoaded:true,activeTemplateIdSet:{passport:true,sid:true},allDocs:[{id:'p1',template_id:'passport',category:'Passport',file_name:'p.pdf'},{id:'p2',template_id:'passport',category:'Passport'},{id:'s1',template_id:'sid',category:'SID',sha256:'synthetic-sha'},{id:'s2',template_id:'sid',category:'SID'},{id:'custom',category:'Custom'},{id:'conditional',template_id:'conditional',category:'Conditional'}],docTreeFilter:'all',isOptionalCategory:c=>c==='Optional',classify:()=> 'none'};
    vm.createContext(counter);
    for(const name of ['isActiveTemplateId','isActiveRequiredDoc','mobileDocHasAttachedFile','requiredDocumentSummary','mobileCompletenessPercent','mobileStats','docMatchesTreeFilter','docFilterCount']){
        const start=html.indexOf('function '+name+'(');if(start<0)continue;
        const end=html.indexOf('\nfunction ',start+1);vm.runInContext(html.slice(start,end).split('\nvar ')[0],counter);
    }
    assert.equal(counter.docFilterCount('required'),2,'retained fileless duplicate rows do not add required qualifications');
    assert.equal(counter.docFilterCount('missing'),0,'any qualifying attachment satisfies the same-template requirement');
    counter.docTreeFilter='missing';assert.equal(counter.allDocs.filter(counter.docMatchesTreeFilter).length,0,'zero missing count must not show empty duplicate rows');counter.docTreeFilter='all';
    assert.equal(counter.mobileStats().missing,0);assert.equal(counter.mobileCompletenessPercent(),100);
    assert.equal(counter.docFilterCount('all'),6,'all document rows remain counted');
    counter.activeTemplateIds.push('absent');counter.activeTemplateIdSet.absent=true;
    assert.equal(counter.docFilterCount('required'),3);assert.equal(counter.docFilterCount('missing'),1,'wholly absent template is still missing');
    assert.equal(counter.mobileStats().missing,1);assert.equal(counter.mobileCompletenessPercent(),67);
    counter.allDocs.push({id:'absent-file',template_id:'absent',category:'Certificate',file_size:1});
    assert.equal(counter.docFilterCount('missing'),0,'size-only attached-file evidence retains canonical predicate');
    counter.activeTemplateIdsLoaded=false;
    assert.equal(counter.docFilterCount('required'),'—');assert.equal(counter.docFilterCount('missing'),'—');assert.equal(counter.mobileCompletenessPercent(),0,'unloaded framework cannot imply completeness');
}
console.log('unique active-template counters preserve absent requirements and all document rows PASS');

// Retained sync history is not an active connection after logout/disable.
for(const language of ['en','ru'])for(const oldState of ['current','error','conflict']){
    const s=mountedSyncSettings();s.sandbox.getUiLang=()=>language;
    s.sandbox.oneAccountSyncRender({enabled:false,state:oldState,last_completed:'preserved',conflicts:[{kind:'document',id:'saved-conflict',revision:2,local:{},remote:null}]},s.active);
    assert.ok(s.active.html.includes(language==='ru'?'Синхронизация выключена':'Sync is off'),'disabled binding never displays synchronized history');
    assert.equal(s.active.children.length,0,'inactive native binding hides retained conflict resolution actions');
    assert.ok(s.active.html.includes('data-sync-action="enable"'));
    assert.ok(!s.active.html.includes('data-sync-action="retry"'));
}
console.log('disabled native UI hides retained conflict actions and never claims current RU/EN PASS');
