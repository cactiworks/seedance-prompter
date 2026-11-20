import { Hono } from 'hono';
import { z } from 'zod';
import { FlowSchema } from '../../core/model/canvas.ts';
import type { Accounts } from '../accounts/service.ts';
import type { CanvasAi } from './service.ts';

const Snapshot = z.object({ flow: FlowSchema }).strict();
const Approval = z.object({ flow: FlowSchema, expectedRevision: z.number().int().positive() }).strict();
const Retry = z.object({ flow: FlowSchema, requestId: z.uuid(), previewDigest: z.string().regex(/^[a-f0-9]{64}$/), consent: z.literal(true) }).strict();
const Start = z.object({ flowId: z.string(), nodeId: z.string(), stage: z.enum(['idea', 'prompt']), requestId: z.uuid(), flow: FlowSchema, previewDigest: z.string().regex(/^[a-f0-9]{64}$/), feedbackRu: z.string().max(12000).default(''), consent: z.literal(true) }).strict();

/** No route reads browser chat/profile; only saved graph snapshots and an explicit click. */
export function canvasAiRoutes(runtime: CanvasAi, accounts?: Accounts) {
  return new Hono()
    .get('/preview', async c => c.json(await runtime.preview(z.string().min(1).parse(c.req.query('flowId')), z.string().min(1).parse(c.req.query('nodeId')))))
    .get('/runs', async c => c.json(await runtime.list(z.string().min(1).parse(c.req.query('flowId')), c.req.query('nodeId'))))
    .get('/runs/:id', async c => c.json(await runtime.get(c.req.param('id'))))
    .post('/runs', async c => {
      const input = Start.parse(await c.req.json());
      return c.json(await runtime.start(input, await accounts?.requireAccount(c)), 202);
    })
    .post('/runs/:id/cancel', async c => c.json(await runtime.cancel(c.req.param('id'), Snapshot.parse(await c.req.json()).flow)))
    .post('/runs/:id/retry', async c => {
      const input = Retry.parse(await c.req.json());
      return c.json(await runtime.retry(c.req.param('id'), input.flow, input.requestId, input.previewDigest, await accounts?.requireAccount(c)), 202);
    })
    .post('/runs/:id/approve', async c => {
      const input = Approval.parse(await c.req.json());
      return c.json(await runtime.approve(c.req.param('id'), input.flow, input.expectedRevision));
    })
    .post('/runs/:id/revalidate', async c => {
      const input = Approval.parse(await c.req.json());
      return c.json(await runtime.revalidate(c.req.param('id'), input.flow, input.expectedRevision));
    })
    .post('/runs/:id/prompt-node', async c => {
      const input = Approval.parse(await c.req.json());
      return c.json(await runtime.promptNode(c.req.param('id'), input.flow, input.expectedRevision));
    })
    .post('/runs/:id/restore', async c => {
      const input = Approval.parse(await c.req.json());
      return c.json(await runtime.restore(c.req.param('id'), input.flow, input.expectedRevision));
    })
    .post('/accept-media', async c => {
      const input = z.object({ flowId: z.string(), nodeId: z.string(), flow: FlowSchema, jobId: z.string(), mediaId: z.string() }).strict().parse(await c.req.json());
      return c.json(await runtime.acceptMedia(input));
    });
}
