import type { ReferenceAnalysisJob, ReferenceCard, ReferenceFolder, ReferenceSelection, ReferenceThread } from '../../core/references.ts';
import { ui } from '../language.ts';
import { studioFetch } from '../remoteFetch.ts';

const ROOT = '/api/references';
const cardPath = (id: string): string => `${ROOT}/cards/${encodeURIComponent(id)}`;
const threadPath = (key: string): string => `${ROOT}/threads/${encodeURIComponent(key)}`;

async function request(path: string, options?: RequestInit, transport = fetch): Promise<Response> {
  const headers = new Headers(options?.headers);
  if (options?.method) headers.set('x-sp-client', '1');
  const response = await transport(path, { ...options, headers, cache: 'no-store' });
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as { messageRu?: string } | null;
    throw new Error(problem?.messageRu ?? ui('Сервер не ответил на запрос ({0}).', response.status));
  }
  return response;
}

async function json<T>(path: string, options?: RequestInit, transport = fetch): Promise<T> {
  return (await request(path, options, transport)).json() as Promise<T>;
}

function data(method: 'POST' | 'PATCH', body: unknown, signal?: AbortSignal): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal };
}

export interface ReferenceLibraryStatus {
  enabled: boolean;
  graph?: boolean;
  shared?: boolean;
}

export function referenceLibraryStatus(signal?: AbortSignal): Promise<ReferenceLibraryStatus> {
  return json(`${ROOT}/status`, { signal });
}

export function referenceImageUrl(id: string): string {
  return `${cardPath(id)}/image`;
}

export const getReferenceCards = (signal?: AbortSignal): Promise<{ cards: ReferenceCard[] }> =>
  json(`${ROOT}/cards`, { signal });

export function uploadReference(file: File): Promise<{ cards: ReferenceCard[] }> {
  return json(`${ROOT}/imports?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
}

export function editReference(id: string, change: { folder?: ReferenceFolder; tags: string[] }): Promise<{ card: ReferenceCard }> {
  return json(cardPath(id), data('PATCH', change));
}

export function referenceAnalysis(action?: 'start' | 'stop', signal?: AbortSignal, maxPending?: number): Promise<{ job: ReferenceAnalysisJob | null }> {
  return json(`${ROOT}/analysis${action === 'stop' ? '/cancel' : ''}`, action ? data('POST', action === 'start' ? { maxPending } : {}, signal) : { signal });
}

export const getReferenceThread = (key: string, signal?: AbortSignal): Promise<{ thread: ReferenceThread }> =>
  json(threadPath(key), { signal });

export const sendReferenceQuery = (key: string, brief: string, query: string, signal?: AbortSignal): Promise<{ thread: ReferenceThread }> =>
  json(threadPath(key), data('POST', { brief, query }, signal), studioFetch);

export const saveReferenceSelection = (key: string, selection: ReferenceSelection[]): Promise<{ thread: ReferenceThread }> =>
  json(threadPath(key), data('PATCH', { selection }));

export async function sendReferenceFeedback(key: string, feedback: { turnId: string; refId: string; value: 'used' | 'dismissed'; role?: string }): Promise<void> {
  await request(`${threadPath(key)}/feedback`, data('POST', feedback));
}
