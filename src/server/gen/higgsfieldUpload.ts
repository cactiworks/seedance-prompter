import { z } from 'zod';

/** Signed storage receives only its own headers, never API credentials. No retries. */
export async function uploadHiggsfieldFile(bytes: Uint8Array, mime: string, call: (path: string, body: object) => Promise<unknown>, doFetch: typeof fetch): Promise<string> {
  const signed = z.object({ public_url: z.url().startsWith('https://'), upload_url: z.url().startsWith('https://'), upload_headers: z.record(z.string(), z.string()) }).safeParse(await call('/files/generate-upload-url', { content_type: mime }));
  if (!signed.success) throw new Error('Higgsfield не вернул адрес загрузки.');
  const headers = new Headers(signed.data.upload_headers);
  if (['authorization', 'hf-api-key', 'hf-secret', 'cookie'].some((name) => headers.has(name))) throw new Error('Некорректные заголовки загрузки.');
  let response: Response;
  try { response = await doFetch(signed.data.upload_url, { method: 'PUT', headers, body: bytes as Uint8Array<ArrayBuffer>, signal: AbortSignal.timeout(90_000), redirect: 'error' }); }
  catch { throw new Error('Не удалось отправить фото в хранилище Higgsfield.'); }
  if (!response.ok) throw new Error('Хранилище Higgsfield отклонило фото.');
  return signed.data.public_url;
}
