import { describe, expect, it } from 'vitest';
import { FLOW_TEMPLATES } from '../../src/core/canvas/templates.ts';
import { FlowSchema } from '../../src/core/model/canvas.ts';
import { aiPromptProblems } from '../../src/core/canvas/ai.ts';

describe('managed B-roll templates', () => {
  for (const [templateId, shots] of [['managed-broll', 1], ['managed-five-broll', 5]] as const) {
    it(`${templateId}: separate photo/video targets and explicit shared context for ${shots} shot(s)`, () => {
      let n = 0;
      const template = FLOW_TEMPLATES.find(t => t.id === templateId)!;
      const graph = template.build(prefix => `${prefix}-${++n}`);
      const flow = FlowSchema.parse({ ...graph, id: 'f-template', name: template.titleRu, createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T10:00:00Z' });
      const ai = flow.nodes.filter(node => node.type === 'ai');
      expect(ai).toHaveLength(shots * 2);
      expect(new Set(ai.map(node => node.targetGeneratorId)).size).toBe(shots * 2);
      expect(flow.nodes.filter(node => node.modelId === 'higgsfield/soul-2')).toHaveLength(shots);
      expect(flow.nodes.filter(node => node.modelId === 'higgsfield/seedance-2-5')).toHaveLength(shots);
      const prompts = flow.nodes.filter(node => node.type === 'prompt');
      expect(prompts).toHaveLength(shots * 2);
      for (const prompt of prompts) {
        expect(prompt.text).toBe('');
        expect(prompt.aiApproval).toBeUndefined();
        expect(flow.edges.some(edge => edge.to === prompt.id && edge.port === 'idea')).toBe(true);
        expect(flow.edges.some(edge => edge.from === prompt.id && edge.port === 'prompt')).toBe(true);
        expect(aiPromptProblems(flow, prompt).length).toBeGreaterThan(0);
      }
      expect(flow.nodes.every(node => node.jobIds.length === 0)).toBe(true);
      const common = flow.nodes.find(node => node.type === 'comment' && node.label === 'Общая концепция и ограничения')!;
      expect(flow.edges.filter(edge => edge.from === common.id && edge.port === 'context')).toHaveLength(shots * 2);
      for (const node of ai) {
        const target = flow.nodes.find(candidate => candidate.id === node.targetGeneratorId)!;
        expect(target.type).toBe('generator');
        if (target.kind === 'video') {
          const ref = flow.edges.find(edge => edge.to === node.id && edge.port === 'ref')!;
          expect(flow.edges).toContainEqual(expect.objectContaining({ from: ref.from, to: target.id, port: 'start' }));
        }
      }
    });
  }
});
