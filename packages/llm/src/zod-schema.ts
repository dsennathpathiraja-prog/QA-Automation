import type { ZodType, ZodTypeDef } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { StructuredSchema } from './types';

/** Adapts a Zod schema to the gateway's schema interface (JSON Schema for constrained decoding + validation). */
export function fromZod<T>(schema: ZodType<T, ZodTypeDef, unknown>): StructuredSchema<T> {
  const { $schema: _ignored, ...jsonSchema } = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>;
  return {
    jsonSchema,
    safeParse: (v) => {
      const r = schema.safeParse(v);
      return r.success ? { success: true, data: r.data } : { success: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
    },
  };
}
