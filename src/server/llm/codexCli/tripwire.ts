/** JSONL is an observation tripwire, not proof that no tool was exposed to the model. */
export function checkIsolation(event: Record<string, unknown>): string[] {
  if (typeof event.type === 'string' && /hook/i.test(event.type)) return ['CLI сообщил о запуске hook'];
  if (!String(event.type).startsWith('item.')) return [];
  const item = event.item as { type?: string } | undefined;
  // An error item is CLI diagnostics (including non-fatal warnings), not a tool action.
  if (item?.type === 'agent_message' || item?.type === 'reasoning' || item?.type === 'error') return [];
  return [`неожиданное действие CLI: ${item?.type ?? 'unknown item'}`];
}
