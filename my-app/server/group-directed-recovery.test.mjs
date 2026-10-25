import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openTaskStore} from './tasks.mjs'
import {listBots} from './bots.mjs'
const config={baseUrl:'https://fixture.invalid/v1',model:'directed-recovery',apiKey:'fixture-only'}
const text=content=>({mode:'model',reply:{content},execution:{usage:{totalTokens:5}}})
async function until(fn,check=Boolean){for(let i=0;i<1200;i++){const r=await fn();if(check(r))return r;await new Promise(r=>setTimeout(r,10))}throw Error('Recovery timeout')}
for(const phase of ['before-dispatch','dispatched','collected'])test(`group directed SIGKILL ${phase}: one relation/fork/input and original reply binding`,{timeout:25000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pidot-directed-kill-'));let s
 const child=spawn(process.execPath,[new URL('./fixtures/group-directed-process.mjs',import.meta.url).pathname,dir,phase],{stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',x=>output+=x);const exited=once(child,'exit')
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}if(s)await s.close();await rm(dir,{recursive:true,force:true})})
 const saved=await until(async()=>{if(child.exitCode!==null)throw Error(output);try{return JSON.parse(await readFile(join(dir,'checkpoint.json'),'utf8'))}catch{return null}});child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL')
 let calls=0;s=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(config),modelReply:async(_m,o)=>{
  calls++;if(o.parametersBotId==='calendar')return text('恢复专业结果')
  const task=await s.get(saved.taskId),r=task.collaborations[0]
  if(r?.businessStatus==='submitted'){const call={type:'toolCall',id:`review-${calls}`,name:'task_review',arguments:{operationId:'recover-accept',childTaskId:r.childTaskId,rootWorkId:r.rootWorkId,revision:r.result.revision,expectedState:'submitted',decision:'accept',reason:'核对恢复产物'}};return {...text(''),toolCalls:[call],assistant:{role:'assistant',content:[call],api:'openai-completions',provider:'fixture',model:config.model,stopReason:'toolUse',timestamp:Date.now()}}}
  return text('恢复主管回报')
 }})
 const done=await until(()=>s.get(saved.taskId),v=>v.activeInputId===null&&v.collaborations[0]?.businessStatus==='accepted')
 assert.equal(done.collaborations.length,1);const r=done.collaborations[0];assert.equal(r.parentInputId,saved.messageId);assert.equal(r.forkAnchor,saved.messageId)
 assert.equal(done.messages.filter(m=>m.role==='user').length,1);assert.equal(done.messages.filter(m=>m.role==='assistant'&&!m.intermediate&&!m.assistant).length,1)
 const exec=await s.get(r.childTaskId);assert.equal(exec.messages.filter(m=>m.role==='user').length,1)
 assert.equal(r.revisions.length,1);assert.ok(r.consumedEntryId);assert.equal(r.decisions.length,1)
 assert.equal(exec.callUsage.modelCalls,phase==='dispatched'?2:1)
 const retry=await s.send(saved.taskId,{message:'恢复时只执行一个目标',targetBotId:'calendar',requestId:'kill-directed-input'});assert.equal(retry.messageId,saved.messageId)
 assert.ok(calls>0)
})
