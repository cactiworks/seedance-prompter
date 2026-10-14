import { create } from 'zustand';
import type { Character, CreateCharacterInput } from '../../core/production/character.ts';

const headers = { 'x-sp-client': '1', 'content-type': 'application/json' };
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers, body: JSON.stringify(body) });
  const result = await response.json() as T & { messageRu?: string };
  if (!response.ok) throw new Error(result.messageRu ?? 'Не удалось прочитать персонажей.');
  return result;
}
interface State {
  items: Character[]; busy: boolean; loading: boolean; error: string | null; revision: number;
  load: () => Promise<void>; refresh: (sync?: boolean) => Promise<void>;
  create: (input: CreateCharacterInput) => Promise<boolean>;
}
export const useCharacters = create<State>((set, get) => ({
  items: [], busy: false, loading: false, error: null, revision: 0,
  load: async () => {
    if (get().loading || get().busy) return;
    const revision = get().revision;
    set({ loading: true });
    try { const items = await request<Character[]>('/api/characters'); if (get().revision === revision) set({ items, error: null }); }
    catch (error) { if (get().revision === revision) set({ error: String(error) }); }
    finally { set({ loading: false }); }
  },
  refresh: async (sync = false) => {
    if (get().loading || get().busy) return;
    const revision = get().revision;
    set({ loading: true });
    try { const items = await request<Character[]>(`/api/characters/${sync ? 'sync' : 'refresh'}`, {}); if (get().revision === revision) set({ items, error: null }); }
    catch (error) { if (get().revision === revision) set({ error: String(error) }); }
    finally { set({ loading: false }); }
  },
  create: async (input) => {
    if (get().busy) return false;
    set({ busy: true, error: null, revision: get().revision + 1 });
    try {
      const item = await request<Character>('/api/characters', input);
      set({ items: [item, ...get().items.filter((c) => c.id !== item.id)] }); return true;
    } catch (error) { set({ error: `${String(error)} Если ответ потерян, проверь список перед повторным созданием.` }); return false; }
    finally { set({ busy: false }); }
  },
}));
