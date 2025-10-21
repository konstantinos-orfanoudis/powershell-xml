/* app/schema-review/page.tsx */
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

/* ------------------------------------------------------------
   Types
------------------------------------------------------------ */
type FilePayload = { name: string; type: string; text: string };
type SourcesPayload = {
  mode: "auto" | "specific";
  protocol?: "rest" | "graphql" | "soap" | "postman" | "samples";
  files: FilePayload[];
};

type AttrType =
  | "String"
  | "Number"
  | "Boolean"
  | "DateTime"
  | "Object"
  | "Array"
  | "No_Read";

// Only scalar types (used internally; final schema maps scalar arrays via itemsType)
type ScalarType = Exclude<AttrType, "Array" | "Object" | "No_Read">;

interface Attribute {
  name: string;
  type: AttrType;
  /** If Array of objects, reference helper/child entity (not used on primary anymore) */
  ref?: string;
  /** If Array of scalars, item type (used to export MultiValue + DataType) */
  itemsType?: ScalarType;
}

interface Entity {
  name: string;
  attributes: Attribute[];
  origins?: string[];
}

interface Inference {
  entities: Entity[];
  notes: string[];
  warnings: string[];
}

const DEFAULT_SCHEMA_META = {
  name: "Connector",
  version: "1.0.0",
};

/* ------------------------------------------------------------
   Small helpers
------------------------------------------------------------ */
function isIsoDateLike(s: string) {
  return /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+\-]\d{2}:\d{2})?)?$/.test(s);
}
function guessAttrType(v: unknown): AttrType {
  if (v === null || v === undefined) return "String";
  if (typeof v === "boolean") return "Boolean";
  if (typeof v === "number" && Number.isFinite(v)) return "Number";
  if (typeof v === "string") {
    if (/^(true|false)$/i.test(v)) return "Boolean";
    if (!isNaN(Number(v)) && v.trim() !== "") return "Number";
    if (isIsoDateLike(v)) return "DateTime";
    return "String";
  }
  if (Array.isArray(v)) return "Array";
  if (typeof v === "object") return "Object";
  return "String";
}
function uniq<T>(arr: T[], key: (t: T) => string) {
  const m = new Map<string, T>();
  for (const x of arr) {
    const k = key(x);
    if (!m.has(k)) m.set(k, x);
  }
  return Array.from(m.values());
}
function sortAttrs(attrs: Attribute[]): Attribute[] {
  const rank = (t: AttrType) =>
    t === "String" ? 2 : t === "Number" ? 1 : t === "Boolean" ? 3 : t === "DateTime" ? 4 : 9;
  return [...attrs].sort((a, b) => a.name.localeCompare(b.name) || rank(a.type) - rank(b.type));
}
function normalizeEntityName(n: string) {
  if (!n) return "Entity";
  const clean = n.replace(/[_\-]+/g, " ").trim();
  let titled = clean.replace(/\b\w/g, (m) => m.toUpperCase()).replace(/\s+/g, "");
  if (/\w+s$/i.test(titled) && titled.length > 3) titled = titled.slice(0, -1);
  return titled;
}
function addOrigin(e: Entity, file: string) {
  e.origins = Array.from(new Set([...(e.origins || []), file]));
}
function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/* ------------------------------------------------------------
   Naming helpers
------------------------------------------------------------ */
function toSnake(s: string) {
  return s
    .replace(/[.\s]+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}
function entityPrefix(entityName: string) {
  return toSnake(entityName).toLowerCase();
}
function makeAttrName(entityName: string, path: string, isHelper: boolean) {
  const ep = entityPrefix(entityName);
  const p = toSnake(path);
  return isHelper ? `${ep}_hlp_${p}` : `${ep}_${p}`;
}
function titleCase(s: string) {
  return s.replace(/[_\-\s]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()).replace(/\s+/g, "");
}
function lastSegment(path: string) {
  const p = path.split(".").filter(Boolean);
  return p[p.length - 1] || "Item";
}
function singularize(s: string) {
  return /\w+s$/i.test(s) && s.length > 3 ? s.slice(0, -1) : s;
}
function childEntityNameFromPath(path: string) {
  return titleCase(singularize(lastSegment(path))); // e.g., "factors" -> "Factor"
}
function assignmentEntityName(primary: string, child: string) {
  return `${primary}Has${child}`; // e.g., OktaUserHasFactor
}

/* ------------------------------------------------------------
   Array utilities
------------------------------------------------------------ */
const SAMPLE_ROWS = 20;
function sampleArray<T>(arr: T[], n = SAMPLE_ROWS): T[] {
  const out: T[] = [];
  for (const x of arr) {
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}
function mergeScalarTypes(types: ScalarType[]): ScalarType {
  const u = Array.from(new Set(types));
  if (u.includes("DateTime")) return "DateTime";
  if (u.length === 1) return u[0];
  if (u.includes("String")) return "String";
  if (u.includes("Number")) return "Number";
  if (u.includes("Boolean")) return "Boolean";
  return "String";
}
function inferArrayItemsType(values: any[]): ScalarType {
  const observed: ScalarType[] = [];
  for (const v of values) {
    if (v === null || typeof v === "object") continue; // only scalars
    const t = guessAttrType(v);
    if (t === "String" || t === "Number" || t === "Boolean" || t === "DateTime") {
      observed.push(t);
    }
  }
  if (observed.length === 0) return "String";
  return mergeScalarTypes(observed);
}

/* ------------------------------------------------------------
   Signature utils (to dedupe child entities)
------------------------------------------------------------ */
type SigAttr = { name: string; type: AttrType };
function attrsFromObjectShallow(o: Record<string, any>): SigAttr[] {
  const out: SigAttr[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === null || typeof v !== "object") {
      out.push({ name: k, type: guessAttrType(v) });
    } else if (Array.isArray(v)) {
      out.push({ name: k, type: "Array" });
    } else {
      out.push({ name: k, type: "Object" });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.type > b.type ? 1 : -1));
}
function signatureFromAttrs(attrs: SigAttr[]): string {
  return attrs.map((a) => `${a.name}:${a.type}`).join("|");
}

/* ------------------------------------------------------------
   Deep-merge rows (preserve nested fields across rows)
------------------------------------------------------------ */
function deepMergeSample(a: any, b: any): any {
  if (a === undefined || a === null) return b;
  if (b === undefined || b === null) return a;

  if (Array.isArray(a) && Array.isArray(b)) {
    const aHasObj = a.some((x) => x && typeof x === "object" && !Array.isArray(x));
    const bHasObj = b.some((x) => x && typeof x === "object" && !Array.isArray(x));
    if (aHasObj && !bHasObj) return a;
    if (bHasObj && !aHasObj) return b;
    return a.length >= b.length ? a : b;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, any> = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = k in out ? deepMergeSample(out[k], v) : v;
    }
    return out;
  }

  if (isPlainObject(a) && !isPlainObject(b)) return a;
  if (!isPlainObject(a) && isPlainObject(b)) return b;

  if (typeof a === "string" && typeof b === "string") {
    const aISO = isIsoDateLike(a);
    const bISO = isIsoDateLike(b);
    if (aISO && !bISO) return a;
    if (bISO && !aISO) return b;
    return b.length > a.length ? b : a;
  }

  return b ?? a;
}
function deepMergeRows(rows: Record<string, any>[]): Record<string, any> {
  return rows.reduce((acc, r) => {
    for (const [k, v] of Object.entries(r)) {
      acc[k] = k in acc ? deepMergeSample(acc[k], v) : v;
    }
    return acc;
  }, {} as Record<string, any>);
}

/* ------------------------------------------------------------
   Inference per format
------------------------------------------------------------ */

// OpenAPI (JSON only here)
function inferFromOpenApiJSON(json: any, fileName: string): Inference {
  const out: Entity[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];

  try {
    const schemas = json?.components?.schemas;
    if (schemas && typeof schemas === "object") {
      for (const [name, def] of Object.entries<any>(schemas)) {
        if (def?.type === "object" && def?.properties) {
          const attrs: Attribute[] = [];
          for (const [pname, pd] of Object.entries<any>(def.properties)) {
            const t = String(pd?.type || "string").toLowerCase();
            let at: AttrType =
              t === "integer" || t === "number"
                ? "Number"
                : t === "boolean"
                ? "Boolean"
                : t === "array"
                ? "Array"
                : t === "object"
                ? "Object"
                : pd?.format === "date-time"
                ? "DateTime"
                : "String";
            attrs.push({ name: pname, type: at });
          }
          const ent: Entity = { name: normalizeEntityName(name), attributes: sortAttrs(attrs) };
          addOrigin(ent, fileName);
          out.push(ent);
        }
      }
      if (out.length === 0) {
        notes.push("OpenAPI found but no components.schemas with object properties.");
      }
    } else {
      warnings.push("OpenAPI JSON missing components.schemas — falling back to samples if any.");
    }
  } catch {
    warnings.push("Failed to read OpenAPI JSON. Falling back to samples.");
  }

  return { entities: out, notes, warnings };
}

// GraphQL Introspection JSON
function inferFromGraphQLIntrospection(json: any, fileName: string): Inference {
  const out: Entity[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];

  const types = json?.data?.__schema?.types || json?.__schema?.types;
  if (Array.isArray(types)) {
    for (const t of types) {
      if (t?.kind === "OBJECT" && !t?.name?.startsWith("__")) {
        const fields = Array.isArray(t.fields) ? t.fields : [];
        const attrs: Attribute[] = [];
        for (const f of fields) {
          const base = (f?.type?.name || f?.type?.ofType?.name || "String").toLowerCase();
          let at: AttrType =
            base === "int" || base === "float" || base === "decimal" || base === "number"
              ? "Number"
              : base === "boolean" || base === "bool"
              ? "Boolean"
              : base === "id" || base === "string"
              ? "String"
              : "String";
          attrs.push({ name: f?.name || "field", type: at });
        }
        if (attrs.length) {
          const ent: Entity = { name: normalizeEntityName(t.name), attributes: sortAttrs(attrs) };
          addOrigin(ent, fileName);
          out.push(ent);
        }
      }
    }
    if (out.length === 0) notes.push("GraphQL types present but no object fields detected.");
  } else {
    warnings.push("Not a GraphQL introspection JSON (no __schema.types).");
  }

  return { entities: out, notes, warnings };
}

/* ------------------------------------------------------------
   JSON Samples — Primary + Child + Assignment
   - 1:1 stays flattened on primary
   - Array of scalars => mark as Array with itemsType (exported as MultiValue with type string)
   - Array of objects => create Child entity + Assignment entity (PrimaryHasChild)
------------------------------------------------------------ */
function inferFromJSONSample(obj: any, fileName: string, preferName?: string): Inference {
  const notes: string[] = [];
  const warnings: string[] = [];
  const entities: Entity[] = [];

  const primaryName = normalizeEntityName(preferName || "Items");
  const primaryLower = entityPrefix(primaryName);

  // Stores child entities and assignment entities by name
  const childEntities = new Map<string, Entity>();
  const assignmentEntities = new Map<string, Entity>();

  // Keep track of child signatures to dedupe entity definitions
  const childSignatureToName = new Map<string, string>();

  function ensureChildEntity(childName: string, sampleItem: Record<string, any>) {
    // Build a signature from shallow fields to dedupe
    const sig = signatureFromAttrs(attrsFromObjectShallow(sampleItem));
    const existingName = childSignatureToName.get(sig);
    const effectiveName = existingName || childName;

    if (!existingName) childSignatureToName.set(sig, effectiveName);

    if (!childEntities.has(effectiveName)) {
      const childAttrs: Attribute[] = [];
      for (const [k, v] of Object.entries(sampleItem)) {
        if (v === null || typeof v !== "object") {
          childAttrs.push({ name: k, type: guessAttrType(v) });
        } else if (Array.isArray(v)) {
          const objs = (v as any[]).filter((x) => x && typeof x === "object" && !Array.isArray(x));
          if (objs.length > 0) {
            // nested list inside child: model as String (serialized) for simplicity
            childAttrs.push({ name: k, type: "String" });
          } else {
            // list of scalars -> String (serialized)
            childAttrs.push({ name: k, type: "String" });
          }
        } else {
          // nested object inside child: keep as Object (opaque)
          childAttrs.push({ name: k, type: "Object" });
        }
      }
      childEntities.set(effectiveName, {
        name: effectiveName,
        attributes: sortAttrs(childAttrs),
        origins: [fileName],
      });
    }
    return childSignatureToName.get(sig)!; // return final name
  }

  function ensureAssignmentEntity(childName: string) {
    const name = assignmentEntityName(primaryName, childName); // e.g., OktaUserHasFactor
    if (!assignmentEntities.has(name)) {
      const attrs: Attribute[] = [
        { name: `${primaryLower}_id`, type: "String" },
        { name: `${entityPrefix(childName)}_id`, type: "String" },
      ];
      assignmentEntities.set(name, {
        name,
        attributes: sortAttrs(attrs),
        origins: [fileName],
      });
    }
  }

  function collectFlatAttributesFromObject(
    entityName: string,
    basePath: string,
    obj: Record<string, any>,
    accAttrs: Attribute[],
  ) {
    for (const [k, v] of Object.entries(obj)) {
      const path = basePath ? `${basePath}.${k}` : k;

      // ---- Scalars ----
      if (v === null || typeof v !== "object") {
        const isHelper = basePath !== "";
        const name = makeAttrName(entityName, path, isHelper);
        accAttrs.push({ name, type: guessAttrType(v) });
        continue;
      }

      // ---- Arrays ----
      if (Array.isArray(v)) {
        const isNested = basePath !== "";
        const name = makeAttrName(entityName, path, isNested);

        const objs = v.filter((x) => x && typeof x === "object" && !Array.isArray(x)) as Record<
          string,
          any
        >[];

        if (objs.length > 0) {
          // 1:N of OBJECTS => create Child entity + Assignment entity
          const rep = objs.find((o) => o && Object.keys(o).length > 0) || objs[0];
          const childBase = childEntityNameFromPath(path); // e.g., "Factor"
          const childName = ensureChildEntity(childBase, rep);
          ensureAssignmentEntity(childName);

          // NOTE: we NO LONGER add a list attribute to the primary for object arrays
          // Relationship is now modeled via assignment entity
        } else {
          // Array of SCALARS => mark as Array and keep itemsType for export
          const itemType = inferArrayItemsType(v as any[]);
          accAttrs.push({ name, type: "Array", itemsType: itemType });
        }
        continue;
      }

      // ---- Plain OBJECT ----
      const objVal = v as Record<string, any>;
      const keys = Object.keys(objVal);
      if (keys.length === 0) {
        // Okta special-case: credentials.password == {}
        const isHelper = basePath !== "";
        const name = makeAttrName(entityName, path, isHelper);
        if (path.toLowerCase() === "credentials.password") {
          accAttrs.push({ name, type: "No_Read" });
        } else {
          accAttrs.push({ name, type: "Object" });
        }
        continue;
      }
      // non-empty object: recurse (flatten into primary)
      collectFlatAttributesFromObject(entityName, path, objVal, accAttrs);
    }
  }

  try {
    const primaryAttrs: Attribute[] = [];

    if (Array.isArray(obj)) {
      const rows = sampleArray(obj, SAMPLE_ROWS).filter(isPlainObject) as Record<string, any>[];
      if (rows.length === 0) {
        if (obj.length > 0) {
          // top-level array of scalars => MultiValue with scalar item type
          const name = makeAttrName(primaryName, "value", false);
          const itemType = inferArrayItemsType(obj as any[]);
          primaryAttrs.push({ name, type: "Array", itemsType: itemType });
        } else {
          warnings.push("JSON array is empty; no attributes inferred.");
        }
      } else {
        const merged = deepMergeRows(rows);
        collectFlatAttributesFromObject(primaryName, "", merged, primaryAttrs);
      }
    } else if (isPlainObject(obj)) {
      collectFlatAttributesFromObject(primaryName, "", obj, primaryAttrs);
    } else {
      warnings.push("JSON is not an object/array; skipping.");
    }

    const primary: Entity = {
      name: primaryName,
      attributes: sortAttrs(dedupeAttributes(primaryAttrs)),
      origins: [fileName],
    };

    entities.push(
      primary,
      ...Array.from(childEntities.values()),
      ...Array.from(assignmentEntities.values())
    );
  } catch {
    warnings.push("Failed to analyze JSON sample.");
  }

  return { entities, notes, warnings };
}

/* ------------------------------------------------------------
   XML / CSV inference
------------------------------------------------------------ */
function inferFromXML(xmlText: string, fileName: string): Inference {
  const notes: string[] = [];
  const warnings: string[] = [];
  const entities: Entity[] = [];

  try {
    const dom = new DOMParser().parseFromString(xmlText, "application/xml");
    if (dom.getElementsByTagName("parsererror").length > 0) {
      warnings.push("XML is not well-formed.");
      return { entities, notes, warnings };
    }

    const xsNs = ["http://www.w3.org/2001/XMLSchema", "http://www.w3.org/2001/XMLSchema/"];
    const schemaNodes = xsNs.flatMap((ns) =>
      Array.from(dom.getElementsByTagNameNS(ns, "complexType"))
    );
    if (schemaNodes.length > 0) {
      for (const ct of schemaNodes) {
        const name = ct.getAttribute("name") || "Type";
        const attrs: Attribute[] = [];
        const elements = xsNs.flatMap((ns) =>
          Array.from(ct.getElementsByTagNameNS(ns, "element"))
        );
        for (const el of elements) {
          const ename = el.getAttribute("name") || "field";
          const etype = (el.getAttribute("type") || "").toLowerCase();
          let at: AttrType =
            /int|decimal|double|float|number/.test(etype)
              ? "Number"
              : /bool/.test(etype)
              ? "Boolean"
              : /date/.test(etype)
              ? "DateTime"
              : "String";
          attrs.push({ name: ename, type: at });
        }
        if (attrs.length) {
          const ent: Entity = { name: normalizeEntityName(name), attributes: sortAttrs(attrs) };
          addOrigin(ent, fileName);
          entities.push(ent);
        }
      }
      if (entities.length === 0) notes.push("XSD complexTypes found but no elements with names.");
      return { entities, notes, warnings };
    }

    const allElems = Array.from(dom.getElementsByTagName("*"));
    const counts = new Map<string, number>();
    for (const el of allElems) {
      const n = el.tagName;
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    const cand = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (cand) {
      const samples = Array.from(dom.getElementsByTagName(cand)).slice(0, 10);
      const fields = new Set<string>();
      for (const s of samples) {
        Array.from(s.children).forEach((c) => fields.add(c.tagName));
      }
      const attrs: Attribute[] = [];
      for (const f of Array.from(fields)) {
        const val =
          Array.from(samples[0]?.getElementsByTagName(f) || [])[0]?.textContent?.trim() || "";
        attrs.push({ name: f, type: guessAttrType(val) });
      }
      if (attrs.length) {
        const ent: Entity = { name: normalizeEntityName(cand), attributes: sortAttrs(attrs) };
        addOrigin(ent, fileName);
        entities.push(ent);
      }
    } else {
      warnings.push("XML parsed but no useful repeating structures found.");
    }
  } catch {
    warnings.push("Failed to parse XML.");
  }

  return { entities, notes, warnings };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/^"|"$/g, ""));
}

function inferFromCSV(text: string, fileName: string): Inference {
  const notes: string[] = [];
  const warnings: string[] = [];
  const entities: Entity[] = [];

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    warnings.push("CSV is empty.");
    return { entities, notes, warnings };
  }
  const header = parseCsvLine(lines[0]).filter(Boolean);
  if (header.length === 0) {
    warnings.push("CSV has no header row.");
    return { entities, notes, warnings };
  }

  const sample = lines[1] ? parseCsvLine(lines[1]) : [];
  const entName = normalizeEntityName(fileName.replace(/\.\w+$/, ""));
  const attrs: Attribute[] = header.map((h, i) => ({
    name: makeAttrName(entName, h, false),
    type: guessAttrType(sample[i]),
  }));
  const ent: Entity = { name: entName, attributes: sortAttrs(attrs) };
  addOrigin(ent, fileName);
  entities.push(ent);

  return { entities, notes, warnings };
}

/* ------------------------------------------------------------
   Attribute dedupe
------------------------------------------------------------ */
function dedupeAttributes(attrs: Attribute[]): Attribute[] {
  const byName = new Map<string, Attribute>();
  for (const a of attrs) {
    const ex = byName.get(a.name);
    if (!ex) {
      byName.set(a.name, a);
      continue;
    }
    // Prefer wider types; keep metadata
    const order = (t: AttrType) =>
      t === "Array" ? 5 : t === "Object" ? 4 : t === "DateTime" ? 3 : t === "String" ? 2 : t === "Number" ? 1 : 0;
    const keep = order(a.type) >= order(ex.type) ? a : ex;
    if (keep === a && ex) {
      if (!a.ref && ex.ref) a.ref = ex.ref;
      if (!a.itemsType && ex.itemsType) a.itemsType = ex.itemsType;
    }
    byName.set(a.name, keep);
  }
  return Array.from(byName.values());
}

/* ------------------------------------------------------------
   Export helpers (normalize datatypes + MultiValue)
------------------------------------------------------------ */
// Maps internal Attr/Scalar types to exported primitive: String | Int | Float | Bool | Datetime
function normalizePrimitive(
  t: "String" | "Number" | "Boolean" | "DateTime" | "Object" | "No_Read" | "Array" | ScalarType
): "String" | "Int" | "Float" | "Bool" | "Datetime" {
  if (t === "Boolean") return "Bool";
  if (t === "DateTime") return "Datetime";
  if (t === "Number") return "Float"; // safe default (can refine to Int later)
  return "String"; // Object, No_Read, Array (fallback), anything else
}

function normalizeScalarPrimitive(t: ScalarType): "String" | "Int" | "Float" | "Bool" | "Datetime" {
  if (t === "Boolean") return "Bool";
  if (t === "DateTime") return "Datetime";
  if (t === "Number") return "Float"; // safe default
  return "String";
}

function exportAttrShape(a: Attribute): { type: string; MultiValue: boolean } {
  if (a.type === "Array") {
    // Multi-value attribute of homogeneous scalar items
    const item = a.itemsType ? normalizeScalarPrimitive(a.itemsType) : "String";
    return { type: item, MultiValue: true };
  }
  const base = normalizePrimitive(a.type);
  return { type: base, MultiValue: false };
}

/* ------------------------------------------------------------
   Main page
------------------------------------------------------------ */
export default function SchemaReviewPage() {
  const router = useRouter();
  const [sources, setSources] = useState<SourcesPayload | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [selected, setSelected] = useState<number>(0);
  const [schemaText, setSchemaText] = useState<string>("");
  const [loading, setLoading] = useState(true);

  // load sources
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("schema.sources.v1");
      if (!raw) {
        router.replace("/schema-setup");
        return;
      }
      setSources(JSON.parse(raw) as SourcesPayload);
    } catch {
      router.replace("/schema-setup");
      return;
    } finally {
      setLoading(false);
    }
  }, [router]);

  // run inference
  useEffect(() => {
    if (!sources) return;

    const accEntities: Entity[] = [];
    const accNotes: string[] = [];
    const accWarns: string[] = [];

    for (const f of sources.files) {
      const name = f.name.toLowerCase();

      if (name.endsWith(".json")) {
        try {
          const parsed = JSON.parse(f.text);
          if (parsed?.openapi || parsed?.swagger) {
            const inf = inferFromOpenApiJSON(parsed, f.name);
            accEntities.push(...inf.entities);
            accNotes.push(...inf.notes);
            accWarns.push(...inf.warnings);
            continue;
          }
          if (parsed?.data?.__schema || parsed?.__schema) {
            const inf = inferFromGraphQLIntrospection(parsed, f.name);
            accEntities.push(...inf.entities);
            accNotes.push(...inf.notes);
            accWarns.push(...inf.warnings);
            continue;
          }
          const prefer = f.name.replace(/\.\w+$/, "");
          const inf = inferFromJSONSample(parsed, f.name, prefer);
          accEntities.push(...inf.entities);
          accNotes.push(...inf.notes);
          accWarns.push(...inf.warnings);
          continue;
        } catch {
          // not JSON — fallthrough
        }
      }

      if (name.endsWith(".graphql") || name.endsWith(".gql")) {
        accNotes.push(
          `${f.name}: GraphQL SDL provided — object type parsing not implemented in-browser.`
        );
        continue;
      }

      if (name.endsWith(".xml") || name.endsWith(".wsdl") || name.endsWith(".xsd")) {
        const inf = inferFromXML(f.text, f.name);
        accEntities.push(...inf.entities);
        accNotes.push(...inf.notes);
        accWarns.push(...inf.warnings);
        continue;
      }

      if (name.endsWith(".csv")) {
        const inf = inferFromCSV(f.text, f.name);
        accEntities.push(...inf.entities);
        accNotes.push(...inf.notes);
        accWarns.push(...inf.warnings);
        continue;
      }

      accWarns.push(`${f.name}: Unrecognized format — skipped.`);
    }

    // Merge entities by name, merging attributes (with dedupe)
    const merged = new Map<string, Entity>();
    for (const e of accEntities) {
      const key = e.name;
      const ex = merged.get(key);
      if (!ex) {
        merged.set(key, { ...e, attributes: sortAttrs(e.attributes) });
      } else {
        const all = [...ex.attributes, ...e.attributes];
        ex.attributes = sortAttrs(dedupeAttributes(all));
        ex.origins = Array.from(new Set([...(ex.origins || []), ...(e.origins || [])]));
        merged.set(key, ex);
      }
    }
    const final = Array.from(merged.values());
    setEntities(final);
    setWarnings(accWarns);
    setNotes(accNotes);
  }, [sources]);

  // regenerate schema text when entities change
  useEffect(() => {
    const schema = {
      ...DEFAULT_SCHEMA_META,
      entities: entities.map((e) => ({
        name: e.name,
        attributes: e.attributes.map((a) => {
          const out = exportAttrShape(a);
          return {
            name: a.name,
            type: out.type,       // always a string now
            MultiValue: out.MultiValue,
          };
        }),
      })),
    };
    setSchemaText(JSON.stringify(schema, null, 2));
  }, [entities]);

  function updateEntityName(idx: number, name: string) {
    const next = [...entities];
    next[idx] = { ...next[idx], name: name || "Entity" };
    setEntities(next);
  }
  function updateAttrName(ei: number, ai: number, name: string) {
    const next = [...entities];
    const attrs = [...next[ei].attributes];
    attrs[ai] = { ...attrs[ai], name: name || "field" };
    next[ei].attributes = sortAttrs(attrs);
    setEntities(next);
  }
  function updateAttrType(ei: number, ai: number, type: AttrType) {
    const next = [...entities];
    const attrs = [...next[ei].attributes];
    attrs[ai] = { ...attrs[ai], type };
    next[ei].attributes = sortAttrs(attrs);
    setEntities(next);
  }
  function removeAttr(ei: number, ai: number) {
    const next = [...entities];
    const attrs = [...next[ei].attributes];
    attrs.splice(ai, 1);
    next[ei].attributes = attrs;
    setEntities(next);
  }

  function handleDownload() {
    const blob = new Blob([schemaText], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "schema.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleCopy() {
    navigator.clipboard.writeText(schemaText).catch(() => {});
  }

  function handleContinue() {
    try {
      const parsed = JSON.parse(schemaText);
      sessionStorage.setItem("schema.generated.v1", JSON.stringify(parsed));
      router.push("/upload");
    } catch {
      alert("schema.json is not valid JSON.");
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen grid place-items-center bg-slate-50">
        <div className="text-slate-600 text-sm">Loading…</div>
      </main>
    );
  }

  if (!sources) return null;

  return (
    <main className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-slate-900 text-white border-b border-slate-800">
        <div className="mx-auto max-w-7xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.replace("/schema-setup")}
              className="rounded-md border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
            >
              ← Back
            </button>
            <h1 className="text-lg font-semibold">Review & Generate schema.json</h1>
          </div>
          <div className="text-sm opacity-80">
            Sources: {sources.files.length} file{sources.files.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="mx-auto max-w-7xl px-4 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Entities list & source notes */}
        <aside className="lg:col-span-1 space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="px-4 py-3 border-b border-slate-100">
              <div className="text-sm font-semibold text-slate-900">Entities ({entities.length})</div>
            </div>
            <ul className="max-h-[55vh] overflow-auto divide-y divide-slate-100">
              {entities.map((e, i) => (
                <li key={i} className={`p-3 ${selected === i ? "bg-slate-50" : ""}`}>
                  <button
                    className="w-full text-left"
                    onClick={() => setSelected(i)}
                    title={e.origins?.join(", ")}
                  >
                    <div className="text-sm font-semibold text-slate-900">{e.name}</div>
                    <div className="text-xs text-slate-500">
                      {e.attributes.length} attributes
                      {e.origins?.length ? ` · ${e.origins.join(" · ")}` : ""}
                    </div>
                  </button>
                </li>
              ))}
              {entities.length === 0 && (
                <li className="p-3 text-sm text-amber-800 bg-amber-50">
                  No entities inferred yet. Try adding different files or formats.
                </li>
              )}
            </ul>
          </div>

          {warnings.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-semibold mb-1">Warnings</div>
              <ul className="list-disc ml-5 space-y-1">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {notes.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
              <div className="font-semibold mb-1">Notes</div>
              <ul className="list-disc ml-5 space-y-1">
                {notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        {/* Middle: Entity editor */}
        <section className="lg:col-span-1">
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">Entity Editor</div>
            </div>

            {entities[selected] ? (
              <div className="p-4 space-y-4">
                <div>
                  <label className="text-xs text-slate-600">Entity name</label>
                  <input
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    value={entities[selected].name}
                    onChange={(e) => updateEntityName(selected, e.target.value)}
                  />
                </div>

                <div>
                  <div className="text-xs text-slate-600 mb-2">
                    Attributes ({entities[selected].attributes.length})
                  </div>
                  <div className="space-y-2">
                    {entities[selected].attributes.map((a, ai) => (
                      <div
                        key={`${a.name}-${ai}`}
                        className="grid grid-cols-12 gap-2 items-center"
                      >
                        <input
                          className="col-span-7 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                          value={a.name}
                          onChange={(e) => updateAttrName(selected, ai, e.target.value)}
                        />
                        <select
                          className="col-span-4 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                          value={a.type}
                          onChange={(e) =>
                            updateAttrType(selected, ai, e.target.value as AttrType)
                          }
                        >
                          <option>String</option>
                          <option>Number</option>
                          <option>Boolean</option>
                          <option>DateTime</option>
                          <option>Object</option>
                          <option>Array</option>
                          <option>No_Read</option>
                        </select>
                        <button
                          className="col-span-1 text-xs text-rose-700 hover:text-rose-900"
                          onClick={() => removeAttr(selected, ai)}
                          title="Remove attribute"
                        >
                          ✕
                        </button>
                        {a.type === "Array" && (
                          <div className="col-span-12 text-[11px] text-slate-500">
                            {a.ref
                              ? `Items: ${a.ref}`
                              : a.itemsType
                              ? `Items: ${a.itemsType}`
                              : "Items: String"}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4 text-sm text-slate-600">Select an entity to edit.</div>
            )}
          </div>
        </section>

        {/* Right: schema.json editor */}
        <section className="lg:col-span-1">
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">schema.json (editable)</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopy}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
                >
                  Copy
                </button>
                <button
                  onClick={handleDownload}
                  className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-xs hover:bg-black"
                >
                  Download
                </button>
              </div>
            </div>
            <textarea
              className="w-full h-[58vh] font-mono text-[12px] leading-5 p-3 outline-none"
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              onClick={() => {
                const schema = {
                  ...DEFAULT_SCHEMA_META,
                  entities: entities.map((e) => ({
                    name: e.name,
                    attributes: e.attributes.map((a) => {
                      const out = exportAttrShape(a);
                      return {
                        name: a.name,
                        type: out.type,       // string
                        MultiValue: out.MultiValue,
                      };
                    }),
                  })),
                };
                setSchemaText(JSON.stringify(schema, null, 2));
              }}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
            >
              Rebuild from editor
            </button>
            <button
              onClick={handleContinue}
              className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-medium text-white shadow hover:bg-emerald-700"
            >
              Use this schema →
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
