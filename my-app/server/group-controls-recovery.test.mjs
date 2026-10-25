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
async function until(fn,p=x=>x){for(let i=0;i<900;i++){const v=await fn();if(p(v))return v;await new Promise(r=>setTimeout(r,10))}throw Error('control recovery timeout')}
for(const phase of ['plain','root','single'])test(`group ${phase} control SIGKILL keeps same conversation, consumes next input once and never revives stopped work`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pidot-controls-kill-'));let s
 const child=spawn(process.execPath,[new URL('./fixtures/group-controls-process.mjs',import.meta.url).pathname,dir,phase],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',x=>errors+=x);const exited=once(child,'exit')
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}if(s)await s.close();await rm(dir,{recursive:true,force:true})})
 const saved=await until(async()=>{if(child.exitCode!==null)throw Error(errors);try{return JSON.parse(await readFile(join(dir,'checkpoint.json'),'utf8'))}catch{return null}})
 child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL')
 s=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(issueConfig),modelReply:issueModel})
 const p=await until(()=>s.get(saved.taskId),p=>p.activeInputId===null&&p.queueLength===0&&(!saved.childTaskId||p.collaborations[0].businessStatus==='cancelled'))
 assert.equal(p.groupId,saved.groupId);assert.equal(p.cancellation,null);assert.equal(p.messages.filter(m=>m.role==='user'&&m.content==='后续独立消息').length,1)
 assert.equal(p.messages.filter(m=>m.role==='assistant'&&m.inReplyTo===p.messages.find(m=>m.content==='后续独立消息').id).length,1)
 if(saved.childTaskId){assert.equal(p.collaborations.length,1);assert.equal(p.collaborations[0].childTaskId,saved.childTaskId);assert.equal((await s.get(saved.childTaskId)).runtime.status,'terminal')}
 if(phase!=='single')assert.equal(p.collaborationOverview.stops.length,1)
 const usage=structuredClone(p.collaborationOverview.totals),rels=structuredClone(p.collaborations)
 await s.close();s=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(issueConfig),modelReply:issueModel})
 assert.deepEqual((await s.get(saved.taskId)).collaborationOverview.totals,usage);assert.deepEqual((await s.get(saved.taskId)).collaborations,rels)
})
