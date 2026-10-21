import type { Project } from '../../core/model/project.ts';
import { studioFetch } from '../remoteFetch.ts';
export interface Preparation {
  id: string; status: 'running' | 'ready' | 'review' | 'failed' | 'interrupted';
  stage: 'queued' | 'fill' | 'critic' | 'repair' | 'recheck' | 'complete'; issues: string[];
}
export interface Inspection { state: Preparation | null; project: Project; stale: boolean; contextProblem: string | null }
export async function seriesApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await studioFetch(path, body === undefined ? undefined : { method:'POST', headers: { 'content-type':'application/json', 'x-sp-client':'1' }, body:JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.messageRu ?? `HTTP ${res.status}`);
  return data as T;
}
export const stageLabel = { queued:'В очереди', fill:'Заполняем форму', critic:'Проверяет критик', repair:'Одно исправление', recheck:'Повторная проверка', complete:'Подготовка завершена' };
export function preparationLabel(data: Inspection | null): string {
  if (!data?.state) return 'Ещё не заполнен по серии';
  if (data.state.status === 'running') return stageLabel[data.state.stage];
  if (data.state.status === 'failed') return 'Технический сбой';
  if (data.state.status === 'interrupted') return 'Подготовка прервана';
  if (data.stale) return 'Проверка устарела';
  return data.state.status === 'review' ? 'Нужна ручная проверка' : 'Проверено · проверь перед запуском';
}
