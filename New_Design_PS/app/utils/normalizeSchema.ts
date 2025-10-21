// utils/normalizeSchema.ts
export type UiType = "String" | "Bool" | "Int" | "DateTime";

export interface SchemaAttr {
  name: string;
  type?: UiType | string;
}

export interface SchemaEntity {
  name: string;
  attributes?: SchemaAttr[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function getString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function normalizeEntity(e: unknown): SchemaEntity | null {
  if (!isRecord(e)) return null;

  const name = getString(e.name)?.trim();
  if (!name) return null;

  const rawAttrs = Array.isArray(e.attributes) ? e.attributes : [];
  const attributes: SchemaAttr[] = [];

  for (const a of rawAttrs) {
    if (!isRecord(a)) continue;
    const attrName = getString(a.name)?.trim();
    if (!attrName) continue;
    const typeVal = getString(a.type);
    attributes.push({ name: attrName, type: typeVal });
  }

  return { name, attributes };
}

/** Accepts either `{ entities: [...] }` or just `[...]`. */
export function normalizeSchemaJson(text: string): SchemaEntity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unable to parse JSON.";
    throw new Error(`Invalid JSON: ${msg}`);
  }

  let entitiesRaw: unknown;
  if (isRecord(parsed) && Array.isArray(parsed.entities)) {
    entitiesRaw = parsed.entities;
  } else if (Array.isArray(parsed)) {
    entitiesRaw = parsed;
  } else {
    throw new Error(
      'Expected JSON with shape { "entities": [...] } or a raw array of entities.'
    );
  }

  const out: SchemaEntity[] = [];
  for (const e of entitiesRaw as unknown[]) {
    const ent = normalizeEntity(e);
    if (ent) out.push(ent);
  }

  if (out.length === 0) {
    throw new Error("No valid entities found in schema JSON.");
  }
  return out;
}
