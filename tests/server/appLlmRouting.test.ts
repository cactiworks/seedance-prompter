import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newProject, type Project } from '../../src/core/model/project.ts';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import { LlmError, type LlmRequest } from '../../src/server/llm/codexCli/provider.ts';

const rootDir = path.resolve(import.meta.dirname, '../..');
const headers = { host: `${HOST}:${PORT}`, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };
const directories: string[] = [];
const unit = (en: string) => ({ ru: '', en, source: 'manual' as const, locked: true });

function readyProject(): Project {
  const project = newProject('fixture', 'Fixture');
  const flags = { hasPeople: false, hasText: false, studioBackdrop: false };
  return {
    ...project,
    world: { place: unit('a quiet embankment'), useOnlyEn: 'the space and sky', weather: unit('Wet asphalt, puddles reflecting the sky, steam rising, a light wind.') },
    refs: [{ key: 'loc', label: 'Локация', kind: 'location', file: null, flags }, { key: 'hero', label: 'Герой', kind: 'character', file: 'hero.jpg', flags }],
    entities: [{ key: 'alex', name: 'Alexander', kind: 'character', refKey: 'hero' }],
    lines: [{ id: 'L1', speakerKey: 'alex', ru: 'Привет.', proofread: true }],
    shots: project.shots.map(shot => ({
      ...shot, panel: ['loc', 'hero'], locationRefs: ['loc'],
      segments: [
        { id: 'seg-1', titleRu: '', beatsRu: 'Герой говорит L1.', text: unit('{{intro:alex}} stands near the pickup in a medium shot, looks into the lens and {{line:L1}}') },
        { id: 'seg-2', titleRu: '', beatsRu: '', text: unit('He presses a bag of ice in his left hand to his right cheek. A second of silence, just the wind. The camera slowly lowers, as if the arms holding it are finally tired.') },
      ],
    })),
  };
}

async function setup(writerModel?: string) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'app-llm-routing-'));
  directories.push(dataDir);
  const calls: LlmRequest[] = [];
  const app = createApp({
    rootDir, dataDir, writerModel,
    runLlm: async request => {
      calls.push(request);
      throw new LlmError('PROCESS_CRASH', 'Остановлено тестовым runner без вызова модели.');
    },
  });
  const post = (route: string, body: unknown) => app.request(route, { method: 'POST', headers, body: JSON.stringify(body) });
  return { app, calls, post };
}

beforeEach(() => {
  for (const key of ['SP_LLM_MODEL', 'SP_FIELDS_MODEL', 'SP_CRITIC_MODEL', 'SP_VISION_MODEL', 'SP_WRITER_MODEL', 'SP_EDIT_MODEL']) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('app-level economical LLM routing', () => {
  it.each([
    ['fields', 'gpt-6-luna', 'low'],
    ['plan', 'gpt-6.1-sol', 'medium'],
    ['critique', 'gpt-6.1-sol', 'medium'],
    ['write', 'gpt-6.1-sol', 'medium'],
    ['fix', 'gpt-6.1-sol', 'medium'],
    ['region-edit', 'gpt-6-luna', 'low'],
  ] as const)('%s reaches one injected runner with %s/%s', async (role, model, effort) => {
    const { calls, post } = await setup();
    const project = readyProject();
    if (role === 'fields') project.world.place = { ru: 'Тихая набережная', en: '', source: 'empty', locked: false };
    if (role === 'fix') project.shots[0]!.attempts.push({ n: 1, createdAt: '2026-11-22T00:00:00Z', prompt: 'A scene.', panel: [], segments: [], kitId: project.shots[0]!.kitId, verdict: 'rejected', workedRu: '', failedRu: 'Неверная поза', symptomIds: [], readbackRu: '' });
    const response = await post(`/api/llm/${role}`, role === 'region-edit'
      ? { instructionRu: 'Сделай куртку красной', boxes: [{ x1: 100, y1: 100, x2: 200, y2: 200 }] }
      : { project, shotId: 'shot-1', segmentIds: ['seg-1'], attemptN: 1, synopsisRu: 'Герой идёт по набережной.' });
    expect(response.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model, effort });
  });

  it('vision keeps images and uses the vision profile even with a writer-only override', async () => {
    const { app, calls, post } = await setup('writer-only-test');
    const created = await post('/api/projects', { slug: 'fixture', title: 'Fixture' });
    const stored = await created.json() as Project;
    await app.request('/api/projects/fixture', { method: 'PUT', headers: { ...headers, 'if-match': String(stored.rev) }, body: JSON.stringify({ ...readyProject(), rev: stored.rev }) });
    await app.request('/api/projects/fixture/refs/hero-vision.jpg', { method: 'PUT', headers: { host: headers.host, [CLIENT_HEADER]: '1' }, body: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]) });
    const response = await post('/api/llm/vision', { slug: 'fixture', refKey: 'hero' });
    expect(response.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: 'gpt-6.1-terra', effort: 'medium' });
    expect(calls[0]?.images).toHaveLength(1);
  });

  it.each(['fields', 'critique', 'plan'] as const)('preserves writerModel precedence for %s', async role => {
    vi.stubEnv('SP_LLM_MODEL', 'global-test');
    vi.stubEnv(role === 'fields' ? 'SP_FIELDS_MODEL' : role === 'critique' ? 'SP_CRITIC_MODEL' : 'SP_WRITER_MODEL', 'role-test');
    const { calls, post } = await setup('explicit-test');
    const project = readyProject();
    if (role === 'fields') project.world.place = { ru: 'Тихая набережная', en: '', source: 'empty', locked: false };
    const response = await post(`/api/llm/${role}`, { project, shotId: 'shot-1', synopsisRu: 'Герой идёт по набережной.' });
    expect(response.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe('explicit-test');
  });
});
