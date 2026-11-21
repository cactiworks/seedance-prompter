import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { MAX_REFERENCE_SELECTIONS, ReferenceFolderSchema, ReferenceSelectionSchema } from '../../core/references.ts';
import { LlmError } from '../llm/codexCli/provider.ts';
import type { Runner } from '../llm/tasks/write.ts';
import { ReferenceTagsSchema } from './analysis.ts';
import { createReferenceChat, ReferenceChatError } from './chat.ts';
import { ReferenceLibraryError, type ReferenceLibrary } from './library.ts';

const ThreadKeySchema = z.string().regex(/^[\w.:~-]{1,180}$/);
const ChatInputSchema = z.object({ brief: z.string().trim().max(8000), query: z.string().trim().min(1).max(4000) });
const SelectionSchema = z.object({ selection: z.array(ReferenceSelectionSchema).max(MAX_REFERENCE_SELECTIONS)
  .refine(items => new Set(items.map(item => item.id)).size === items.length) });
const FeedbackSchema = z.object({
  turnId: z.uuid(), refId: ReferenceSelectionSchema.shape.id, value: z.enum(['used', 'dismissed']),
  role: ReferenceSelectionSchema.shape.role.optional(),
});
const EditSchema = z.object({ folder: ReferenceFolderSchema.nullable().optional(), tags: ReferenceTagsSchema.optional() });
const AnalyzeSchema = z.object({ maxPending: z.number().int().positive().optional() });

export function referenceRoutes(root: string, library: ReferenceLibrary | undefined, runFor: (c: Context) => Promise<Runner>, graph = false) {
  const app = new Hono();
  app.get('/status', (c) => c.json({ enabled: library !== undefined, ...(library && graph ? { graph: true } : {}) }));
  if (!library) return app;
  const chat = createReferenceChat(root, library);
  const missing = (c: Context) => c.json({ error: 'NOT_FOUND', messageRu: 'Кадр не найден.' }, 404);
  const keyOf = (c: Context) => ThreadKeySchema.parse(c.req.param('key'));

  app.onError((error, c) => {
    if (error instanceof ReferenceLibraryError) return c.json({ error: 'REFERENCE_LIBRARY', messageRu: error.messageRu }, error.status);
    if (error instanceof ReferenceChatError) return c.json({ error: 'REFERENCE_CHAT', messageRu: error.message }, error.status);
    if (error instanceof LlmError) return c.json({ error: error.code, messageRu: error.message }, 502);
    throw error;
  });

  app.get('/cards', async (c) => c.json({ cards: await library.list() }));
  app.get('/cards/:id/image', async (c) => {
    const file = await library.imagePath(c.req.param('id'));
    if (!file) return missing(c);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
    });
  });
  app.patch('/cards/:id', async (c) => {
    const card = await library.edit(c.req.param('id'), EditSchema.parse(await c.req.json()));
    return card ? c.json({ card }) : missing(c);
  });
  app.post('/imports', async (c) => {
    const name = z.string().trim().min(1).max(240).parse(c.req.query('name'));
    return c.json({ cards: await library.importFile(name, c.req.raw.body, c.req.header('content-type')) });
  });
  app.get('/analysis', async (c) => c.json({ job: await library.analysisStatus() }));
  app.post('/analysis', async (c) => {
    const options = AnalyzeSchema.parse(c.req.header('content-type')?.startsWith('application/json') ? await c.req.json() : {});
    return c.json({ job: await library.startAnalysis(await runFor(c), options.maxPending) });
  });
  app.post('/analysis/cancel', async (c) => c.json({ job: await library.stopAnalysis() }));
  app.get('/threads/:key', async (c) => c.json({ thread: await chat.get(keyOf(c)) }));
  app.post('/threads/:key', async (c) => c.json({ thread: await chat.search(keyOf(c), ChatInputSchema.parse(await c.req.json()), () => runFor(c), c.req.raw.signal) }));
  app.patch('/threads/:key', async (c) => c.json({ thread: await chat.setSelection(keyOf(c), SelectionSchema.parse(await c.req.json()).selection) }));
  app.post('/threads/:key/feedback', async (c) => {
    await chat.recordFeedback(keyOf(c), FeedbackSchema.parse(await c.req.json()));
    return c.body(null, 204);
  });
  return app;
}
