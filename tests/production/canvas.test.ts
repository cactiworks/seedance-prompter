import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, copyFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newRun, completePreparation } from '../../src/core/production/engine.ts';
import { CreateRunSchema, DEMO_INPUT } from '../../src/core/production/model.ts';
import { withShotIds } from '../../src/core/production/plan.ts';
import { formOf, formProblems, applyForm } from '../../src/core/production/seriesForm.ts';
import { type Project, type SeriesForm } from '../../src/core/model/project.ts';
import { createProductionCanvas } from '../../src/server/production/canvas.ts';
import type { ProductionRuntime } from '../../src/server/production/runtime.ts';
import { createGenRuntime } from '../../src/server/gen/runtime.ts';
import { createFlows } from '../../src/server/storage/flows.ts';
import { createStore } from '../../src/server/storage/fsStore.ts';
import { createApp, HOST, PORT } from '../../src/server/app.ts';
import { buildShot, type PackBundle } from '../../src/core/pipeline.ts';
import type { Runner } from '../../src/server/llm/tasks/write.ts';
import type { LlmRequest } from '../../src/server/llm/codexCli/provider.ts';
import { SCRIPT, sceneDraft, promptPlan } from './fixtures.ts';
const readBarrier=vi.hoisted(()=>({file:'',afterRead:undefined as undefined | (()=>Promise<void>)}));
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof FsPromises>();
  return {...actual,readFile:async(...args:Parameters<typeof actual.readFile>)=>{
    const result=await actual.readFile(...args);
    if(String(args[0])===readBarrier.file && readBarrier.afterRead){const pause=readBarrier.afterRead;readBarrier.afterRead=undefined;await pause();}
    return result;
  }};
});
const rootDir = path.resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive:true, force:true }))); });
const ready = { readback: [], findings: [], verdict:'ready', summaryRu:'Кадр согласован с серией.' };
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'series-canvas-')); dirs.push(dataDir);
  const gen = createGenRuntime({ dataDir, providers:{} });
  const submit = vi.spyOn(gen, 'submit');
  const source = path.join(dataDir, 'photo.png'); await copyFile(path.join(rootDir, 'src/web/public/production-mock/shot-1.png'), source);
  const media = await gen.library.importFile(source, 'png', { jobId:'fixture', taskId:null, kind:'image', provider:'local', modelId:'local/import', providerModel:'', prompt:'Photo', params:{}, refs:[], origin:null, sessionId:null, index:0, sourceUrl:'', creditsConsumed:null, createdAt:new Date().toISOString() });
  const base = newRun('pr-series-fixture', CreateRunSchema.parse({ ...DEMO_INPUT, mode:'photos', planningMode:'codex', script:SCRIPT }), Date.now(), 1);
  base.scenePlan = withShotIds(sceneDraft()); base.promptPlan = promptPlan();
  const run = completePreparation(base, Date.now(), 1);
  run.shots.forEach((s, i) => {
    const id = `photo-${i}`; s.photoId=id; if (i===0) s.acceptedPhotoId=id;
    run.artifacts.push({ id, shotId:s.id, kind:'photo', version:1, sourceId:null, url:`/api/library/${media.id}/file`, poster:'', prompt:`source ${i}`, model:'Soul 2', taskId:'fixture', createdAt:new Date().toISOString(), qc:'pass', qcNote:'', note:'', cost:0, mediaId:media.id });
  });
  const production = { get:async () => structuredClone(run) } as unknown as ProductionRuntime;
  const flows=createFlows(dataDir); const store=createStore(dataDir);
  const app=createApp({ rootDir, dataDir, production, gen, reveal:false });
  const pack=await (await app.request('/api/packs/cinema-doc', { headers:{ host:`${HOST}:${PORT}` } })).json() as PackBundle;
  const options={ rootDir,dataDir,flows,store,production,gen,pack:()=>pack, vision:async () => ({ mediaType:'image/png' as const, base64:'test-photo' }) };
  const service=createProductionCanvas(options);
  const flow=await service.handoff(run.id); const node=flow.nodes.find(n=>n.type==='seedance')!;
  return { run,gen,submit,flows,store,service,flow,node,pack,options };
}
function filled(p: Project): SeriesForm {
  const f=formOf(p);
  f.world.place={ru:'Комната у окна',en:'a room beside a window',source:'llm',locked:false};
  f.world.weather={ru:'Мягкий дневной свет',en:'Soft daylight falls across the wooden table.',source:'llm',locked:false};
  f.shot.durationSec=6; f.shot.synopsisRu='Рука закрывает блокнот.';
  f.shot.segments=[{ id:'seg-1',titleRu:'Закрывает блокнот',beatsRu:'Рука закрывает блокнот. Слышен шелест бумаги; рука остаётся на обложке.',text:{ru:'',en:'A hand closes the notebook. A cloud passes and light shifts. Paper rustles softly off-screen, then sound fades. The camera holds on the hand in stillness and lowers slightly.',source:'llm',locked:false},frameRef:p.shots[0]!.panel[0]! }];
  return f;
}
function runner(answers: unknown[]) {
  const requests:LlmRequest[]=[];
  const run:Runner=async <T>(request:LlmRequest) => {
    requests.push(request); const next=answers.shift();
    if(next instanceof Error) throw next;
    const data=typeof next==='function' ? await next(request) : next;
    return { data:data as T,meta:{model:'fixture',durationMs:1,inputTokens:1,outputTokens:1,turns:1} };
  };
  return { run,requests };
}
async function finished(f: Awaited<ReturnType<typeof fixture>>) {
  let value=await f.service.inspect(f.node.slug);
  for(let n=0;value.state?.status==='running' && n<300;n++){ await new Promise(r=>setTimeout(r,5)); value=await f.service.inspect(f.node.slug); }
  expect(value.state?.status).not.toBe('running'); return value;
}
describe('Production Canvas preparation without media submission',()=>{
  it('an unchanged handoff does not advance revision or conflict with an open Canvas', async () => {
    const f=await fixture();
    const again=await f.service.handoff(f.run.id);
    expect(again.rev).toBe(f.flow.rev);
    await expect(f.flows.save(f.flow.id,{...f.flow,name:'Manual title'})).resolves.toMatchObject({name:'Manual title'});
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('one flow for a partial series; repeat/add preserves layout and manual drafts under concurrent handoffs', async()=>{
    const f=await fixture(); expect(f.flow.nodes).toHaveLength(2);
    await f.flows.save(f.flow.id,{...f.flow,nodes:f.flow.nodes.map(n=>({...n,x:777}))});
    const p=await f.store.read(f.node.slug); p.world.place.ru='Ручное место'; await f.store.write(p.slug,p,p.rev);
    f.run.shots[1]!.acceptedPhotoId=f.run.shots[1]!.photoId;
    await Promise.all([f.service.handoff(f.run.id),f.service.handoff(f.run.id)]);
    const flow=(await f.flows.get(f.flow.id))!;
    expect((await f.flows.list())).toHaveLength(1); expect(flow.nodes).toHaveLength(4); expect(flow.nodes[0]!.x).toBe(777);
    expect((await f.store.read(p.slug)).world.place.ru).toBe('Ручное место'); expect(f.submit).not.toHaveBeenCalled();
  });
  it('full series and actual photo reach fill and critic; handheld location compiles; unselected branch stays empty',async()=>{
    const f=await fixture(); f.run.shots[1]!.acceptedPhotoId=f.run.shots[1]!.photoId; const flow=await f.service.handoff(f.run.id);
    const p=await f.store.read(f.node.slug); const form=filled(p);
    expect(formProblems(applyForm(p,form),f.pack)).toEqual([]);
    const compiled=buildShot(applyForm(p,form),applyForm(p,form).shots[0]!,f.pack);
    expect(compiled.findings.filter(f=>f.severity==='warning').map(f=>({id:f.ruleId,text:f.messageRu}))).toEqual([]);
    const prompt=compiled.prompt;
    expect(prompt).not.toContain('Ignore any people'); expect(prompt).toContain('opens exactly on');
    const r=runner([form,ready]); await f.service.start(p.slug,p.rev,r.run);
    const state=await finished(f); expect(state.state?.status).toBe('ready'); expect(r.requests).toHaveLength(2);
    expect(JSON.parse(r.requests[0]!.user).series.scenePlan.shots).toHaveLength(3);
    expect(r.requests[0]!.images).toEqual([{mediaType:'image/png',base64:'test-photo'}]);
    const other=flow.nodes.find(n=>n.type==='seedance' && n.id!==f.node.id)!; expect((await f.store.read(other.slug)).seriesFill).toBeUndefined();
    expect(state.project.seriesFill?.previous).toEqual(formOf(p)); expect(f.submit).not.toHaveBeenCalled();
  });
  it('repairs a wrong existing first-frame reference and unrequested duration before the critic', async () => {
    const f=await fixture(); let p=await f.store.read(f.node.slug);
    p.refs.push({...p.refs[0]!,key:'extra-frame'});p.shots[0]!.panel.push('extra-frame');p=await f.store.write(p.slug,p,p.rev);
    const wrong=filled(p);wrong.shot.segments[0]!.frameRef='extra-frame';wrong.shot.durationSec=8;
    const r=runner([wrong,filled(p),ready]);await f.service.start(p.slug,p.rev,r.run);
    const state=await finished(f);expect(r.requests).toHaveLength(3);
    expect(r.requests[2]?.taskRu).toBe('Критик Prompter серии');
    expect(state.state?.issues.join(' ')).not.toContain('исходного принятого фото');
    expect(state.state?.issues.join(' ')).not.toContain('режиссёрскому плану');
    const repair=JSON.parse(r.requests[1]!.user).repair.issues.join(' ');
    expect(repair).toContain('исходного принятого фото');expect(repair).toContain('режиссёрскому плану: 6');
    expect(state.project.shots[0]?.durationSec).toBe(6);expect(f.submit).not.toHaveBeenCalled();
  });
  it.each([true,false])('one repair then recheck (repaired=%s)',async repaired=>{
    const f=await fixture();const p=await f.store.read(f.node.slug);const form=filled(p);
    const risky={...ready,verdict:'risky',summaryRu:'Нужно уточнить движение руки.'};
    const r=runner([form,risky,form,repaired ? ready : risky]);await f.service.start(p.slug,p.rev,r.run);
    const state=await finished(f);expect(state.state?.status).toBe(repaired?'ready':'review');expect(r.requests).toHaveLength(4);expect(f.submit).not.toHaveBeenCalled();
  });
  it('critic failure is technical, preserves prepared form and allows restore',async()=>{
    const f=await fixture();const p=await f.store.read(f.node.slug);const r=runner([filled(p),new Error('offline')]);await f.service.start(p.slug,p.rev,r.run);
    const state=await finished(f);expect(state.state?.status).toBe('failed');expect(state.project.seriesFill).toBeDefined();
    const restored=await f.service.restore(p.slug,state.project.rev);expect(formOf(restored).world.place.ru).toBe('');expect(f.submit).not.toHaveBeenCalled();
  });
  it('does not overwrite a terminal report when an in-flight poll returns an old running snapshot',async()=>{
    const f=await fixture();const p=await f.store.read(f.node.slug);
    let releaseCritic!:()=>void;const criticGate=new Promise<void>(r=>{releaseCritic=r;});
    const r=runner([filled(p),async()=>{await criticGate;throw new Error('offline');}]);
    await f.service.start(p.slug,p.rev,r.run);
    await vi.waitFor(()=>expect(r.requests).toHaveLength(2));
    let releaseRead!:()=>void;const readGate=new Promise<void>(r=>{releaseRead=r;});
    let didRead!:()=>void;const captured=new Promise<void>(r=>{didRead=r;});
    readBarrier.file=path.join(f.options.dataDir,'series-preparation',`${p.slug}.json`);
    readBarrier.afterRead=async()=>{didRead();await readGate;};
    const poll=f.service.inspect(p.slug);
    try {
      await captured;releaseCritic();
      const actual=await vi.importActual<typeof FsPromises>('node:fs/promises');
      await vi.waitFor(async()=>expect(JSON.parse(await actual.readFile(readBarrier.file,'utf8')).status).toBe('failed'));
      releaseRead();
      const result=await poll;expect(result.state?.status).toBe('failed');
      expect((await f.service.inspect(p.slug)).state?.status).toBe('failed');
    } finally {releaseCritic();releaseRead();readBarrier.afterRead=undefined;readBarrier.file='';}
  });
  it('refill keeps manual Russian, regenerates English; explicit reset may replace it',async()=>{
    const f=await fixture();let p=await f.store.read(f.node.slug); p.world.place.ru='Моё место'; p=await f.store.write(p.slug,p,p.rev);
    const form=filled(p);form.world.place.ru='Моё место';form.world.place.en='my place';
    const r=runner([form,ready]);await f.service.start(p.slug,p.rev,r.run);let state=await finished(f);
    expect(state.state?.status).toBe('ready');expect(state.project.world.place).toMatchObject({ru:'Моё место',en:'my place',enFor:'Моё место'});
    expect(JSON.parse(r.requests[0]!.user).protectedManualFields).toContainEqual({path:['world','place','ru'],value:'Моё место'});
    const reset=runner([filled(state.project),ready]);await f.service.start(p.slug,state.project.rev,reset.run,true);state=await finished(f);expect(state.project.world.place.ru).toBe('Комната у окна');
  });
  it('rejects an agent overwriting a manual field even on repair',async()=>{
    const f=await fixture();let p=await f.store.read(f.node.slug); p.world.place.ru='Моё место';p=await f.store.write(p.slug,p,p.rev);
    const r=runner([filled(p),filled(p)]);await f.service.start(p.slug,p.rev,r.run);const state=await finished(f);
    expect(state.state?.status).toBe('review');expect(state.project.world.place.ru).toBe('Моё место');expect(r.requests).toHaveLength(2);
  });
  it('keeps a creator duration override instead of restoring the director duration', async () => {
    const f=await fixture();let p=await f.store.read(f.node.slug);
    p.shots[0]!.durationSec=8;p=await f.store.write(p.slug,p,p.rev);
    const form=filled(p);form.shot.durationSec=8;
    const r=runner([form,ready]);await f.service.start(p.slug,p.rev,r.run);
    const state=await finished(f);expect(state.project.shots[0]?.durationSec).toBe(8);
    expect(state.state?.issues.join(' ')).not.toContain('режиссёрскому плану');
    expect(JSON.parse(r.requests[0]!.user).protectedManualFields).toContainEqual({path:['shot','durationSec'],value:8});
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('late result never overwrites concurrent edits',async()=>{
    const f=await fixture();const p=await f.store.read(f.node.slug);let release:()=>void=()=>{};const wait=new Promise<void>(r=>{release=r;});
    const r=runner([async()=>{await wait;return filled(p);},ready]);await f.service.start(p.slug,p.rev,r.run);
    const changed={...p,title:'Edited while running'};await f.store.write(p.slug,changed,p.rev);release();
    const state=await finished(f);expect(state.state?.status).toBe('failed');expect(state.project.title).toBe(changed.title);expect(state.project.seriesFill).toBeUndefined();
  });
  it('context, source file, and form edits invalidate review',async()=>{
    const f=await fixture();const p=await f.store.read(f.node.slug);await f.service.start(p.slug,p.rev,runner([filled(p),ready]).run);const initial=await finished(f);expect(initial.stale).toBe(false);
    f.run.direction+=' changed';expect((await f.service.inspect(p.slug)).stale).toBe(true);f.run.direction=f.run.direction.replace(' changed','');
    const changed={...initial.project,aspectRatio:'16:9' as const};await f.store.write(p.slug,changed,changed.rev);expect((await f.service.inspect(p.slug)).stale).toBe(true);
    await f.store.writeRef(p.slug,p.refs[0]!.file!,new Uint8Array([1,2,3]));expect((await f.service.inspect(p.slug)).contextProblem).toContain('заменено');
  });
  it('known linter warnings remain review even when critic is clean',async()=>{
    const f=await fixture();const p=await f.store.read(f.node.slug);const form=filled(p);form.world.weather={ru:'',en:'',source:'empty',locked:false};
    const r=runner([form,ready,form,ready]);await f.service.start(p.slug,p.rev,r.run);const state=await finished(f);
    expect(state.state?.status).toBe('review');expect(state.state?.issues.join(' ')).toContain('Погода');expect(r.requests).toHaveLength(4);
  });
  it('restart marks a saved running status interrupted without invoking an agent',async()=>{
    const f=await fixture();await mkdir(path.join(f.options.dataDir,'series-preparation'),{recursive:true});
    await writeFile(path.join(f.options.dataDir,'series-preparation',`${f.node.slug}.json`),JSON.stringify({id:'interrupted',slug:f.node.slug,status:'running',stage:'fill',issues:[]}));
    const restarted=createProductionCanvas(f.options);expect((await restarted.inspect(f.node.slug)).state?.status).toBe('interrupted');expect(f.submit).not.toHaveBeenCalled();
  });
});
