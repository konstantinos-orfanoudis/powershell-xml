// lib/connectorxml.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

/* ============================================================
   Public API
   - seedLocalStorageFromSchemaAndFunctions(schema, functions)
   - syncPsMethodsFromFunctions(functions)
   - buildXmlAllConfirmedFromLocalStorage()
   - prettyXml(xml)
   ============================================================ */
// ----- Minimal types used by the XML builder (local to connectorxml) -----

export type SourceType = "Schema" | "Connection" | "Manual";

// What ps.methods.v2 stores
export type PsParam = {
  pid: string;
  name: string;
  type: UiType;
  mandatory: boolean;
  source: SourceType;
};
// Schema shape stored in localStorage (schema.entities)
export type Fn = {
  id: string;
  name: string;
  script: string;
  convo: string;
  chat: string;
  xmlPreview: string;
  inputs?: PsParam[];
};
export type SchemaType   = { entities: SchemaEntity[] };

// saved.mappings.v3 → chains per entity/op
export type MappingOp = "Insert" | "Update" | "Delete" | "List" | "View";
export type SavedMappingsV3 = Record<
  string,
  Record<MappingOp, { items?: Array<{ functionName: string; order: number }> }>
>;

// bindings.v3 → per entity/op/function param bindings
export type BindingsV3 = Record<
  string,
  Record<
    MappingOp,
    {
      functions: Array<{
        functionName: string;
        inputs: Record<string, string>; // paramName -> propertyName or global name
        useOldValue?: Record<string, boolean>;
        converter?: Record<string, string>;
        modType?: Record<string, string>;
      }>;
    }
  >
>;

// prop.meta.v1 → per-entity property meta with optional command mappings
export type PropMetaV1 = Record<
  string, // entity
  Record<
    string, // property
    {
      type: UiType;
      isUnique?: boolean;
      isDisplay?: boolean;
      isMandatory?: boolean;
      access?: "None" | "Read" | "Write" | "ReadWrite";
      returnBinds?: Array<{ commandResultOf: string; path: string }>;
      referenceTargets?: string[];
      commandMappings?: {
        Insert?: { items?: Array<{ parameter: string; toProperty: string }> };
        Update?: { items?: Array<{ parameter: string; toProperty: string }> };
        Delete?: { items?: Array<{ parameter: string; toProperty: string }> };
        List?:   { items?: Array<{ parameter: string; toProperty: string }> };
        View?:   { items?: Array<{ parameter: string; toProperty: string }> };
      };
    }
  >
>;

// globals.details(.v2) → connection/global parameters
export type GlobalDetail = {
  name: string;
  type: UiType;
  source?: "ConnectionParameter" | string;
  description?: string;
  sensitive?: boolean;
  secure?: boolean;
};








export type UiType = "String" | "Bool" | "Int" | "DateTime";
type MappingOps = "Insert" | "Update" | "Delete" | "List" | "View";

type SchemaAttr = { name: string; type?: UiType };
type SchemaEntity = { name: string; attributes?: SchemaAttr[] };

type PsInput = { name: string; type?: UiType; mandatory?: boolean; defaultValue?: string };
type PsMethod = { functionName: string; inputs: PsInput[] };

type SavedOpItem = { functionName: string; order: number; modificationExists?: boolean };
type SavedV3 = Record<string, Record<MappingOps, { items?: SavedOpItem[] }>>;

type ConverterType =
  | "None"
  | "NullToEmptyString"
  | "StringToCredential"
  | "StringToSecureString"
  | "TicksToTimespanString"
  | "ZeroToNull"
  | "CustomMvp";

type ModType = "None" | "Replace" | "Add" | "Remove";

type InputBindings = Record<
  string,
  Record<
    MappingOps,
    {
      functions: {
        functionName: string;
        inputs: Record<string, string | undefined>;
        useOldValue?: Record<string, boolean>;
        converter?: Record<string, ConverterType | undefined>;
        modType?: Record<string, ModType | undefined>;
      }[];
    }
  >
>;

type AccessConstraint = "None" | "ReadOnly" | "ReadAndInsertOnly" | "WriteOnly";
type ReferenceTarget = { class: string; property: string };
type ReturnBind = { commandResultOf: string; path: string };

type PropMeta = {
  description?: string;
  access?: AccessConstraint;
  isAutofill?: boolean;
  isMultiValue?: boolean;
  isSecret?: boolean;
  isObsolete?: boolean;
  isRevision?: boolean;
  isDisplay?: boolean;
  isUnique?: boolean;
  isMandatory?: boolean;
  type?: UiType;
  returnBinds?: ReturnBind[];
  referenceTargets?: ReferenceTarget[];
};
type PropMetaByTable = Record<string, Record<string, PropMeta>>;

type ParamSource = "ConnectionParameter" | "FixedValue" | "GlobalVariable" | "SwitchParameter" | "FixedArray";
type GlobalVar = {
  id?: string;
  name: string;
  type: UiType;
  description?: string;
  source: ParamSource;
  value?: string;
  values?: string[];
  sensitive?: boolean;
  secure?: boolean;
};

/* ------------------ small utils ------------------ */
const asUi = (t?: string): UiType => {
  const s = String(t || "").toLowerCase();
  if (s.includes("bool")) return "Bool";
  if (s.includes("int")) return "Int";
  if (s.includes("date")) return "DateTime";
  return "String";
};

const escapeXml = (s: string) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));

function getLS<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (!v) return fallback;
    const parsed = JSON.parse(v);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}
function setLS(key: string, val: any) {
  localStorage.setItem(key, JSON.stringify(val));
}

/* ============================================================
   1) Seeding helpers (called by powershell-xml page)
   ============================================================ */

/** Workbench → ps.methods.v2 shape */
function functionsToPsMethods(functions: { name: string; inputs?: { name: string; type: UiType; mandatory: boolean }[] }[]): PsMethod[] {
  return functions.map((f) => ({
    functionName: f.name,
    inputs: (f.inputs || []).map((p) => ({
      name: p.name,
      type: p.type,
      mandatory: !!p.mandatory,
    })),
  }));
}

/** Default saved.mappings for each entity */
function seedSavedMappingsFromSchema(entities: { name: string }[]): SavedV3 {
  const out: SavedV3 = {};
  for (const e of entities) {
    const entity = e.name;
    const plural = entity.endsWith("s") ? entity : `${entity}s`;
    out[entity] = {
      List: { items: [{ functionName: `Get-${plural}`, order: 1 }] },
      View: { items: [] },
      Insert: { items: [{ functionName: `Create-${entity}`, order: 1 }] },
      Update: { items: [{ functionName: `Modify-${entity}`, order: 1 }] },
      Delete: { items: [{ functionName: `Remove-${entity}`, order: 1 }] },
    };
  }
  return out;
}

/** Builds empty bindings aligned with saved.mappings */
function seedBindingsFromSaved(saved: SavedV3): InputBindings {
  const out: InputBindings = {} as any;
  (Object.keys(saved) as string[]).forEach((table) => {
    out[table] = { Insert: { functions: [] }, Update: { functions: [] }, Delete: { functions: [] }, List: { functions: [] }, View: { functions: [] } };
    (["Insert", "Update", "Delete", "List", "View"] as MappingOps[]).forEach((op) => {
      const items = saved[table][op]?.items || [];
      out[table][op] = { functions: items.map((it) => ({ functionName: it.functionName, inputs: {} })) };
    });
  });
  return out;
}

/** Seed ALL localStorage keys Inputs/connector builder expect — call this right after schema upload */
export function seedLocalStorageFromSchemaAndFunctions(schema: any, functions: any[]) {
  const entities: SchemaEntity[] = Array.isArray(schema?.entities)
    ? schema.entities
        .map((e: any) => ({
          name: String(e?.name || "").trim(),
          attributes: Array.isArray(e?.attributes)
            ? e.attributes
                .map((a: any) => ({ name: String(a?.name || "").trim(), type: asUi(a?.type) }))
                .filter((a: SchemaAttr) => a.name)
            : [],
        }))
        .filter((e: SchemaEntity) => e.name)
    : [];

  const tables = entities.map((e) => e.name);

  // schema.*
  setLS("schema.entities", entities);
  setLS("schema.tables", tables);

  // ps.methods.v2 (from current functions)
  setLS("ps.methods.v2", functionsToPsMethods(functions));

  // saved.mappings.v3
  const saved = seedSavedMappingsFromSchema(entities);
  setLS("saved.mappings.v3", saved);

  // bindings.v3
  setLS("bindings.v3", seedBindingsFromSaved(saved));

  // prop.meta.v1 (empty per table)
  const propMeta: PropMetaByTable = {};
  tables.forEach((t) => (propMeta[t] = {}));
  setLS("prop.meta.v1", propMeta);

  // globals.details.v2 (keep existing if array, otherwise [])
  const existingGlobals = getLS<GlobalVar[]>("globals.details.v2", []);
  setLS("globals.details.v2", Array.isArray(existingGlobals) ? existingGlobals : []);

  // confirmed tables
  setLS("page2.confirmed.tables", tables);
}

/** Keep ps.methods.v2 up to date when function inputs change */
export function syncPsMethodsFromFunctions(functions: Fn[]) {
  const ps = (functions || []).map(f => ({
    functionName: f.name,
    inputs: (f.inputs || []).map(p => ({
      name: p.name,
      type: p.type,
      mandatory: !!p.mandatory,
      source: p.source as SourceType,          // ✅ keep source
    })),
  }));
  localStorage.setItem("ps.methods.v2", JSON.stringify(ps));
  // keep legacy too, some builders still read it
  localStorage.setItem("ps.methods", JSON.stringify(ps));
  return ps;
}


/* ============================================================
   2) XML builder from localStorage (no hardcoded functions except CustomCommands)
   ============================================================ */

const HEADER_DESC = "Example SQL Connector";
const HEADER_VER = "1.0";
const HEADER_ID = "CustomConnector";
const PATH_PARAM = "PathToPSModule";

function readAssemblies(): string[] {
  const keys = ["plugin.assemblies", "assemblies.paths", "assemblies.list"];
  for (const k of keys) {
    const v = getLS<any>(k, null);
    if (Array.isArray(v)) return v.filter(Boolean);
  }
  return [];
}

function allMappedFunctionNamesAcross(tables: string[], saved: SavedV3): string[] {
  const out: string[] = [];
  tables.forEach((t) => {
    const blk = saved[t];
    if (!blk) return;
    (["List", "View", "Insert", "Update", "Delete"] as MappingOps[]).forEach((op) => {
      (blk[op]?.items || []).forEach((it) => out.push(it.functionName));
    });
  });
  return uniq(out);
}

/** map of functionName → PsMethod (inputs) */
function methodsIndex(methods: PsMethod[]): Record<string, PsMethod> {
  const r: Record<string, PsMethod> = {};
  methods.forEach((m) => (r[m.functionName] = m));
  return r;
}

/** find schema attributes for a given table */
function schemaAttrsFor(entities: SchemaEntity[], table: string): SchemaAttr[] {
  const ent = entities.find((e) => e.name === table);
  return (ent?.attributes || []).map((a) => ({ name: a.name, type: asUi(a.type) }));
}

/** Required connection params across all confirmed tables (driven by mandatory method inputs bound to a SetParameter with source=ConnectionParameter) */
function computeMandatoryConnParamsAcross(
  tables: string[],
  saved: SavedV3,
  bindings: InputBindings,
  setParams: GlobalVar[],
  methodsByName: Record<string, PsMethod>
): Set<string> {
  const required = new Set<string>();
  const getSetParamByName = (nm?: string) => setParams.find((p) => p.name === nm);

  tables.forEach((table) => {
    (["Insert", "Update", "Delete", "List", "View"] as MappingOps[]).forEach((op) => {
      const items = saved[table]?.[op]?.items || [];
      const fbs = bindings[table]?.[op]?.functions || [];
      items.forEach((it, idx) => {
        const def = methodsByName[it.functionName];
        const fb = fbs[idx];
        if (!def || !fb) return;
        (def.inputs || []).forEach((inp) => {
          const isMandatory = !!inp.mandatory && !inp.defaultValue;
          if (!isMandatory) return;
          const boundName = fb.inputs?.[inp.name];
          if (!boundName) return;
          const sp = getSetParamByName(boundName);
          if (sp && sp.source === "ConnectionParameter") {
            required.add(sp.name);
          }
        });
      });
    });
  });

  return required;
}

function emitSetParameter(inp: PsInput, boundName: string, setParams: GlobalVar[]): string | null {
  const sp = setParams.find((p) => p.name === boundName);
  if (!sp) return null;
  const paramAttr = ` Param="${escapeXml(inp.name)}"`;
  switch (sp.source) {
    case "ConnectionParameter": {
      const conv = sp.secure ? ` ConversionMethod="ToSecureString"` : "";
      return `            <SetParameter Value="${escapeXml(sp.name)}" Source="ConnectionParameter"${paramAttr}${conv}/>`;
    }
    case "FixedValue":
      return `            <SetParameter Value="${escapeXml(sp.value || "")}" Source="FixedValue"${paramAttr}/>`;
    case "GlobalVariable":
      return `            <SetParameter Value="${escapeXml(sp.name)}" Source="GlobalVariable"${paramAttr}/>`;
    case "SwitchParameter":
      return `            <SetParameter Source="SwitchParameter"${paramAttr}/>`;
    case "FixedArray":
      return `            <SetParameter Value="${escapeXml((sp.values || []).join(","))}" Source="FixedArray"${paramAttr}/>`;
    default:
      return null;
  }
}

function setParamsXmlFor(
  methodsByName: Record<string, PsMethod>,
  setParams: GlobalVar[],
  binding: { functionName: string; inputs: Record<string, string | undefined>; converter?: Record<string, ConverterType | undefined> },
  indent = "          "
): string {
  const def = methodsByName[binding?.functionName || ""];
  if (!def) return "";
  const lines: string[] = [];
  for (const inp of def.inputs || []) {
    const boundName = binding.inputs?.[inp.name];
    if (!boundName) continue;
    const line = emitSetParameter(inp, boundName, setParams);
    if (line) lines.push(indent + line.trim());
  }
  return lines.join("\n");
}

/** Class XML builder (per table) — mirrors Inputs logic */
function buildClassXmlForTable(
  table: string,
  entities: SchemaEntity[],
  saved: SavedV3,
  bindings: InputBindings,
  propMeta: PropMetaByTable,
  methodsByName: Record<string, PsMethod>,
  setParams: GlobalVar[]
): string {
  const schemaAttrsLocal = schemaAttrsFor(entities, table);
  const mapped = saved[table] || ({} as SavedV3[string]);
  const fnBindings = (op: MappingOps) => bindings[table]?.[op]?.functions || [];

  // Collect prop→command mappings & modifications
  const propsFromBindings = new Set<string>();
  const propToCommandMaps = new Map<
    string,
    { toCommand: string; param: string; useOldValue?: boolean; converter?: ConverterType; modType?: ModType }[]
  >();

  (["List", "View", "Insert", "Update", "Delete"] as MappingOps[]).forEach((op) => {
    const items = mapped[op]?.items || [];
    const fbs = fnBindings(op);
    items.forEach((it, idx) => {
      const def = methodsByName[it.functionName];
      const fb = fbs[idx];
      if (!def || !fb) return;
      (def.inputs || []).forEach((inp) => {
        const bound = fb.inputs?.[inp.name];
        if (!bound) return;
        const sp = setParams.find((p) => p.name === bound);
        if (!sp) {
          propsFromBindings.add(bound);
          const arr = propToCommandMaps.get(bound) || [];
          const useOld = op === "Update" ? !!fb.useOldValue?.[inp.name] : false;
          const conv = fb.converter?.[inp.name];
          const mt = op === "Update" ? fb.modType?.[inp.name] : undefined;

          const exists = arr.find((m) => m.toCommand === it.functionName && m.param === inp.name);
          if (exists) {
            exists.useOldValue = exists.useOldValue || useOld;
            if (!exists.converter && conv) exists.converter = conv;
            if (!exists.modType && mt && mt !== "None") exists.modType = mt;
          } else {
            arr.push({ toCommand: it.functionName, param: inp.name, useOldValue: useOld, converter: conv, modType: mt && mt !== "None" ? mt : undefined });
          }
          propToCommandMaps.set(bound, arr);
        }
      });
    });
  });

  // ReadConfiguration (List + View)
  const listItems = mapped.List?.items || [];
  const viewItems = mapped.View?.items || [];

  const readCfgXml = (() => {
    if (!listItems.length && !viewItems.length) return "";
    const parts: string[] = [];
    parts.push(`      <ReadConfiguration>`);
    if (listItems.length) {
      const first = listItems[0];
      parts.push(`        <ListingCommand Command="${escapeXml(first.functionName)}">`);
      const fb = fnBindings("List")[0];
      const block = fb ? setParamsXmlFor(methodsByName, setParams, fb, "          ") : "";
      if (block.trim()) parts.push(block);
      parts.push(`        </ListingCommand>`);
    }
    if (viewItems.length) {
      parts.push(`        <CommandSequence>`);
      viewItems.forEach((it, idx) => {
        parts.push(`          <Item Order="${it.order}" Command="${escapeXml(it.functionName)}">`);
        const fb = fnBindings("View")[idx];
        const block = fb ? setParamsXmlFor(methodsByName, setParams, fb, "            ") : "";
        if (block.trim()) parts.push(block);
        parts.push(`          </Item>`);
      });
      parts.push(`        </CommandSequence>`);
    }
    parts.push(`      </ReadConfiguration>`);
    return parts.join("\n");
  })();

  // MethodConfiguration (Insert/Update/Delete)
  const methodXmlFor = (op: MappingOps, label: "Insert" | "Update" | "Delete"): string => {
    const items = mapped[op]?.items || [];
    if (!items.length) return "";
    const parts: string[] = [];
    parts.push(`      <Method Name="${label}">`);
    parts.push(`        <CommandSequence>`);
    items.forEach((it, idx) => {
      const cond = (it as any).modificationExists ? ` Condition="ModificationExists"` : "";
      parts.push(`          <Item Order="${it.order}" Command="${escapeXml(it.functionName)}"${cond}>`);
      const fb = fnBindings(op)[idx];
      const block = fb ? setParamsXmlFor(methodsByName, setParams, fb, "            ") : "";
      if (block.trim()) parts.push(block);
      parts.push(`          </Item>`);
    });
    parts.push(`        </CommandSequence>`);
    parts.push(`      </Method>`);
    return parts.join("\n");
  };
  const mcXml = (() => {
    const blocks = [methodXmlFor("Insert", "Insert"), methodXmlFor("Update", "Update"), methodXmlFor("Delete", "Delete")].filter(Boolean);
    if (!blocks.length) return "";
    return `      <MethodConfiguration>\n${blocks.join("\n")}\n      </MethodConfiguration>`;
  })();

  // ModifiedBy and ReturnBindings per property
  const pmAll = propMeta[table] || {};
  const boundMandatoryProps = new Set<string>();
  const modByInsertMap = new Map<string, Set<string>>();
  const modByUpdateMap = new Map<string, Set<string>>();

  (["Insert", "Update"] as MappingOps[]).forEach((op) => {
    const items = mapped[op]?.items || [];
    const fbs = fnBindings(op);
    items.forEach((it, idx) => {
      const def = methodsByName[it.functionName];
      const fb = fbs[idx];
      if (!def || !fb) return;
      (def.inputs || []).forEach((inp) => {
        const bound = fb.inputs?.[inp.name];
        if (!bound) return;

        // Only properties (not SetParams) count for ModifiedBy + mandatory-via-binding
        if (setParams.find((p) => p.name === bound)) return;

        const meta = pmAll[bound] || {};
        const cannotMandatory = !!meta.isAutofill || meta.access === "ReadOnly";
        if (!cannotMandatory && inp.mandatory && !inp.defaultValue) boundMandatoryProps.add(bound);

        if (meta.access === "ReadOnly") return;
        if (op === "Insert") {
          const set = modByInsertMap.get(bound) || new Set<string>();
          set.add(it.functionName);
          modByInsertMap.set(bound, set);
        } else {
          const set = modByUpdateMap.get(bound) || new Set<string>();
          const key = (it as any).modificationExists ? `${it.functionName}||ModificationExists` : it.functionName;
          set.add(key);
          modByUpdateMap.set(bound, set);
        }
      });
    });
  });

  const allPropNames = Array.from(
    new Set<string>([
      ...schemaAttrsLocal.map((a) => a.name),
      ...Object.keys(pmAll).filter((n) => !schemaAttrsLocal.some((a) => a.name === n)),
      ...Array.from(propsFromBindings),
    ])
  );

  function propertyXml(name: string): string {
    const isSchema = schemaAttrsLocal.some((a) => a.name === name);
    const dtype = isSchema ? (schemaAttrsLocal.find((a) => a.name === name)?.type ?? "String") : (pmAll[name]?.type ?? "String");
    const meta = pmAll[name] || {};

    const cannotMandatory = !!meta.isAutofill || meta.access === "ReadOnly";
    const forcedMandatory = boundMandatoryProps.has(name) && !cannotMandatory;

    const attrs: string[] = [`Name="${escapeXml(name)}"`, `DataType="${dtype}"`];
    if (meta.access && meta.access !== "None") attrs.push(`AccessConstraint="${meta.access}"`);
    if (meta.isDisplay) attrs.push(`IsDisplay="true"`);
    if (meta.isUnique) attrs.push(`IsUniqueKey="true"`);
    if (meta.isMultiValue) attrs.push(`IsMultiValue="true"`);
    if (meta.isSecret) attrs.push(`IsSecret="true"`);
    if (meta.isObsolete) attrs.push(`IsObsolete="true"`);
    if (meta.isRevision) attrs.push(`IsRevision="true"`);
    if (meta.description?.trim()) attrs.push(`Description="${escapeXml(meta.description)}"`);
    const shouldBeMandatory = !cannotMandatory && (meta.isMandatory || forcedMandatory);
    if (shouldBeMandatory) attrs.push(`IsMandatory="true"`);

    const open = `        <Property ${attrs.join(" ")}>`;
    const blocks: string[] = [];

    // ReferenceTargets (shown only if multi-value and provided)
    if (meta.isMultiValue && (meta.referenceTargets || []).length) {
      const lines = (meta.referenceTargets || [])
        .filter((rt) => (rt.class || "").trim() && (rt.property || "").trim())
        .map((rt) => `          <ReferenceTarget Class="${escapeXml(rt.class)}" Property="${escapeXml(rt.property)}"/>`);
      if (lines.length) blocks.push(`          <ReferenceTargets>\n${lines.join("\n")}\n          </ReferenceTargets>`);
    }

    // CommandMappings
    {
      const raw = propToCommandMaps.get(name) || [];
      const seen = new Set<string>();
      const lines: string[] = [];
      raw.forEach((m) => {
        const key = `${m.toCommand}::${m.param}`;
        if (seen.has(key)) return;
        seen.add(key);
        lines.push(
          `            <Map ToCommand="${escapeXml(m.toCommand)}" Parameter="${escapeXml(m.param)}"${m.useOldValue ? ' UseOldValue="true"' : ""}${
            m.converter && m.converter !== "None" ? ` Converter="${escapeXml(m.converter)}"` : ""
          }${m.modType ? ` ModType="${escapeXml(m.modType)}"` : ""}/>`
        );
      });
      if (lines.length) blocks.push(`          <CommandMappings>\n${lines.join("\n")}\n          </CommandMappings>`);
    }

    // ModifiedBy
    if (!meta.isAutofill && meta.access !== "ReadOnly") {
      const ins = Array.from(modByInsertMap.get(name) || new Set<string>());
      let ups = Array.from(modByUpdateMap.get(name) || new Set<string>());
      if (meta.access === "ReadAndInsertOnly") ups = [];
      if (ins.length || ups.length) {
        const lines: string[] = [];
        lines.push(`          <ModifiedBy>`);
        ins.forEach((fn) => lines.push(`            <ModBy Command="${escapeXml(fn)}"/>`));
        ups.forEach((k) => {
          const [fn, cond] = k.includes("||") ? k.split("||") : [k, ""];
          lines.push(`            <ModBy Command="${escapeXml(fn)}"${cond ? ` Condition="${cond}"` : ""}/>`);
        });
        lines.push(`          </ModifiedBy>`);
        blocks.push(lines.join("\n"));
      }
    }

    // ReturnBindings (skip when WriteOnly)
    if (meta.access !== "WriteOnly") {
      const binds = (meta.returnBinds || []).map((b) => ({
        cmd: b.commandResultOf || "",
        path: (b.path?.trim()?.length ? b.path.trim() : name),
      }));
      const seen = new Set<string>();
      const lines: string[] = [];
      binds.forEach((b) => {
        const key = `${b.cmd}::${b.path}`;
        if (!b.cmd || seen.has(key)) return;
        seen.add(key);
        lines.push(`            <Bind Path="${escapeXml(b.path)}" CommandResultOf="${escapeXml(b.cmd)}"/>`);
      });
      if (lines.length) blocks.push(`          <ReturnBindings>\n${lines.join("\n")}\n          </ReturnBindings>`);
    }

    return blocks.length ? `${open}\n${blocks.join("\n")}\n        </Property>` : `${open}</Property>`;
  }

  const propsXml = allPropNames.map(propertyXml).join("\n");

  const doc: string[] = [];
  doc.push(`    <Class Name="${escapeXml(table)}">`);
  doc.push(`      <Properties>`);
  if (propsXml) doc.push(propsXml);
  doc.push(`      </Properties>`);
  if (readCfgXml) doc.push(readCfgXml);
  if (mcXml) doc.push(mcXml);
  doc.push(`    </Class>`);
  return doc.join("\n");
}

/** Main builder: reads everything from LS, returns xml + errors (if any) */
export function buildXmlAllConfirmedFromLocalStorage(): { xml: string; errors: string[] } {
  const errors: string[] = [];

  const entities = getLS<SchemaEntity[]>("schema.entities", []);
  const tables = getLS<string[]>("schema.tables", []);
  const saved = getLS<SavedV3>("saved.mappings.v3", {});
  const bindings = getLS<InputBindings>("bindings.v3", {} as any);
  const propMeta = getLS<PropMetaByTable>("prop.meta.v1", {});
  const methods = getLS<PsMethod[]>("ps.methods.v2", []);
  const setParams = getLS<GlobalVar[]>("globals.details.v2", []);
  const confirmed = getLS<string[]>("page2.confirmed.tables", []);
  const assemblies = readAssemblies();

  // Soft validation / hints
  if (!entities.length) errors.push("No schema.entities found.");
  if (!confirmed.length) errors.push("No confirmed tables.");
  if (!methods.length) errors.push("No ps.methods.v2 (methods).");

  const confirmedTables = confirmed.filter((t) => tables.includes(t));
  if (!confirmedTables.length) {
    return { xml: "", errors: errors.length ? errors : ["No confirmed tables present in schema.tables."] };
  }

  const methodsByName = methodsIndex(methods);

  // ConnectionParameters (mandatory flags from mandatory SetParams usage)
  const mandatoryConn = computeMandatoryConnParamsAcross(confirmedTables, saved, bindings, setParams, methodsByName);
  const pluginAssembliesXml = assemblies.length
    ? `<PluginAssemblies>\n${assemblies.map((p) => `  <Assembly Path="${escapeXml(p)}"/>`).join("\n")}\n</PluginAssemblies>`
    : `<PluginAssemblies/>`;

  const connectionParametersXml = (() => {
    const uiConn = setParams.filter((p) => p.source === "ConnectionParameter");
    const hasPath = uiConn.some((p) => p.name === PATH_PARAM);
    const all = hasPath
      ? uiConn
      : [
          ...uiConn,
          {
            name: PATH_PARAM,
            description: "Path to the supporting PowerShell Module eg. C:\\temp\\SalesforceFunctions.psm1",
            source: "ConnectionParameter",
            type: "String",
            sensitive: false,
          } as any,
        ];

    if (!all.length) return `<ConnectionParameters/>`;

    const merged = all
      .map((p) => {
        const suffix = mandatoryConn.has(p.name) ? "" : " (optional)";
        const desc = ((p.description && p.description.trim()) ? p.description : p.name) + suffix;
        const sens = p.sensitive ? ` IsSensibleData="true"` : "";
        return `  <ConnectionParameter Description="${escapeXml(desc)}" Name="${escapeXml(p.name)}"${sens}/>`;
      })
      .join("\n");

    return `<ConnectionParameters>\n${merged}\n</ConnectionParameters>`;
  })();

  // ----- Initialization blocks -----

  // (A) CustomCommands — HARD-CODED ONLY (do not add any auto-generated functions here)
  const customCommandsXml = (() => {
    const connParams = setParams.filter((p) => p.source === "ConnectionParameter" && p.name && p.name !== PATH_PARAM);

    const authParamSig = connParams.length
      ? connParams
          .map((p) => {
            const isMand = mandatoryConn.has(p.name);
            const pieces: string[] = [];
            pieces.push(`[Parameter(Mandatory=$${isMand ? "true" : "false"},ValueFromPipelineByPropertyName=$true)]`);
            if (isMand) pieces.push(`[ValidateNotNullOrEmpty()]`);
            pieces.push(`[String]$${p.name}`);
            return "          " + pieces.join(" ");
          })
          .join(",\n")
      : "";

    const authAssignments = connParams.length
      ? connParams.map((p) => `        if ($PSBoundParameters.ContainsKey('${p.name}')) { $global:${p.name} = $${p.name} ; }`).join("\n")
      : "        # No connection parameters provided";

    return [
      `    <CustomCommands>`,
      `      <CustomCommand Name="Import-SFModule">`,
      `        <![CDATA[ param(`,
      `          [parameter(Mandatory=$true,ValueFromPipelineByPropertyName=$true)]`,
      `          [ValidateNotNullOrEmpty()]`,
      `          [String]$_PathToPSModule`,
      `        )`,
      `        Import-Module -Force -Verbose $_PathToPSModule ]]>`,
      `      </CustomCommand>`,
      `      <CustomCommand Name="Get-Authorization">`,
      connParams.length
        ? [
            `        <![CDATA[`,
            `        [CmdletBinding()]`,
            `        param(`,
            authParamSig,
            `        )`,
            authAssignments,
            `        ]]>`,
          ].join("\n")
        : `        <![CDATA[ [CmdletBinding()] param() ]]>`,
      `      </CustomCommand>`,
      `    </CustomCommands>`,
    ].join("\n");
  })();

  // (B) PredefinedCommands — union of all MAPPED function names across confirmed tables
  const predefinedXml = (() => {
    const names = allMappedFunctionNamesAcross(confirmedTables, saved);
    if (!names.length) return `    <PredefinedCommands/>`;
    return `    <PredefinedCommands>\n${names.map((n) => `      <Command Name="${escapeXml(n)}"/>`).join("\n")}\n    </PredefinedCommands>`;
  })();

  // (C) EnvironmentInitialization — uses only the hardcoded custom commands + connection params
  const envInitXml = (() => {
    const connParams = setParams.filter((p) => p.source === "ConnectionParameter" && p.name && p.name !== PATH_PARAM);
    const setLine = (name: string, secure?: boolean) =>
      `            <SetParameter Value="${escapeXml(name)}" Source="ConnectionParameter" Param="${escapeXml(name)}"${
        secure ? ` ConversionMethod="ToSecureString"` : ""
      }/>`;
    const lines: string[] = [];
    lines.push(`    <EnvironmentInitialization>`);
    lines.push(`      <Connect>`);
    lines.push(`        <CommandSequence>`);
    lines.push(`          <Item Order="1" Command="Import-SFModule">`);
    lines.push(`            <SetParameter Value="${PATH_PARAM}" Source="ConnectionParameter" Param="_PathToPSModule"/>`);
    lines.push(`          </Item>`);
    lines.push(`          <Item Order="2" Command="Get-Authorization">`);
    if (connParams.length) connParams.forEach((p) => lines.push(setLine(p.name, p.secure)));
    lines.push(`          </Item>`);
    lines.push(`        </CommandSequence>`);
    lines.push(`      </Connect>`);
    lines.push(`      <Disconnect/>`);
    lines.push(`    </EnvironmentInitialization>`);
    return lines.join("\n");
  })();

  // Build each class from confirmed tables
  const classesXml = confirmedTables
    .map((t) => buildClassXmlForTable(t, entities, saved, bindings, propMeta, methodsByName, setParams))
    .join("\n");

  const doc: string[] = [];
  doc.push(`<?xml version="1.0" encoding="utf-8"?>`);
  doc.push(
    `<PowershellConnectorDefinition Description="${escapeXml(HEADER_DESC)}" Version="${escapeXml(
      HEADER_VER
    )}" Id="${escapeXml(HEADER_ID)}">`
  );
  doc.push(pluginAssembliesXml);
  doc.push(connectionParametersXml);
  doc.push(`  <Initialization>`);
  doc.push(customCommandsXml);
  doc.push(predefinedXml);
  doc.push(envInitXml);
  doc.push(`  </Initialization>`);
  doc.push(`  <Schema>`);
  doc.push(classesXml);
  doc.push(`  </Schema>`);
  doc.push(`</PowershellConnectorDefinition>`);

  return { xml: doc.join("\n"), errors };
}

/* ============================================================
   3) Pretty printer
   ============================================================ */

export function prettyXml(input: string): string {
  const xml = (input || "").trim();
  if (!xml) return "";

  // Try DOM → XMLSerializer first (preserves CDATA, attributes, etc.)
  try {
    const dom = new DOMParser().parseFromString(xml, "application/xml");
    // If there is a parser error, bail to fallback
    if (dom.getElementsByTagName("parsererror").length) throw new Error("parse error");

    const raw = new XMLSerializer().serializeToString(dom);
    return formatXml(raw);
  } catch {
    // Fallback regex formatter
    return formatXml(xml);
  }

  function formatXml(s: string): string {
    // Put newlines between adjacent tags
    s = s
      .replace(/>\s*</g, ">\n<")       // break tag boundaries
      .replace(/\r\n?/g, "\n")         // normalize EOL
      .trim();

    const lines = s.split("\n");
    const out: string[] = [];
    let indent = 0;

    const isClosing   = (l: string) => /^<\/[^>]+>/.test(l.trim());
    const isSelfClose = (l: string) => /\/>$/.test(l.trim());
    const isOpen      = (l: string) => /^<[^!?/][^>]*[^/]>$/.test(l.trim());

    for (let line of lines) {
      const t = line.trim();

      if (isClosing(t)) indent = Math.max(indent - 1, 0);

      out.push(`${"  ".repeat(indent)}${t}`);

      if (isOpen(t) && !isSelfClose(t)) indent++;
    }

    return out.join("\n") + "\n";
  }
}

