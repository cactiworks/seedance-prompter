import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenRuntime } from '../../src/server/gen/runtime.ts';
import { GenError, type GenProvider } from '../../src/server/gen/provider.ts';
import { GenJobSchema } from '../../src/core/model/media.ts';
import { createStore } from '../../src/server/storage/fsStore.ts';
import { FlowSchema } from '../../src/core/model/canvas.ts';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function fixture(){
  const dataDir=await mkdtemp(path.join(tmpdir(),'seedance-quote-'));dirs.push(dataDir);let time=0;
  const estimate=vi.fn(async(_endpoint:string,_input:Record<string,unknown>)=>({credits:42,usd:0.21})); const submit=vi.fn(async(_endpoint:string,_input:Record<string,unknown>)=> 'task-1');const upload=vi.fn(async()=> 'https://fixture.invalid/photo.png');
  const poll=vi.fn(async()=>({state:'running' as const,providerState:'running',urls:[],creditsConsumed:null,failMsg:null}));
  const provider:GenProvider={id:'higgsfield',hasKey:()=>true,estimate,submit,upload,poll,freshUrl:async()=>null,balance:async()=>0};
  const kie={...provider,id:'kie' as const,poll:vi.fn(poll)};
  const gen=createGenRuntime({dataDir,providers:{higgsfield:provider,kie},now:()=>time});
  const request={modelId:'higgsfield/seedance-2-5',prompt:'The hand closes the book.',params:{resolution:'480p',durationSec:6,aspectRatio:'9:16',audio:true},confirmCredits:42};
  return {gen,provider,kie,request,estimate,submit,upload,dataDir,advance:(ms:number)=>{time+=ms;}};
}
describe('Higgsfield Seedance quote contract',()=>{
  it('all endpoints and exact quote input; one quote authorizes only one dispatch',async()=>{
    const f=await fixture();const q=await f.gen.quote(f.request);expect(f.submit).not.toHaveBeenCalled();
    const body={...f.request,quoteId:q.quoteId};const results=await Promise.allSettled([f.gen.submit(body),f.gen.submit(body)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.submit).toHaveBeenCalledTimes(1);expect(f.estimate).toHaveBeenCalledTimes(2);
    expect(f.submit.mock.calls[0]).toEqual(['bytedance/seedance-2.5/text-to-video',{prompt:f.request.prompt,resolution:'480p',duration:6,aspect_ratio:'9:16',generate_audio:true,output_format:'mp4'}]);
  });
  it.each(['credits','usd'] as const)('price changed (%s) blocks dispatch',async field=>{
    const f=await fixture();const q=await f.gen.quote(f.request);f.estimate.mockResolvedValue({credits:42,usd:0.21,[field]:99});
    await expect(f.gen.submit({...f.request,quoteId:q.quoteId})).rejects.toMatchObject({code:'COST_CHANGED'});expect(f.submit).not.toHaveBeenCalled();
  });
  it('missing/unavailable estimate and invalid input never create jobs',async()=>{
    const f=await fixture();await expect(f.gen.submit(f.request)).rejects.toMatchObject({code:'QUOTE_REQUIRED'});
    await expect(f.gen.quote({...f.request,params:{...f.request.params,resolution:'4K'}})).rejects.toMatchObject({code:'INVALID'});
    f.estimate.mockRejectedValue(new GenError('PROVIDER','offline'));await expect(f.gen.quote(f.request)).rejects.toThrow('offline');expect(await f.gen.jobs.all()).toEqual([]);expect(f.submit).not.toHaveBeenCalled();
  });
  it('expired, changed, or restarted quotes require a new confirmation',async()=>{
    const f=await fixture();const q=await f.gen.quote(f.request);
    await expect(f.gen.submit({...f.request,prompt:'changed',quoteId:q.quoteId})).rejects.toMatchObject({code:'QUOTE_REQUIRED'});
    f.advance(600001);await expect(f.gen.submit({...f.request,quoteId:q.quoteId})).rejects.toMatchObject({code:'QUOTE_REQUIRED'});expect(f.submit).not.toHaveBeenCalled();
  });
  it('lost submission is unknown, consumed quote cannot spend again, tick never resubmits',async()=>{
    const f=await fixture();const q=await f.gen.quote(f.request);f.submit.mockRejectedValue(new GenError('PROVIDER','lost response'));
    const {jobs}=await f.gen.submit({...f.request,quoteId:q.quoteId});expect(jobs[0]!.status).toBe('unknown');
    await expect(f.gen.submit({...f.request,quoteId:q.quoteId})).rejects.toMatchObject({code:'QUOTE_REQUIRED'});f.advance(60000);await f.gen.tick();expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it('image-to-video consent, ratio and bytes are bound to quote; uploads reused on dispatch',async()=>{
    const f=await fixture();const store=createStore(f.dataDir);const bytes=await readFile(path.resolve(import.meta.dirname,'../../src/web/public/production-mock/shot-1.png'));await store.writeRef('photo','frame.png',bytes);
    const body={...f.request,refs:[{source:{type:'projectRef',slug:'photo',file:'frame.png'},role:'start'}]};
    await expect(f.gen.quote(body)).rejects.toMatchObject({code:'REFS_CONSENT'});expect(f.upload).not.toHaveBeenCalled();
    const {imageSize}=await import('../../src/server/gen/imageSize.ts');const size=imageSize(bytes)!;const aspect=size.width>size.height?'16:9':'9:16';
    const request={...body,refsConsent:true,params:{...body.params,aspectRatio:aspect}};
    const q=await f.gen.quote(request);expect(f.estimate.mock.calls[0]![0]).toBe('bytedance/seedance-2.5/image-to-video');
    await f.gen.submit({...request,quoteId:q.quoteId});expect(f.upload).toHaveBeenCalledTimes(1);expect(f.submit.mock.calls[0]![1]).not.toHaveProperty('aspect_ratio');
    const again=await f.gen.quote(request);await store.writeRef('photo','frame.png',new Uint8Array([1,2,3]));await expect(f.gen.submit({...request,quoteId:again.quoteId})).rejects.toMatchObject({code:'QUOTE_REQUIRED'});
  });
  it('requires separate tariff consent and stores approximate USD as USD, never as credits',async()=>{
    const f=await fixture();f.provider.estimate=async()=>({credits:0.8224,usd:0.8224,unitRu:'$',approximate:true,pricingNote:'16:9 tariff',pricingDescription:'fixture tariff v1'});
    let q=await f.gen.quote(f.request);expect(q.estimate).toMatchObject({approximate:true,unitRu:'$',usd:0.8224});
    await expect(f.gen.submit({...f.request,confirmCredits:0.8224,quoteId:q.quoteId})).rejects.toMatchObject({code:'APPROXIMATE_CONSENT'});
    expect(f.submit).not.toHaveBeenCalled();expect(await f.gen.jobs.all()).toEqual([]);
    q=await f.gen.quote(f.request);
    const {jobs}=await f.gen.submit({...f.request,confirmCredits:0.8224,quoteId:q.quoteId,acceptApproximate:true});
    expect(jobs[0]).toMatchObject({estimateUnit:'$',approximate:true,estimateUsd:0.8224});
    const {mediaCostLabel}=await import('../../src/core/gen/models.ts');expect(mediaCostLabel(jobs[0]!,jobs[0]!.estimateCredits)).toBe('$0.8224');
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it('reconfirms a changed pricing description even when the displayed rate is unchanged',async()=>{
    const f=await fixture();f.provider.estimate=async()=>({credits:1,usd:1,unitRu:'$',approximate:true,pricingDescription:'tariff v1'});
    const q=await f.gen.quote(f.request);
    f.provider.estimate=async()=>({credits:1,usd:1,unitRu:'$',approximate:true,pricingDescription:'tariff v2'});
    await expect(f.gen.submit({...f.request,confirmCredits:1,quoteId:q.quoteId,acceptApproximate:true})).rejects.toMatchObject({code:'COST_CHANGED'});expect(f.submit).not.toHaveBeenCalled();
  });
  it('legacy KIE history polls KIE; new legacy-id dispatch is rejected; imported nodes migrate',async()=>{
    const f=await fixture();const job=GenJobSchema.parse({id:'j-legacy123',createdAt:'2026-10-01',updatedAt:'2026-10-01',modelId:'kie/seedance-2-5',provider:'kie',providerModel:'bytedance/seedance-2-5',kind:'video',prompt:'old',params:{},refs:[],origin:null,estimateCredits:112,estimateUsd:0.56,status:'queued',taskId:'old-task',providerState:null,creditsConsumed:null,resultUrls:[],mediaIds:[],error:null,polls:0,pollingSince:0,nextCheckAt:0,downloadAttempts:0,finishedAt:null});
    await f.gen.jobs.put(job);await f.gen.tick();expect(f.kie.poll).toHaveBeenCalledWith('old-task');expect((await f.gen.jobs.get(job.id))?.provider).toBe('kie');
    await expect(f.gen.submit({...f.request,modelId:job.modelId})).rejects.toMatchObject({code:'MODEL_MOVED'});expect(f.submit).not.toHaveBeenCalled();
    const flow=FlowSchema.parse({id:'f-imported',name:'old',createdAt:'',updatedAt:'',nodes:[{id:'g1',type:'generator',modelId:job.modelId,x:0,y:0}],edges:[]});expect(flow.nodes[0]!.modelId).toBe('higgsfield/seedance-2-5');
  });
});
