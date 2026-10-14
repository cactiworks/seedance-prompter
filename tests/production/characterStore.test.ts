import { afterEach, expect, it, vi } from 'vitest';
import { useCharacters } from '../../src/web/production/characterStore.ts';
import type { Character, CreateCharacterInput } from '../../src/core/production/character.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  useCharacters.setState({ items: [], busy: false, loading: false, error: null, revision: 0 });
});
it('late list response cannot erase a newly created character or stop its polling', async () => {
  let release!: (response: Response) => void;
  const oldList = new Promise<Response>((resolve) => { release = resolve; });
  const character: Character = { id: 'ch-test-record', name: 'Test', referenceId: null, modelVersion: 'v2', status: 'uploading', uploadIds: ['u-test-photo'], uploadedCount: 0, createdAt: '', updatedAt: '', error: null };
  const fetcher = vi.fn().mockReturnValueOnce(oldList).mockResolvedValueOnce(Response.json(character));
  vi.stubGlobal('fetch', fetcher);
  const loading = useCharacters.getState().load();
  const input: CreateCharacterInput = { requestId: '11111111-1111-4111-8111-111111111111', name: 'Test', uploadIds: character.uploadIds, consent: true, costConfirmed: 'unknown' };
  expect(await useCharacters.getState().create(input)).toBe(true);
  release(Response.json([])); await loading;
  expect(useCharacters.getState().items).toEqual([character]);
  expect(useCharacters.getState().loading).toBe(false);
});
