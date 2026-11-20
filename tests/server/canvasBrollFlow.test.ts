import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FLOW_TEMPLATES } from '../../src/core/canvas/templates.ts';
import { planRun } from '../../src/core/canvas/plan.ts';
import type { Flow } from '../../src/core/model/canvas.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import { createCanvasAi } from '../../src/server/canvasAi/service.ts';
import type { CanvasAiRun } from '../../src/core/model/canvasAi.ts';
import { createGenRuntime } from '../../src/server/gen/runtime.ts';
import type { GenProvider } from '../../src/server/gen/provider.ts';
import type { Runner } from '../../src/server/llm/tasks/write.ts';
import { createCharacters } from '../../src/server/production/characters.ts';
import { createFlows } from '../../src/server/storage/flows.ts';

it('five independent B-roll branches complete manual idea/prompt/photo acceptance/video stages with fake providers', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sp-five-broll-'));
  const rootDir = path.join(import.meta.dirname, '../..');
  const image = await readFile(path.join(rootDir, 'src/web/public/production-mock/shot-1.png'));
  let now = Date.parse('2026-11-17T10:00:00Z');
  let mediaCalls = 0; let aiCalls = 0;
  const provider: GenProvider = {
    id: 'higgsfield', hasKey: () => true,
    upload: async () => 'https://fixture.invalid/start.png',
    submit: async () => `fake-task-${++mediaCalls}`,
    estimate: async () => ({ credits: 100, usd: 0.5 }),
    poll: async () => ({ state: 'success', providerState: 'done', urls: ['https://fixture.invalid/result.png'], creditsConsumed: 0.006, failMsg: null }),
    freshUrl: async () => null,
  };
  const runLlm: Runner = async request => {
    aiCalls++;
    const data = request.taskRu === 'Идея Canvas'
      ? { textRu: 'Человек у окна плавно поворачивает голову к мягкому свету. Неподвижная камера, средний план, простое движение в течение пяти секунд.', assumptionsRu: ['Мягкий свет — предложение.'], referenceNotesRu: [] }
      : { prompt: 'A person in a dark jacket stands beside a tall window in soft daylight. The camera holds a medium view at eye level. The person slowly turns toward the window and pauses, with natural texture and coherent proportions.', summaryRu: 'Сохранён одобренный поворот у окна.', referenceNotesRu: [] };
    return { data: data as never, meta: { durationMs: 1, model: 'fake', turns: 1, inputTokens: 1, outputTokens: 1 } };
  };
  const gen = createGenRuntime({ dataDir, now: () => now, providers: { higgsfield: provider }, fetch: (async () => new Response(image, { headers: { 'content-type': 'image/png' } })) as typeof fetch });
  const flows = createFlows(dataDir);
  const characters = createCharacters({ dataDir });
  const canvasAi = createCanvasAi({ dataDir, rootDir, gen, flows, characters, runLlm });
  const app = createApp({ dataDir, rootDir, gen, characters, canvasAi, runLlm, reveal: false });
  const headers = { host: `${HOST}:${PORT}`, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };
  const post = (url: string, body: unknown) => app.request(url, { method: 'POST', headers, body: JSON.stringify(body) });
  let flow: Flow;
  const reload = async () => { flow = (await flows.get(flow.id))!; return flow; };
  const checked = async <T>(response: Response, status = 200): Promise<T> => {
    const value = await response.json();
    expect({ status: response.status, body: response.status === status ? undefined : value }).toEqual({ status, body: undefined });
    return value as T;
  };
  const phase = async (nodeId: string) => {
    for (const stage of ['idea', 'prompt'] as const) {
      await reload();
      const existingPrompt = flow.nodes.find(n => n.type === 'prompt' && flow.edges.some(e => e.from === nodeId && e.to === n.id && e.port === 'idea'));
      const preview = await checked<{ snapshot: { contextDigest: string } }>(await app.request(`/api/canvas-ai/preview?flowId=${flow.id}&nodeId=${nodeId}`, { headers }));
      const started = await checked<{ run: CanvasAiRun }>(await post('/api/canvas-ai/runs', { flowId: flow.id, nodeId, stage, requestId: randomUUID(), flow, consent: true, previewDigest: preview.snapshot.contextDigest }), 202);
      await canvasAi.wait(started.run.id);
      const run = await canvasAi.get(started.run.id);
      expect(run.status).toBe('ready');
      await reload();
      if (stage === 'prompt') expect(flow.nodes.find(n => n.aiSource?.versionId === run.version?.id)?.aiApproval).toBeUndefined();
      await checked(await post(`/api/canvas-ai/runs/${run.id}/approve`, { flow, expectedRevision: run.revision }));
      await reload();
      if (existingPrompt) expect(flow.nodes.find(n => n.id === existingPrompt.id)?.type).toBe('prompt');
      expect(flow.nodes.filter(n => n.type === 'prompt')).toHaveLength(10);
    }
    await reload();
  };
  const generate = async (nodeId: string) => {
    const jobs = await gen.jobs.all();
    const mediaOf = (id: string) => jobs.find(job => job.id === id)?.mediaIds[0] ?? null;
    const plan = planRun(flow, nodeId, mediaOf);
    expect(plan.problems).toEqual([]);
    const request = { modelId: plan.modelId, prompt: plan.prompt, params: plan.params, refs: plan.refs, count: 1, canvas: { flowId: flow.id, nodeId }, refsConsent: true };
    const quote = plan.modelId.includes('seedance') ? await checked<{ quoteId: string; estimate: { credits: number } }>(await post('/api/gen/quote', request)) : null;
    const result = await checked<{ jobs: { id: string }[] }>(await post('/api/gen/jobs', { ...request, confirmCredits: quote?.estimate.credits ?? plan.estimate!.credits, quoteId: quote?.quoteId }), 202);
    const jobId = result.jobs[0]!.id;
    flow = (await flows.save(flow.id, { ...flow, nodes: flow.nodes.map(n => n.id === nodeId ? { ...n, jobIds: [...n.jobIds, jobId], selected: n.jobIds.length, stale: false } : n) }))!;
    now += 60_000; await gen.tick();
    const job = (await gen.jobs.get(jobId))!;
    expect(job.status).toBe('saved');
    expect(job.canvas?.promptVersionId).toBeTruthy();
    return job;
  };
  try {
    let sequence = 0;
    const graph = FLOW_TEMPLATES.find(t => t.id === 'managed-five-broll')!.build(prefix => `${prefix}-${++sequence}`);
    flow = await flows.create('Five B-roll fixture');
    flow = (await flows.save(flow.id, { ...flow, ...graph, nodes: graph.nodes.map(n => n.type === 'comment' ? { ...n, text: `${n.label}: спокойный cinematic кадр у окна.` } : n) }))!;
    expect(aiCalls).toBe(0); expect(mediaCalls).toBe(0);
    expect(flow.nodes).toHaveLength(41);
    const photoAis = flow.nodes.filter(n => n.type === 'ai' && n.kind === 'image');
    expect(photoAis).toHaveLength(5);
    for (const photoAi of photoAis) {
      await phase(photoAi.id);
      const photo = await generate(photoAi.targetGeneratorId!);
      await checked(await post('/api/canvas-ai/accept-media', { flowId: flow.id, nodeId: photoAi.targetGeneratorId, flow, jobId: photo.id, mediaId: photo.mediaIds[0] }));
      await reload();
      const videoAiId = flow.edges.find(e => e.from === photoAi.targetGeneratorId && e.port === 'ref')!.to;
      await phase(videoAiId);
      await generate(flow.nodes.find(n => n.id === videoAiId)!.targetGeneratorId!);
      await reload();
    }
    expect(aiCalls).toBe(20); expect(mediaCalls).toBe(10);
    expect(flow.nodes.filter(n => n.type === 'prompt' && n.aiApproval)).toHaveLength(10);
    expect(flow.nodes.filter(n => n.acceptedMediaId)).toHaveLength(5);

    // A deliberate review can keep both texts after changing a local comment,
    // without spending another AI call or losing the previous input snapshots.
    const videoAi = flow.nodes.find(n => n.type === 'ai' && n.kind === 'video')!;
    const prior = await canvasAi.list(flow.id, videoAi.id);
    const oldIdea = prior.find(run => run.stage === 'idea' && run.status === 'approved')!;
    const oldPrompt = prior.find(run => run.stage === 'prompt' && run.status === 'approved')!;
    const localCommentId = flow.edges.find(edge => edge.to === videoAi.id && edge.port === 'context' && flow.nodes.find(n => n.id === edge.from)?.label.includes('движение'))!.from;
    flow = (await flows.save(flow.id, { ...flow, nodes: flow.nodes.map(n => n.id === localCommentId ? { ...n, text: `${n.text} Текст можно оставить после ручной проверки.` } : n) }))!;
    await checked(await post(`/api/canvas-ai/runs/${oldIdea.id}/revalidate`, { flow, expectedRevision: oldIdea.revision }));
    await reload();
    await checked(await post(`/api/canvas-ai/runs/${oldPrompt.id}/revalidate`, { flow, expectedRevision: oldPrompt.revision }));
    await reload();
    expect(aiCalls).toBe(20);
    expect((await canvasAi.get(oldPrompt.id)).snapshot).toEqual(oldPrompt.snapshot);
    expect(flow.nodes.find(n => n.id === videoAi.id)?.ai?.prompt?.approval).toBeTruthy();
  } finally {
    gen.stop(); await rm(dataDir, { recursive: true, force: true });
  }
}, 30000);
