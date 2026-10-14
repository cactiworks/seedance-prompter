import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const SOUL_ID = '11111111-1111-4111-8111-111111111111';
let storage: Map<string, string>;
beforeEach(() => {
  vi.resetModules(); storage = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

it('Studio remembers Soul ID across model changes and reload, without sending it to other models', async () => {
  const { useGen } = await import('../../src/web/gen/genStore.ts');
  useGen.getState().setModel('image', 'higgsfield/soul-2');
  useGen.getState().setParam('image', 'soulId', SOUL_ID);
  useGen.getState().setModel('image', 'kie/gpt-image-2-5');
  expect(useGen.getState().composer.image.params).not.toHaveProperty('soulId');
  useGen.getState().setModel('image', 'higgsfield/soul-2');
  expect(useGen.getState().composer.image.params.soulId).toBe(SOUL_ID);
  vi.resetModules();
  const reloaded = await import('../../src/web/gen/genStore.ts');
  reloaded.useGen.getState().setModel('image', 'higgsfield/soul-2');
  expect(reloaded.useGen.getState().composer.image.params.soulId).toBe(SOUL_ID);
  expect(reloaded.useGen.getState().composer.video.params).not.toHaveProperty('soulId');
});

it('None is an explicit persistent choice; applying a prompt preserves the chosen character', async () => {
  storage.set('sp-studio-soul-id', SOUL_ID);
  const { useGen } = await import('../../src/web/gen/genStore.ts');
  useGen.getState().setModel('image', 'kie/gpt-image-2-5');
  useGen.getState().applyPrompt('image', 'higgsfield/soul-2', { resolution: '720p' }, 'Portrait', []);
  expect(useGen.getState().composer.image.params.soulId).toBe(SOUL_ID);
  useGen.getState().setParam('image', 'soulId', '');
  vi.resetModules();
  const reloaded = await import('../../src/web/gen/genStore.ts');
  reloaded.useGen.getState().setModel('image', 'higgsfield/soul-2');
  expect(reloaded.useGen.getState().composer.image.params.soulId).toBe('');
});

it('blocked browser storage does not prevent selecting or clearing a character', async () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
  const { useGen } = await import('../../src/web/gen/genStore.ts');
  useGen.getState().setModel('image', 'higgsfield/soul-2');
  useGen.getState().setParam('image', 'soulId', SOUL_ID);
  expect(useGen.getState().composer.image.params.soulId).toBe(SOUL_ID);
  useGen.getState().setParam('image', 'soulId', '');
  expect(useGen.getState().composer.image.params.soulId).toBe('');
});
