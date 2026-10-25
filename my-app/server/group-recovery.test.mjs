import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openTaskStore} from './tasks.mjs'
import {listBots} from './bots.mjs'
const input={requestId:'group-kill-request',title:'群恢复夹具',adminBotId:'todo',memberBotIds:['todo','calendar']}
const config={baseUrl:'https://fixture.invalid/v1',model:'group-recovery',apiKey:'fixture-only'}
async function until(fn,check=Boolean){for(let n=0;n<800;n++){const v=await fn();if(check(v))return v;await new Promise(r=>setTimeout(r,10))}throw Error('Group recovery timeout')}
for(const phase of ['before-create','created','inflight','replied'])test(`group SIGKILL ${phase}: atomic creation/input and stable identity with no blind model replay`,{timeout:20000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pidot-group-kill-'))
 const child=spawn(process.execPath,[new URL('./fixtures/group-recovery-process.mjs',import.meta.url).pathname,dir,phase],{stdio:['ignore','pipe','pipe']})
 let output='';child.stdout.on('data',v=>{output+=v});child.stderr.on('data',v=>{output+=v});const exited=once(child,'exit')
 let store;t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}if(store)await store.close();await rm(dir,{recursive:true,force:true})})
 const saved=await until(async()=>{if(child.exitCode!==null)throw Error(output);try{return JSON.parse(await readFile(join(dir,'checkpoint.json'),'utf8'))}catch{return null}})
 child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL')
 let calls=0;store=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(config),modelReply:async()=>{calls++;return {mode:'model',reply:{content:'恢复后新消息'},execution:{usage:{totalTokens:4}}}}})
 const recreated=await store.createGroup(phase==='inflight'?{...input,parameters:{callLimits:{modelCalls:1,toolCalls:0,totalTokens:1000}}}:input);assert.equal(recreated.created,phase==='before-create')
 assert.equal((await store.listGroups()).length,1)
 if(phase!=='before-create'){assert.equal(recreated.task.taskId,saved.taskId);assert.equal(recreated.task.conversationId,saved.conversationId);assert.equal(recreated.group.groupId,saved.group.groupId)}
 const state=await until(()=>store.get(recreated.task.taskId),v=>v.activeInputId===null)
 assert.equal(calls,0)
 if(phase==='inflight'){
  assert.equal(state.messages.filter(m=>m.role==='user').length,1)
  assert.ok(state.messages.some(m=>m.role==='error'));assert.equal(state.waiting.kind,'limits')
  assert.equal(state.callUsage.modelCalls,1);assert.equal(state.callUsage.unknownTokenCalls,1)
  assert.ok(state.recoveryHistory.length)
 }
 if(phase==='replied')assert.equal(state.messages.filter(m=>m.role==='assistant'&&m.inReplyTo===saved.messageId).length,1)
 if(phase!=='inflight'){
  await store.send(state.taskId,'重启后继续')
  const done=await until(()=>store.get(state.taskId),v=>v.activeInputId===null&&v.messages.some(m=>m.content==='恢复后新消息'))
  assert.equal(calls,1);assert.equal(done.kind,'group')
 }
})
