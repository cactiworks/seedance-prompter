import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newProject } from '../../src/core/model/project.ts';
import { useStore } from '../../src/web/store.ts';
import { preparedProject } from '../../src/web/series/sync.ts';
import type { Inspection } from '../../src/web/series/api.ts';

beforeEach(() => {
  vi.useFakeTimers();
  useStore.setState({ project: newProject('recovery', 'My draft'), save: 'saved', error: null, composing: null, critiquing: false });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([409, 503])('leaving a Prompter with a failed save (%s) retains the editor and manual fields', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ messageRu:'Offline' }, { status })));
  useStore.getState().update(p => ({ ...p, title:'Unsaved manual title' }));
  await useStore.getState().closeProject();
  expect(useStore.getState().project?.title).toBe('Unsaved manual title');
  expect(useStore.getState().save).toBe(status === 409 ? 'conflict' : 'error');
});

it('a late save cannot acknowledge a newer edit as saved or drop it on close', async () => {
  let release!: (response: Response) => void;
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url:string, init?:RequestInit) => {
    if (init?.method === 'PUT') {
      calls++;
      if (calls === 1) return new Promise<Response>(resolve => { release = resolve; });
      return Response.json({ messageRu:'Offline' }, { status:503 });
    }
    return Response.json([]);
  }));
  useStore.getState().update(p => ({ ...p, title:'First edit' }));
  const closing = useStore.getState().closeProject();
  useStore.getState().update(p => ({ ...p, title:'Last edit while saving' }));
  release(Response.json({ ...newProject('recovery', 'First edit'), rev:2 }));
  await closing;
  expect(calls).toBe(2);
  expect(useStore.getState().project?.title).toBe('Last edit while saving');
  expect(useStore.getState().save).toBe('error');
});

it('explicit retry saves the retained form after a network outage', async () => {
  let offline = true;
  vi.stubGlobal('fetch', vi.fn(async (_url:string, init?:RequestInit) => offline
    ? Response.json({ messageRu:'Offline' }, { status:503 })
    : Response.json({...JSON.parse(init!.body as string),rev:2})));
  useStore.getState().update(p => ({ ...p,title:'Retained work' }));
  expect(await useStore.getState().flushProject()).toBe(false);
  offline = false;
  expect(await useStore.getState().retryProjectSave()).toBe(true);
  expect(useStore.getState().project?.title).toBe('Retained work');
  expect(useStore.getState().project?.rev).toBe(2);
});

const inspection = (): Inspection => ({ state:{id:'batch',status:'ready',stage:'complete',issues:[]}, project:{...newProject('recovery','Filled by batch'),rev:2}, stale:false, contextProblem:null });
it('a completed batch refreshes the open editor without a local start or after page reload', () => {
  expect(preparedProject(useStore.getState(), inspection())?.title).toBe('Filled by batch');
});
it.each(['dirty','saving','error','conflict'])('batch results never replace %s local work', save => {
  expect(preparedProject({ ...useStore.getState(), save }, inspection())).toBeNull();
});
it('batch polling cannot regress revision, switch editors or overwrite a foreground agent', () => {
  const local = useStore.getState(); const data = inspection();
  expect(preparedProject({ ...local, project:{...data.project, rev:3} }, data)).toBeNull();
  expect(preparedProject({ ...local, project:newProject('another','Another') }, data)).toBeNull();
  expect(preparedProject({ ...local, composing:'writing' }, data)).toBeNull();
  expect(preparedProject({ ...local, critiquing:true }, data)).toBeNull();
  expect(preparedProject(local,{...data,state:{...data.state!,status:'running'}})).toBeNull();
});
