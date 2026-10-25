// Cross-capability, hard-process recovery evidence; not real-provider evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {setTimeout as delay} from 'node:timers/promises'
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context'
import {openTaskStore} from './tasks.mjs'
import {MockCalendar} from './approvals.mjs'
import {listBots} from './bots.mjs'
import {config,driver} from './fixtures/collaboration-joint-driver.mjs'
async function until(read,check){for(let n=0;n<1600;n++){const v=await read();if(check(v))return v;await delay(10)}assert.fail('joint boundary timeout')}
for(const boundary of ['assigned','answered','effect','submitted','accepted'])test(`06 composed SIGKILL ${boundary}: bound blockers, exact action, shared source, same-child rework and accepted results`,{timeout:40000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pidot-joint-06-')),file=join(dir,'test.sqlite');let s
 const child=spawn(process.execPath,[new URL('./fixtures/collaboration-joint-process.mjs',import.meta.url).pathname,dir,boundary],{stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',v=>output+=v);const exited=once(child,'exit')
 t.after(async()=>{child.kill('SIGKILL');if(s)await s.close();await rm(dir,{recursive:true,force:true})})
 const saved=await until(async()=>{try{return JSON.parse(await readFile(join(dir,'checkpoint.json'),'utf8'))}catch{return null}},Boolean)
 child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL',output)
 s=await openTaskStore({file,bots:listBots(config),modelReply:driver(()=>s)})
 const done=await until(async()=>{const p=await s.get(saved.parentTaskId),r=p.collaborations[0];if(r){const c=await s.get(r.childTaskId),b=c.blockers.items.find(b=>b.status==='pending'&&b.assignee==='user');if(b)await s.resolveBlocker(c.taskId,b.id,{answer:'JOINT-06',version:b.version,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo});const a=c.approvals.items.find(a=>!a.decision);if(a)await s.decideApproval(c.taskId,a.id,{decision:'approved'})}return p},asyncBoolean)
 function asyncBoolean(p){return p.collaborations.length===2&&p.collaborations.every(r=>r.businessStatus==='accepted')&&p.activeInputId===null}
 const [a,b]=done.collaborations,executor=await s.get(a.childTaskId),advisor=await s.get(b.childTaskId)
 assert.equal(a.rootWorkId,b.rootWorkId);assert.notEqual(executor.conversationId,advisor.conversationId)
 assert.equal(a.revisions.length,2);assert.equal(a.reworkCount,1);assert.equal(a.acceptedRevision,2);assert.equal(a.decisions.length,2)
 assert.equal(executor.blockers.items.length,2);assert.equal(executor.blockers.items[0].answer.source,'supervisor');assert.equal(executor.blockers.items[1].answer.source,'authenticated-user')
 assert.equal(executor.approvals.items.length,1);assert.equal(executor.approvals.items[0].decision.source,'authenticated-user');assert.equal(executor.approvals.items[0].receipt.result.ok,true)
 assert.equal(executor.approvals.items[0].inReplyTo,a.childInputId)
 assert.ok(advisor.messages.some(m=>m.toolName==='shared_read'&&m.result.ok&&m.result.data.records[0].source.taskId===executor.taskId))
 const cal=JSON.parse(JSON.stringify(await s.harness.snapshot(MockCalendar,undefined,context)));assert.equal(cal.revision,1);assert.equal(Object.keys(cal.operations).length,1)
 assert.equal(executor.messages.filter(m=>m.toolName==='calendar_reschedule_event').length,1)
 const stable=v=>JSON.parse(JSON.stringify(v,(k,x)=>k==='status'&&['pending','running'].includes(x)?'resumable':x))
 const before=await s.get(done.taskId),beforeChild=await s.get(executor.taskId);await s.close();s=undefined
 let calls=0;s=await openTaskStore({file,bots:listBots(config),modelReply:async()=>{calls++;throw Error('accepted work must not redispatch')}});await delay(60)
 assert.deepEqual(stable(await s.get(done.taskId)),stable(before));assert.deepEqual(stable(await s.get(executor.taskId)),stable(beforeChild));assert.equal(calls,0);assert.equal((await s.list()).length,3)
})
