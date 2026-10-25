import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {openTaskStore} from './tasks.mjs'
import {listBots} from './bots.mjs'
import {issueConfig,issueModel} from './fixtures/group-issues-model.mjs'
async function until(fn,p=x=>x){for(let i=0;i<900;i++){const v=await fn();if(p(v))return v;await new Promise(r=>setTimeout(r,10))}throw Error('recovery timeout')}
for(const phase of ['blocker','approval','review'])test(`group original ${phase} SIGKILL same-database recovery retains identity, decisions, revisions and action effect`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pidot-issues-kill-'));let s
 const child=spawn(process.execPath,[new URL('./fixtures/group-issues-process.mjs',import.meta.url).pathname,dir,phase],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',x=>errors+=x);const exited=once(child,'exit')
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}if(s)await s.close();await rm(dir,{recursive:true,force:true})})
 const saved=await until(async()=>{if(child.exitCode!==null)throw Error(errors);try{return JSON.parse(await readFile(join(dir,'checkpoint.json'),'utf8'))}catch{return null}})
 child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL')
 s=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(issueConfig),modelReply:issueModel})
 let p=await s.get(saved.taskId);assert.equal(p.groupId,saved.groupId);assert.equal(p.groupIssues[0].taskId,saved.childTaskId)
 if(phase==='blocker'){const b=p.groupIssues[0].blockers.items.find(b=>b.assignee==='user');assert.equal(b.id,saved.blocker.id);await s.resolveBlocker(saved.childTaskId,b.id,{answer:'用户选下午',version:b.version,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo})}
 if(phase!=='review'){p=await until(()=>s.get(saved.taskId),p=>p.groupIssues[0].approvals.activeId);const a=p.groupIssues[0].approvals.items[0];if(phase==='approval')assert.equal(a.id,saved.approvalId);await s.decideApproval(saved.childTaskId,a.id,{decision:'approved'})}
 p=await until(()=>s.get(saved.taskId),p=>p.activeInputId===null&&p.collaborations[0].businessStatus==='accepted')
 const r=p.collaborations[0],c=p.groupIssues[0];assert.equal(r.childTaskId,saved.childTaskId);assert.equal(r.revisions.length,2);assert.equal(r.decisions.length,2);assert.equal(r.acceptedRevision,2);assert.equal(c.approvals.items.length,1);assert.equal(c.approvals.items[0].status,'executed');assert.equal(c.blockers.items.length,2);assert.equal(c.blockers.items[1].answer.source,'authenticated-user');assert.equal((await s.list()).length,2)
})
