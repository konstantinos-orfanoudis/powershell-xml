// scimToConnectorSchema.ts
export type AttrType = "String" | "Int" | "Bool" | "Datetime";
export type Attribute = { name: string; type: AttrType; MultiValue: boolean; IsKey?: boolean };
export type Entity = { name: string; attributes: Attribute[] };
export type SchemaOut = { name: string; version: string; entities: Entity[] };

type ScimAttribute = {
  name: string;
  type?: "string" | "integer" | "boolean" | "dateTime" | "reference" | "complex";
  multiValued?: boolean;
  subAttributes?: ScimAttribute[];
};
type ScimSchema = { id: string; name?: string; attributes: ScimAttribute[] };
type ScimResourceType = {
  name: string;
  schema: string;          // primary schema id
  schemaExtensions?: { schema: string; required?: boolean }[];
};

const TYPE_MAP: Record<string, AttrType> = {
  string: "String", integer: "Int", boolean: "Bool", dateTime: "Datetime",
  reference: "String", complex: "String" // complex gets flattened below
};

function flatten(attr: ScimAttribute, prefix = ""): Attribute[] {
  const baseName = prefix ? `${prefix}.${attr.name}` : attr.name;
  if (attr.type === "complex" && attr.subAttributes?.length) {
    // flatten complex by walking subAttributes
    return attr.subAttributes.flatMap(sa => flatten(sa, baseName));
  }
  const t = TYPE_MAP[attr.type ?? "string"] ?? "String";
  return [{ name: baseName, type: t, MultiValue: !!attr.multiValued }];
}

export function scimToSchema(
  resourceTypes: ScimResourceType[],
  schemas: ScimSchema[],
  opts?: { schemaName?: string; version?: string; preferUserNameAsKey?: boolean }
): SchemaOut {
  const byId = new Map(schemas.map(s => [s.id, s]));
  const out: SchemaOut = {
    name: opts?.schemaName ?? "Connector",
    version: opts?.version ?? "1.0.0",
    entities: []
  };

  for (const rt of resourceTypes) {
    const schemaIds = [rt.schema, ...(rt.schemaExtensions?.map(se => se.schema) ?? [])];
    const attrs: Attribute[] = [];
    for (const sid of schemaIds) {
      const sch = byId.get(sid);
      if (!sch) continue;
      for (const a of sch.attributes ?? []) {
        attrs.push(...flatten(a));
      }
    }

    // de-dupe by name
    const seen = new Set<string>();
    const dedup = attrs.filter(a => (seen.has(a.name) ? false : (seen.add(a.name), true)));

    // mark keys
    dedup.forEach(a => (a.IsKey = false));
    const idAttr = dedup.find(a => a.name === "id");
    if (idAttr) idAttr.IsKey = true;

    if (opts?.preferUserNameAsKey && rt.name === "User") {
      const userName = dedup.find(a => a.name === "userName");
      if (userName) {
        // if your model only allows one key, move the key flag
        if (idAttr) idAttr.IsKey = false;
        userName.IsKey = true;
      }
    }

    out.entities.push({ name: rt.name, attributes: dedup });
  }

  return out;
}
