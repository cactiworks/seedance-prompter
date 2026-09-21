import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp, CLIENT_HEADER, HOST, PORT } from '../../src/server/app.ts';
import type { Project } from '../../src/core/model/project.ts';
import { buildShot, type PackBundle } from '../../src/core/pipeline.ts';

const host = `${HOST}:${PORT}`;
const ROOT = path.join(import.meta.dirname, '../..');
const makeApp = () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sp-test-'));
  return { app: createApp({ rootDir: ROOT, dataDir }), dataDir };
};
const write = { host, [CLIENT_HEADER]: '1', 'content-type': 'application/json' };

describe('API: защита локального сервера', () => {
  const { app } = makeApp();

  it('отвечает на health с правильным Host', async () => {
    const res = await app.request('/api/health', { headers: { host } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: 'seedance-prompter' });
  });

  it('отклоняет чужой Host (DNS rebinding)', async () => {
    expect((await app.request('/api/health', { headers: { host: 'evil.example:4317' } })).status).toBe(403);
  });

  it('отклоняет чужой Origin', async () => {
    expect((await app.request('/api/health', { headers: { host, origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('требует заголовок клиента на мутациях', async () => {
    const denied = await app.request('/api/projects', { method: 'POST', headers: { host, 'content-type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(403);
  });
});

describe('API: проекты на диске', () => {
  it('создаёт, читает, сохраняет с rev и ловит конфликт двух окон', async () => {
    const { app, dataDir } = makeApp();
    const created = await app.request('/api/projects', { method: 'POST', headers: write, body: JSON.stringify({ slug: 'kamery', title: 'Три камеры' }) });
    expect(created.status).toBe(201);
    const project = (await created.json()) as Project;
    expect(project.rev).toBe(1);

    const edited = { ...project, title: 'Три камеры — тест' };
    const saved = await app.request('/api/projects/kamery', { method: 'PUT', headers: { ...write, 'if-match': '1' }, body: JSON.stringify(edited) });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Project).rev).toBe(2);

    // Второе окно со старым rev не затирает правки первого.
    const stale = await app.request('/api/projects/kamery', { method: 'PUT', headers: { ...write, 'if-match': '1' }, body: JSON.stringify(edited) });
    expect(stale.status).toBe(409);

    const list = (await (await app.request('/api/projects', { headers: { host } })).json()) as { slug: string; title: string }[];
    expect(list).toEqual([expect.objectContaining({ slug: 'kamery', title: 'Три камеры — тест' })]);
    expect(readdirSync(path.join(dataDir, 'projects/kamery'))).toContain('project.json');
  });

  it('не выпускает за пределы каталога данных', async () => {
    const { app } = makeApp();
    for (const slug of ['..', '%2e%2e', 'a/../../etc', 'Имя']) {
      const res = await app.request(`/api/projects/${slug}`, { headers: { host } });
      expect([400, 404]).toContain(res.status);
    }
    const ref = await app.request('/api/projects/kamery/refs/..%2f..%2fproject.json', { headers: { host } });
    expect([400, 404]).toContain(ref.status);
  });

  it('отклоняет невалидный проект, не трогая диск', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/projects/kamery', { method: 'PUT', headers: write, body: JSON.stringify({ slug: 'kamery', title: '' }) });
    expect(res.status).toBe(422);
  });

  it('сохраняет и отдаёт картинку референса', async () => {
    const { app } = makeApp();
    await app.request('/api/projects', { method: 'POST', headers: write, body: JSON.stringify({ slug: 'kamery', title: 'Три камеры' }) });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const put = await app.request('/api/projects/kamery/refs/loc-1.jpg', { method: 'PUT', headers: { host, [CLIENT_HEADER]: '1' }, body: bytes });
    expect(put.status).toBe(200);
    const got = await app.request('/api/projects/kamery/refs/loc-1.jpg', { headers: { host } });
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    const bad = await app.request('/api/projects/kamery/refs/evil.svg', { method: 'PUT', headers: { host, [CLIENT_HEADER]: '1' }, body: bytes });
    expect(bad.status).toBe(400);
  });
});

describe('pack отдаётся клиенту, и новый проект собирается конвейером', () => {
  it('buildShot: пустой проект называет блокеры, заполненный — даёт промпт с номерами по панели', async () => {
    const { app } = makeApp();
    const pack = (await (await app.request('/api/packs/cinema-doc', { headers: { host } })).json()) as PackBundle;
    // Три комплекта гайда и производные (телефон, компакт, видеокамера) — все с пометкой происхождения.
    expect(Object.values(pack.kits).filter((kit) => kit.source === 'guide')).toHaveLength(3);
    expect(Object.values(pack.kits).filter((kit) => kit.source === 'derived').length).toBeGreaterThanOrEqual(2);

    const created = await app.request('/api/projects', { method: 'POST', headers: write, body: JSON.stringify({ slug: 'demo', title: 'Демо' }) });
    const project = (await created.json()) as Project;
    const shot = project.shots[0];
    if (shot === undefined) throw new Error('нет кадра');

    const empty = buildShot(project, shot, pack);
    expect(empty.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['NO_LOCATION_REF', 'NO_PLACE', 'NO_SCENARIO']));
    // Отсутствующая локация называется один раз, без технического хвоста про плейсхолдер.
    expect(empty.blockers.filter((b) => b.messageRu.includes('missing-location-ref'))).toEqual([]);

    const filled: Project = {
      ...project,
      world: { ...project.world, place: { ru: '', en: 'a quiet embankment', source: 'manual', locked: true }, weather: { ru: '', en: 'Wet asphalt, puddles reflecting the sky.', source: 'manual', locked: true } },
      refs: [{ key: 'hero', label: 'Герой', kind: 'character', file: null, flags: { hasPeople: false, hasText: false, studioBackdrop: false } }, { key: 'loc', label: 'Набережная', kind: 'location', file: null, flags: { hasPeople: true, hasText: false, studioBackdrop: false } }],
      entities: [{ key: 'alex', name: 'Alexander', kind: 'character', refKey: 'hero' }],
      lines: [{ id: 'L1', speakerKey: 'alex', ru: 'Привет.', proofread: true }],
    };
    const filledShot = { ...shot, panel: ['loc', 'hero'], locationRefs: ['loc'], segments: [{ id: 'seg-1', titleRu: '', beatsRu: '', text: { ru: '', en: '{{intro:alex}} turns to the camera and {{line:L1}}', source: 'manual' as const, locked: true } }] };
    const build = buildShot(filled, filledShot, pack);
    expect(build.blockers).toEqual([]);
    expect(build.prompt).toContain('Location: exactly as in <<<image_1>>> and <<<image_1>>> — a quiet embankment.');
    expect(build.prompt).toContain('Alexander, matching <<<image_2>>> turns to the camera and says in clear, native Russian, perfect pronunciation, natural intonation: «Привет.»');
    expect(build.metrics.speechWords).toBe(1);

    // Порядок панели — единственный источник нумерации.
    const swapped = buildShot(filled, { ...filledShot, panel: ['hero', 'loc'] }, pack);
    expect(swapped.prompt).toContain('Alexander, matching <<<image_1>>>');
    expect(swapped.prompt).toContain('exactly as in <<<image_2>>>');
  });
});
