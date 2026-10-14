import { z } from 'zod';

type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => value !== null && typeof value === 'object' && !Array.isArray(value);

/** OpenAI strict output requires all properties. Existing optional fields use nullable wire values. */
export function strictSchema(schema: object): object {
  const visit = (node: Schema): Schema => {
    const out = { ...node };
    if (object(node.properties)) {
      const required = new Set(Array.isArray(node.required) ? node.required as string[] : []);
      out.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => {
        const child = visit(value as Schema);
        return [key, required.has(key) ? child : { anyOf: [child, { type: 'null' }] }];
      }));
      out.required = Object.keys(node.properties);
      out.additionalProperties = false;
    }
    if (object(node.items)) out.items = visit(node.items);
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(node[key])) out[key] = node[key].map((value: Schema) => visit(value));
    }
    return out;
  };
  return visit(schema as Schema);
}

/** Remove only null placeholders for fields that were optional in the original contract. */
function restoreOptionals(value: unknown, schema: Schema): unknown {
  if (Array.isArray(value) && object(schema.items)) return value.map((item) => restoreOptionals(item, schema.items as Schema));
  if (!object(value) || !object(schema.properties)) return value;
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  const properties = schema.properties;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !(item === null && !required.has(key) && object(properties[key])))
    .map(([key, item]) => [key, object(properties[key]) ? restoreOptionals(item, properties[key]) : item]));
}

export function parseStructured<T>(text: string, schema: object): T {
  const value = restoreOptionals(JSON.parse(text) as unknown, schema as Schema);
  // Keep a local check even though Codex requests structured output remotely.
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]).parse(value) as T;
}
