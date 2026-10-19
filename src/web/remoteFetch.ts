/** Keep long operations below a reverse proxy's request timeout, without repeating mutations. */
export async function studioFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const asyncRequest = init?.method === 'POST' && headers.get('content-type')?.startsWith('application/json');
  if (!asyncRequest) return globalThis.fetch(input, init);
  headers.set('prefer', 'respond-async');
  let response = await globalThis.fetch(input, { ...init, headers });
  const id = response.headers.get('x-sp-request');
  if (response.status !== 202 || !id || !/^[a-f0-9-]{36}$/.test(id)) return response;
  const url = `/api/requests/${id}`;
  const cancel = (): void => {
    void globalThis.fetch(url, { method: 'DELETE', headers: { 'x-sp-client': '1' }, keepalive: true }).catch(() => undefined);
  };
  init?.signal?.addEventListener('abort', cancel, { once: true });
  let complete = false;
  if (init?.signal?.aborted) cancel();
  try {
    while (response.status === 202 && response.headers.get('x-sp-request') === id) {
      init?.signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      init?.signal?.throwIfAborted();
      response = await globalThis.fetch(url, { signal: init?.signal });
    }
    complete = true;
    return response;
  } finally {
    init?.signal?.removeEventListener('abort', cancel);
    if (complete) cancel();
  }
}
