import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openTaskStore} from './tasks.mjs'
import {listBots} from './bots.mjs'
import {sharingModel,groupSharingConfig} from './fixtures/group-sharing-model.mjs'
async function until(fn,check=Boolean){for(let i=0;i<1600;i++){const v=await fn();if(check(v))return v;await new Promise(r=>setTimeout(r,10))}throw Error('Sharing recovery timeout')}
for(const phase of ['atomic-rollback','b-waiting','result-collected'])test(`group sharing SIGKILL ${phase}: exact sources, single revisions and delivery`,{timeout:25000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pidot-sharing-kill-'));let store
 const child=spawn(process.execPath,[new URL('./fixtures/group-sharing-process.mjs',import.meta.url).pathname,dir,phase],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',x=>errors+=x);const exit=once(child,'exit')
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit}if(store)await store.close();await rm(dir,{recursive:true,force:true})})
 const saved=await until(async()=>{if(child.exitCode!==null)throw Error(errors);try{return JSON.parse(await readFile(join(dir,'checkpoint.json'),'utf8'))}catch{return null}})
 child.kill('SIGKILL');assert.equal((await exit)[1],'SIGKILL')
 store=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(groupSharingConfig),modelReply:sharingModel})
 const parent=await until(()=>store.get(saved.taskId),v=>v.activeInputId===null&&v.collaborations.length===2&&v.collaborations.every(r=>r.businessStatus==='accepted'))
 assert.equal(parent.groupId,saved.groupId);assert.equal(parent.sharedInformation.length,1)
 const [a,b]=parent.collaborations;assert.equal(a.executorBotId,'calendar');assert.equal(b.executorBotId,'chief');assert.equal(a.rootWorkId,b.rootWorkId);assert.equal(b.parentInputId,saved.inputId)
 assert.deepEqual(parent.sharedInformation[0].readers,[b.childTaskId]);assert.equal(parent.sharedInformation[0].accessVersion,1)
 assert.equal(b.sharedSources.length,1);assert.equal(b.result.sources[0].recordId,parent.sharedInformation[0].recordId)
 for(const r of [a,b]){assert.equal(r.revisions.length,1);assert.equal(r.decisions.length,1);assert.ok(r.consumedEntryId);assert.equal(r.result.deliveryKey,`${r.id}:revision:1`)}
 const final=parent.messages.filter(m=>m.role==='assistant'&&!m.assistant&&!m.intermediate&&m.inReplyTo===saved.inputId);assert.equal(final.length,1)
 const btask=await store.get(b.childTaskId);assert.equal(btask.sharedInformation.length,1);assert.ok(!btask.parameters.tools.includes('task_assign'))
})
