// tasks/016 (срез A): слот «Не применимо ко мне» с причиной.
// Проверяет на реальном dist/index.html: пометка читается из field_statuses,
// закрывает обязательный слот в счётчиках, не действует при приложенном файле,
// сохраняется через update_field_statuses, снимается обратно.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=fs.readFileSync(path.join(root,'dist/index.html'),'utf8');
function fn(name){
    const re=new RegExp('(?:^|\\n)(async )?function '+name+'\\(');
    const m=re.exec(html);
    assert.ok(m,'function not found: '+name);
    let i=html.indexOf('{',m.index),depth=0,j=i;
    for(;j<html.length;j++){const c=html[j];if(c==='{')depth++;else if(c==='}'){depth--;if(depth===0)break;}}
    return html.slice(m.index,j+1);
}
const names=['securityCoveringIds','securityCoveringDoc','docNotApplicable','securityCoveredByAttached','securityCoveredHint',
    'isActiveRequiredDoc','isCoveredRequiredDoc','mobileStatusPill','docNaBlockHtml','docNaSave','docNaEdit','docNaRerender'];
const calls=[];let rendered=0;
const sandbox={
    allDocs:[],selectedDocId:null,docNaEditingId:null,activeTemplateIds:['sso','dsd'],
    SECURITY_COVERAGE:{},
    isActiveTemplateId:id=>['sso','dsd'].includes(id),isOptionalCategory:()=>false,
    getUiLang:()=>'ru',mobileSetupText:(en,ru)=>ru,esc:s=>String(s||''),jsString:s=>String(s),
    isMobileMode:()=>true,renderMobileDoc:()=>{rendered++;},renderDoc:()=>{},renderTree:()=>{},updateStatus:()=>{},
    showToast:()=>{},logError:()=>{},mobileDocHasAttachedFile:d=>!!d.file_name,
    invoke:async(cmd,args)=>{calls.push([cmd,args]);if(cmd==='get_documents')return sandbox.allDocs;return {};},
    document:{getElementById:()=>null},console,
};
vm.createContext(sandbox);
// securityCoveringIds читает таблицу покрытия — в этом харнесе покрытий нет.
vm.runInContext('function securityCoveringIds(){return [];}\n'+names.filter(n=>n!=='securityCoveringIds').map(fn).join('\n'),sandbox);

const slot={id:'d1',template_id:'sso',category:'STCW',title:'SSO',file_name:null,field_statuses:'{}'};
sandbox.allDocs=[slot];sandbox.selectedDocId='d1';

assert.equal(sandbox.docNotApplicable(slot),null);
assert.equal(sandbox.isCoveredRequiredDoc(slot),false);
assert.ok(sandbox.mobileStatusPill(slot).includes('Недостающий'),'пустой обязательный слот — недостающий');
assert.ok(sandbox.docNaBlockHtml(slot).includes('doc-na-open'),'кнопка «Не применимо ко мне» есть и у обязательного слота');

sandbox.docNaEdit('d1');
assert.ok(sandbox.docNaBlockHtml(slot).includes('doc-na-form'),'форма с причиной');
await sandbox.docNaSave('d1','  не работаю офицером охраны  ');
const saved=calls.find(c=>c[0]==='update_field_statuses');
assert.ok(saved,'сохранение идёт через update_field_statuses');
const stored=JSON.parse(saved[1].statuses);
assert.equal(stored.not_applicable.reason,'не работаю офицером охраны');
assert.deepEqual(JSON.parse(JSON.stringify(sandbox.docNotApplicable(slot))),{reason:'не работаю офицером охраны'});
assert.equal(sandbox.isCoveredRequiredDoc(slot),true,'помеченный слот не считается недостающим');
assert.ok(sandbox.mobileStatusPill(slot).includes('Не применимо'));
const block=sandbox.docNaBlockHtml(slot);
assert.ok(block.includes('doc-na-state')&&block.includes('не работаю офицером охраны')&&block.includes('doc-na-clear'));
assert.ok(sandbox.securityCoveredHint(slot).text.includes('не работаю офицером охраны'));
assert.ok(rendered>0,'карточка перерисована');

// прочие статусы полей сохраняются рядом с пометкой
slot.field_statuses=JSON.stringify({doc_number:'ai',not_applicable:{reason:'x'}});
await sandbox.docNaSave('d1',null);
assert.deepEqual(JSON.parse(slot.field_statuses),{doc_number:'ai'},'снятие пометки не трогает остальное');
assert.equal(sandbox.docNotApplicable(slot),null);
assert.equal(sandbox.isCoveredRequiredDoc(slot),false);

// с приложенным файлом пометка не действует и не предлагается
const filed={...slot,file_name:'sso.pdf',field_statuses:JSON.stringify({not_applicable:{reason:'x'}})};
assert.equal(sandbox.docNotApplicable(filed),null);
assert.equal(sandbox.docNaBlockHtml(filed),'');
// свой документ без шаблона: пометка не предлагается
assert.equal(sandbox.docNaBlockHtml({id:'c1',template_id:null,file_name:null,field_statuses:'{}'}),'');
console.log('docs_not_applicable_harness: ok');
