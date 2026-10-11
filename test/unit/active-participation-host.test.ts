import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActiveParticipationHost } from '../../src/runtime/participation/ActiveParticipationHost.js'
import { isParticipationRun } from '../../src/agent/participation/ParticipationRun.js'
import { normalizeGuobaConfigValue } from '../../src/runtime/guoba-config.js'
import type { YunzaiMessageEvent } from '../../src/runtime/agent-service-bridge.js'

function harness () {
  let now=1000,sequence=0,enabled=true
  const config={participationMode:'active',participationActiveGroups:['303']}
  const host=new ActiveParticipationHost(()=>now,()=>config,()=> '101',()=>enabled)
  const event=(msg='下一步怎么办？',extra:Partial<YunzaiMessageEvent>={}):YunzaiMessageEvent=>({
    isGroup:true,group_id:303,user_id:202,sender:{user_id:202},message_id:++sequence,msg,message:[],...extra
  })
  return {host,config,event,advance:(ms:number)=>{now+=ms},disable:()=>{enabled=false},enable:()=>{enabled=true}}
}

test('active host preserves legacy outside pilot and rejects cold sampling and counterfeit selections',async()=>{
  const h=harness()
  assert.equal(h.host.select(h.event(),false,true),null)
  assert.equal(h.host.select(h.event('其他群',{group_id:404}),true,true),undefined)
  h.config.participationActiveGroups=[]
  assert.equal(h.host.select(h.event(),true,true),undefined)
  h.config.participationActiveGroups=['303']
  const run=h.host.select(h.event(),true,false)
  assert(run&&isParticipationRun(run))
  assert.equal(isParticipationRun(JSON.parse(JSON.stringify(run))),false)
  assert.equal(run.admission,'queue')
  await assert.rejects(run.checkBoundary('provider',new AbortController().signal),/not admitted/)
})

test('only admitted delivered replies establish same actor continuation; thanks and other at targets stay silent',async()=>{
  const h=harness(),run=h.host.select(h.event(),true,false)
  assert(run);run.admit()
  await run.checkBoundary('provider',new AbortController().signal)
  run.finish(true)
  const next=h.host.select(h.event(),false,false)
  assert(next);assert.equal(next.admission,'immediate');next.finish(false)
  assert.equal(h.host.select(h.event('谢谢！'),false,true),null)
  assert.equal(h.host.select(h.event('下一步怎么办？',{message:[{type:'at',qq:999}]}),false,true),null)
  assert.equal(h.host.select(h.event('另一人',{user_id:505,sender:{user_id:505}}),false,false),null)
  h.advance(120000)
  assert.equal(h.host.select(h.event(),false,true),null)
})

test('unknown delivery establishes no continuation and stale passive work fails all four boundaries',async()=>{
  const h=harness(),unknown=h.host.select(h.event(),true,false)
  assert(unknown);unknown.admit();unknown.finish(false)
  assert.equal(h.host.select(h.event(),false,false),null)
  const prime=h.host.select(h.event(),true,false);assert(prime);prime.admit();prime.finish(true)
  const passive=h.host.select(h.event(),false,false);assert(passive);passive.admit()
  h.advance(15000)
  for(const boundary of ['provider','tool','response','final'] as const) {
    await assert.rejects(passive.checkBoundary(boundary,new AbortController().signal),/当前参与请求已失效/)
  }
})

test('pilot removal, mode disable and eligibility loss cannot revive old runs after restoration',async()=>{
  for(const cause of ['pilot','mode','eligibility']) {
    const h=harness(),run=h.host.select(h.event(),true,false);assert(run);run.admit()
    if(cause==='pilot')h.config.participationActiveGroups=[]
    if(cause==='mode')h.config.participationMode='legacy'
    if(cause==='eligibility')h.disable()
    await assert.rejects(run.checkBoundary('response',new AbortController().signal))
    h.config.participationActiveGroups=['303'];h.config.participationMode='active';h.enable()
    await assert.rejects(run.checkBoundary('final',new AbortController().signal))
    const fresh=h.host.select(h.event(),true,false);assert(fresh);fresh.admit()
    await fresh.checkBoundary('provider',new AbortController().signal)
    h.host.close()
    await assert.rejects(fresh.checkBoundary('final',new AbortController().signal))
  }
})

test('active pilot configuration rejects wildcards, duplicates, overflow and coercion',()=>{
  assert.deepEqual(normalizeGuobaConfigValue('participationActiveGroups',[]),[])
  assert.deepEqual(normalizeGuobaConfigValue('participationActiveGroups',['303']),['303'])
  for(const invalid of ['*',[303],['0'],['303','303'],Array.from({length:65},(_,n)=>String(n+1))]) {
    assert.throws(()=>normalizeGuobaConfigValue('participationActiveGroups',invalid))
  }
})

test('ordinary and BYM selection share one message route before and after successful delivery', () => {
  const h = harness(), e = h.event(), run = h.host.selectOrdinary(e)
  assert(run)
  assert.equal(h.host.select(e, true, true), null)
  assert.equal(h.host.selectOrdinary(e), null)
  // A new explicit message remains an ordinary queued request while an earlier candidate owns qualification.
  const queued = h.event()
  assert.equal(h.host.selectOrdinary(queued), undefined)
  assert.equal(h.host.select(queued, true, true), null)
  run.admit(); run.finish(true)
  assert.equal(h.host.select(e, true, true), null)
  const next = h.host.select(h.event(), false, false); assert(next); next.finish(false)
  h.host.close()
})
