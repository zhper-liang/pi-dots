import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {openTaskStore} from './tasks.mjs'
import {listBots} from './bots.mjs'
import {issueConfig,issueModel} from './fixtures/group-issues-model.mjs'
async function until(fn,p=Boolean){for(let i=0;i<1000;i++){const v=await fn();if(p(v))return v;await new Promise(r=>setTimeout(r,10))}throw Error('joint recovery timeout')}
test('joint accepted SIGKILL: revisions, executed approval, usage and original identities survive; next root stays isolated',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pidot-issues-kill-'));let s
 const child=spawn(process.execPath,[new URL('./fixtures/group-issues-process.mjs',import.meta.url).pathname,dir,'accepted'],{stdio:['ignore','pipe','pipe']})
 let errors='';child.stderr.on('data',x=>errors+=x);const exited=once(child,'exit')
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}if(s)await s.close();await rm(dir,{recursive:true,force:true})})
 const saved=await until(async()=>{if(child.exitCode!==null)throw Error(errors);try{return JSON.parse(await readFile(join(dir,'checkpoint.json'),'utf8'))}catch{return null}})
 child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL')
 let replayed=0
 s=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(issueConfig),modelReply:async(m,o)=>{replayed++;return issueModel(m,o)}})
 const p=await s.get(saved.taskId),c=await s.get(saved.childTaskId)
 assert.equal(p.groupId,saved.groupId);assert.equal(p.conversationId,saved.conversationId);assert.equal(c.conversationId,saved.childConversationId)
 assert.deepEqual(p.collaborations,saved.collaborations);assert.deepEqual(p.collaborationOverview.totals,saved.totals)
 assert.equal(p.collaborations[0].acceptedRevision,2);assert.equal(c.approvals.items[0].status,'executed');assert.equal(c.approvals.items.length,1)
 assert.equal(replayed,0)
 const retry=await s.send(p.taskId,{message:'执行问题审批返工',targetBotId:'calendar',requestId:'issues-kill-input'})
 assert.equal(retry.messageId,saved.inputId);assert.equal(replayed,0)
 const {task:other}=await s.createGroup({requestId:'joint06-other-group',title:'第二群隔离',adminBotId:'todo',memberBotIds:['todo','calendar']})
 const privateTask=await s.create({botId:'todo',title:'私聊隔离'})
 assert.equal(other.collaborations.length,0);assert.equal(privateTask.collaborations.length,0);assert.equal(other.messages.length,0);assert.equal(privateTask.messages.length,0)
 await assert.rejects(s.send(p.taskId,{message:'无效目标',targetBotId:['calendar','todo'],requestId:'joint06-invalid'}),e=>e.status===400)
 assert.deepEqual((await s.get(p.taskId)).collaborations,saved.collaborations)
 await s.send(p.taskId,'下一轮普通输入，仅主管直接回复')
 const next=await until(()=>s.get(p.taskId),p=>p.activeInputId===null&&p.queueLength===0)
 assert.equal(next.conversationId,saved.conversationId);assert.deepEqual(next.collaborations,saved.collaborations)
 assert.equal(next.messages.filter(m=>m.role==='user').length,2);assert.ok(replayed>0)
 const usage=structuredClone(next.collaborationOverview.totals)
 await s.close();s=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(issueConfig),modelReply:issueModel})
 assert.deepEqual((await s.get(p.taskId)).collaborationOverview.totals,usage)
})
