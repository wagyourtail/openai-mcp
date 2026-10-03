type JSchema = Record<string, unknown>;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeOk(v: unknown, expected: string | string[]): boolean {
  const t = typeOf(v);
  const list = Array.isArray(expected) ? expected : [expected];
  return list.some((e) => (e === "number" && (t === "number" || t === "integer")) || e === t);
}

/**
 * Minimal JSON Schema validator (type/required/properties/items/enum + nesting).
 * Enough for validating local-model extraction output; not a full spec impl.
 * Returns a list of human-readable errors ([] = valid).
 */
export function validateSchema(data: unknown, schema: JSchema, path = "$"): string[] {
  const errs: string[] = [];
  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.includes(data)) {
    errs.push(`${path}: value ${JSON.stringify(data)} not in enum`);
    return errs;
  }
  if (schema.type && !typeOk(data, schema.type as string | string[])) {
    errs.push(`${path}: expected ${JSON.stringify(schema.type)}, got ${typeOf(data)}`);
    return errs;
  }
  if (typeOf(data) === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    for (const r of (schema.required as string[] | undefined) ?? []) {
      if (!(r in obj)) errs.push(`${path}: missing required property "${r}"`);
    }
    const props = (schema.properties as Record<string, JSchema> | undefined) ?? {};
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) errs.push(...validateSchema(obj[k], sub, `${path}.${k}`));
    }
  }
  if (typeOf(data) === "array" && schema.items && typeof schema.items === "object") {
    (data as unknown[]).forEach((item, i) => {
      errs.push(...validateSchema(item, schema.items as JSchema, `${path}[${i}]`));
    });
  }
  return errs;
}
