"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import {
  buildXmlAllConfirmedFromLocalStorage,
  prettyXml,
} from "../../lib/connectorxml";
import { parsePsFileToFns,parseFnName  } from "@/lib/ps-parse"; // adjust path alias to your project
import {  buildXmlFromUploadPw, classifyParamsForUpload, exitUploadMode, isUploadMode, startUploadMode} from "@/lib/uploadPwxml";



type UiType = "String" | "Bool" | "Int" | "DateTime";
type SourceType = "Schema" | "Connection" | "Manual";

type PsParam = {
  pid: string;
  name: string;
  type: UiType;
  mandatory: boolean;
  source: SourceType;
};

type Fn = {
  id: string;
  name: string;
  script: string;
  convo: string;
  chat: string;
  xmlPreview: string;
  inputs?: PsParam[];
};

type MappingOps = "Insert" | "Update" | "Delete" | "List" | "View";

const escape = (s: string) => String(s ?? "");



// map of op → canonical function name pattern
const opName = (entity: string, op: MappingOps) => {
  if (op === "List") return `Get-${entity}s`;
  if (op === "View") return ``; // optional
  if (op === "Insert") return `Create-${entity}`;
  if (op === "Update") return `Modify-${entity}`;
  if (op === "Delete") return `Remove-${entity}`;
  return "";
};

// Does our Fn[] contain that function?
function hasFn(functions: { name: string }[], name: string) {
  return functions.some((f) => f.name === name);
}

type Expanded = "script" | "convo" | "chat" | "xml" | null;

type SchemaAttr = {
  name: string;
  type?: string;
  IsKey?: boolean;        // from schema.json
  MultiValue?: boolean;   // from schema.json
};
type SchemaEntity = { name: string; attributes?: SchemaAttr[] };
function getKeyName(attrs: Array<{ name: string; type?: string; IsKey?: boolean }>): string {
  return (
    attrs.find(a => !!a?.IsKey)?.name ||                       // prefer explicit IsKey
    attrs.find(a => /^id$/i.test(a.name))?.name ||             // then exact 'id'
    attrs.find(a => /id$/i.test(a.name))?.name ||              // then '*id'
    attrs[0]?.name ||                                          // fallback first
    "Id"
  );
}

function fnsFromSchema(schema: any): Fn[] {
  const ents: SchemaEntity[] = Array.isArray(schema?.entities)
    ? schema.entities
    : [];
  if (!ents.length) return [];

  const out: Fn[] = [];
  for (const en of ents) {
    const entity = String(en?.name || "").trim();
    if (!entity) continue;

    const names = [
      `Get-${entity}s`,
      `Create-${entity}`,
      `Modify-${entity}`,
      `Remove-${entity}`,
    ];

    for (const n of names) {
      out.push({
        id:
          globalThis.crypto?.randomUUID?.() ??
          Math.random().toString(36).slice(2),
        name: n,
        script: "",
        convo: "",
        chat: "",
        xmlPreview: "",
      });
    }
  }
  return out;
}
function propAttrFlags(attr: any) {
  const isKey   = !!attr?.isKey;
  const isMulti = !!(attr?.MultiValue ?? attr?.IsMultiValue);

  const bits: string[] = [];
  if (isKey) {
    bits.push(`IsUniqueKey="true"`, `IsDisplay="true"`);
  }
  if (isMulti) {
    bits.push(`IsMultiValue="true"`);
  }
  return bits.length ? " " + bits.join(" ") : "";
}




 const VERB_SYNONYMS: Record<MappingOps, string[]> = {
  List:   ["Get", "List", "Find", "Read", "Query", "Search", "Fetch", "Select"],
  View:   [], // optional
  Insert: ["Create", "Add", "Insert", "New"],
  Update: ["Update", "Modify", "Set", "Patch", "Change"],
  Delete: ["Delete", "Remove", "Erase", "Drop"],
};

function canonicalVerb(v: string): "Get"|"Create"|"Update"|"Delete"|string {
  const x = (v || "").toLowerCase();
  if (["update","modify","set","patch","change"].includes(x)) return "Update";
  if (["delete","remove","erase","drop"].includes(x))          return "Delete";
  if (["create","add","insert","new"].includes(x))             return "Create";
  if (["get","list","find","read","query","search","fetch","select"].includes(x)) return "Get";
  return v;
}
function findFnForOp(
  entity: string,
  op: MappingOps,
  functions: { name: string }[]
): string | null {
  const verbs = VERB_SYNONYMS[op] || [];
  const ent   = (entity || "").toLowerCase();
  for (const f of functions) {
    const name = String(f?.name || "");
    const m = name.match(/^([A-Za-z_]+)-(.+)$/);
    if (!m) continue;
    const v = canonicalVerb(m[1]);
    const n = m[2].toLowerCase().replace(/s$/,""); // accept Users/User
    if (verbs.some(x => canonicalVerb(x) === v) && (n === ent)) return f.name;
  }
  return null;
}

function seedSavedMappings(
  schema: { entities: SchemaEntity[] },
  functions: { name: string }[]
) {
  const out: any = {};
  for (const e of schema.entities || []) {
    const ent = e.name;
    const row: any = { Insert: {}, Update: {}, Delete: {}, List: {}, View: {} };

    (["List", "Insert", "Update", "Delete"] as MappingOps[]).forEach((op) => {
  const found = findFnForOp(ent, op, functions);
  if (found) {
    row[op] = { items: [{ functionName: found, order: 1 }] };
  }
});

    out[ent] = row;
  }
  localStorage.setItem("saved.mappings.v3", JSON.stringify(out));
  localStorage.setItem("saved.mappings", JSON.stringify(out));
  return out as Record<
    string,
    Record<
      MappingOps,
      { items?: { functionName: string; order: number }[] }
    >
  >;
}

function normalizeName(s: string) {
  return String(s || "").trim().replace(/^\$/, ""); // drop leading $
}

function seedBindingsV3(
  schema: {
    entities: {
      name: string;
      attributes?: { name: string; type?: string }[];
    }[];
  },
  functions: {
    name: string;
    inputs?: {
      name: string;
      type: string;
      mandatory?: boolean;
      source?: "Schema" | "Connection" | "Manual";
    }[];
  }[],
  saved: Record<
    string,
    Record<
      "Insert" | "Update" | "Delete" | "List" | "View",
      { items?: { functionName: string; order: number }[] }
    >
  >
) {
  const byName = new Map(functions.map((f) => [f.name, f]));
  const out: any = {};

  for (const e of schema.entities || []) {
    const ent = e.name;
    const attrs = (e.attributes || []).map((a) => a.name);
    const attrMap = new Map(attrs.map((n) => [n.toLowerCase(), n]));

    const tbl: any = {
      Insert: { functions: [] },
      Update: { functions: [] },
      Delete: { functions: [] },
      List: { functions: [] },
      View: { functions: [] },
    };

    (["List", "View", "Insert", "Update", "Delete"] as const).forEach((op) => {
      const items = saved?.[ent]?.[op]?.items || [];
      tbl[op] = {
        functions: items.map((it) => {
          const def = byName.get(it.functionName);
          const fb: any = {
            functionName: it.functionName,
            inputs: {}, // paramName -> propertyName
            setParameters: [] as Array<{
              source: "ConnectionParameter" | "FunctionParameter";
              param: string;
            }>,
            useOldValue: {},
            converter: {},
            modType: op,
          };

          if (!def?.inputs?.length) return fb;

          def.inputs.forEach((p) => {
            const name = String(p.name || "").trim();
            if (!name) return;

            if (p.source === "Schema") {
              const canon =
                attrMap.get(name.toLowerCase()) ||
                attrs.find((a) => looksLikeIdPair(name, a));
              if (canon) fb.inputs[name] = canon;
              return;
            }

            if (p.source === "Connection") {
              fb.setParameters.push({
                source: "ConnectionParameter",
                param: name,
              });
              return;
            }

            if (p.source === "Manual") {
              fb.setParameters.push({
                source: "FunctionParameter",
                param: name,
              });
              return;
            }
          });

          return fb;
        }),
      };
    });

    out[ent] = tbl;
  }

  localStorage.setItem("bindings.v3", JSON.stringify(out));
  writeCommandMappingsFromBindings(schema, out);

  return out as Record<
    string,
    Record<
      "Insert" | "Update" | "Delete" | "List" | "View",
      {
        functions: Array<{
          functionName: string;
          inputs: Record<string, string>;
          setParameters: Array<{
            source: "ConnectionParameter" | "FunctionParameter";
            param: string;
          }>;
        }>;
      }
    >
  >;
}

/** Mirror bindings.v3 (param -> property) into prop.meta.v1 so the builder can emit
 *  <CommandMappings> under *each* <Property> (per operation).
 */
function writeCommandMappingsFromBindings(
  schema: { entities: { name: string; attributes?: { name: string }[] }[] },
  bindings: Record<
    string,
    Record<
      "Insert" | "Update" | "Delete" | "List" | "View",
      { functions: { functionName: string; inputs: Record<string, string> }[] }
    >
  >
) {
  const meta = JSON.parse(localStorage.getItem("prop.meta.v1") || "{}");

  const ensureArray = (ent: string, prop: string) => {
    meta[ent] = meta[ent] || {};
    meta[ent][prop] = meta[ent][prop] || {};
    const cur = meta[ent][prop].commandMappings;

    if (Array.isArray(cur)) return cur;

    if (cur && typeof cur === "object") {
      const arr: Array<{
        command: string;
        parameter: string;
        operation?: string;
      }> = [];
      for (const op of ["Insert", "Update", "Delete", "List", "View"] as const) {
        const items =
          (cur[op]?.items ?? []) as Array<{
            parameter?: string;
            toProperty?: string;
            command?: string;
          }>;
        for (const it of items) {
          if (!it?.parameter) continue;
          arr.push({
            command: it.command || "",
            parameter: it.parameter,
            operation: op,
          });
        }
      }
      meta[ent][prop].commandMappings = arr;
      return arr;
    }

    return (meta[ent][prop].commandMappings = []);
  };

  const isKeyProp = (ent: string, prop: string): boolean => {
  const m = meta?.[ent]?.[prop];
  if (m && typeof m.isUnique === "boolean") return !!m.isUnique; // ← uses meta
  return /^id$/i.test(prop) || /id$/i.test(prop);
};
  for (const e of schema.entities || []) {
    const ent = e.name;
    const props = (e.attributes || []).map((a) => a.name);
    for (const prop of props) ensureArray(ent, prop);

    const buckets = bindings?.[ent] || {};
    (["Insert", "Update", "Delete", "List", "View"] as const).forEach((op) => {
      for (const f of buckets[op]?.functions || []) {
        const fnName = f.functionName;
        const inputMap = f.inputs || {};

        for (const [paramName, propertyName] of Object.entries(inputMap)) {
          if (!props.includes(propertyName)) continue;
          if (isKeyProp(ent, propertyName) && (op === "Insert" || op === "Update")) continue;

          const arr = ensureArray(ent, propertyName);
          if (
            !arr.some(
              (m: any) =>
                m.command === fnName &&
                m.parameter === paramName &&
                m.operation === op
            )
          ) {
            arr.push({ command: fnName, parameter: paramName, operation: op });
          }
        }
      }
    });
  }

  localStorage.setItem("prop.meta.v1", JSON.stringify(meta));
}

function looksLikeIdPair(param: string, prop: string) {
  const p = normalizeName(param);
  const a = normalizeName(prop);
  if (p === a) return true;
  if (p.endsWith("id") && a === p.slice(0, -2)) return true;
  if (a.endsWith("id") && p === a.slice(0, -2)) return true;
  if (a === "id" && (p.endsWith("id") || p === "id")) return true;
  return false;
}

function ui(t?: string): UiType {
  const s = String(t || "").toLowerCase();
  if (s.includes("bool")) return "Bool";
  if (s.includes("int")) return "Int";
  if (s.includes("date")) return "DateTime";
  return "String";
}

const psType = (t: UiType) =>
  t === "Int" ? "[int]" : t === "Bool" ? "[bool]" : t === "DateTime" ? "[datetime]" : "[string]";



function seedPropMetaWithRBs(schema: { entities: SchemaEntity[] }) {
  const meta: any = {};
  for (const e of schema.entities || []) {
    const ent = e.name;
    const attrs = (e.attributes || []).map(a => ({
      name: a.name,
      type: ui(a.type),
      IsKey: !!a.IsKey,
      MultiValue: !!a.MultiValue,
    }));

    // display = first key; else 'id'/ '*id'; else first attr
    const keyName = getKeyName(e.attributes || []);
    const display = keyName ||
      attrs.find(a => /^id$/i.test(a.name))?.name ||
      attrs.find(a => /id$/i.test(a.name))?.name ||
      attrs[0]?.name;

    const listFn = `Get-${ent}s`;
    const hasInsert = !!opName(ent, "Insert");
    const hasUpdate = !!opName(ent, "Update");

    const table: any = {};
    for (const a of attrs) {
      const isKey = a.IsKey || a.name === keyName;

      // No Create/Update mapping for key props
      const mapForCreate = !isKey && hasInsert ? [{ parameter: a.name, toProperty: a.name }] : [];
      const mapForUpdate = !isKey && hasUpdate ? [{ parameter: a.name, toProperty: a.name }] : [];

      table[a.name] = {
        type: a.type,
        isUnique: isKey,                         // <— drives IsUniqueKey="true"
        isDisplay: isKey || a.name === display,  // <— keys are also display
        isMultiValue: !!a.MultiValue,            // <— drives IsMultiValue="true"
        isMandatory: false,
        access: "None",
        returnBinds: [{ commandResultOf: listFn, path: a.name }],
        referenceTargets: [],
        commandMappings: {
          Insert: { items: mapForCreate },
          Update: { items: mapForUpdate },
        },
      };
    }
    meta[ent] = table;
  }

  localStorage.setItem("prop.meta.v1", JSON.stringify(meta));
  return meta;
}


function seedConfirmedTables(schema: { entities: SchemaEntity[] }) {
  const tables = (schema.entities || []).map((e) => e.name);
  localStorage.setItem("schema.entities", JSON.stringify(schema.entities || []));
  localStorage.setItem("schema.tables", JSON.stringify(tables));
  localStorage.setItem("page2.confirmed.tables", JSON.stringify(tables));
}

function syncPsMethodsFromFns(functions: Fn[]) {
  const ps = (functions || []).map((f) => ({
    functionName: f.name,
    inputs: (f.inputs || []).map((p) => ({
      name: p.name,
      type: p.type,
      mandatory: !!p.mandatory,
    })),
  }));
  localStorage.setItem("ps.methods.v2", JSON.stringify(ps));
  localStorage.setItem("ps.methods", JSON.stringify(ps));
  return ps;
}

/** Generate a PowerShell stub with inline markers */
function buildPsStub(fnName: string, schema: any): string | null {
  const { verb, entity } = parseFnName(fnName); // FIX: use renamed
  if (!verb || !entity || !schema?.entities) return null;
    // NEW: normalize synonyms (Modify→Update, Remove→Delete, etc.)
  const V = canonicalVerb(verb);
  const ent = (schema.entities as any[]).find(
    (e) => (e?.name || "").toLowerCase() === entity.toLowerCase()
  );
  if (!ent) return null;

  const attrs: Array<{ name: string; type?: string }> = Array.isArray(ent.attributes)
    ? ent.attributes
    : [];

  const keyName = getKeyName(attrs);

  const withoutKey = attrs.filter((a) => a.name !== keyName);

  type P = {
    name: string;
    t: UiType;
    mandatory: boolean;
    source: "Schema" | "Connection";
    isKey?: boolean;
  };
  let params: P[] = [];

  if (V === "Get") {
    params = [
      {
        name: keyName,
        t: ui(attrs.find((a) => a.name === keyName)?.type),
        mandatory: false,
        source: "Schema",
        isKey: true,
      },
    ];
  } else if (V === "Create") {
    const list = withoutKey.length ? withoutKey : [{ name: "Name", type: "String" }];
    params = list.map((a) => ({
      name: a.name,
      t: ui(a.type),
      mandatory: true,
      source: "Schema",
    }));
  } else if (V === "Update") {
    const list = withoutKey.length ? withoutKey : [{ name: "Name", type: "String" }];
    params = [
      {
        name: keyName,
        t: ui(attrs.find((a) => a.name === keyName)?.type),
        mandatory: true,
        source: "Schema",
        isKey: true,
      },
      ...list.map((a) => ({
        name: a.name,
        t: ui(a.type),
        mandatory: false,
        source: "Schema" as const,
      })),
    ];
  } else if (V === "Delete") {
    params = [
      {
        name: keyName,
        t: ui(attrs.find((a) => a.name === keyName)?.type),
        mandatory: true,
        source: "Schema",
        isKey: true,
      },
    ];
  }

  const lines = params.map((p, i) => {
    const attr = p.mandatory
      ? "[Parameter(Mandatory=$true, ValueFromPipelineByPropertyName = $true)] [ValidateNotNullOrEmpty()]"
      : "[Parameter(Mandatory=$false, ValueFromPipelineByPropertyName = $true)]";
    const comma = i === params.length - 1 ? "" : ",";
    const keyMark = p.isKey ? " # Key" : "";
    return `        ${attr} ${psType(p.t)} $${p.name}${comma} # Source: ${p.source}${keyMark}`;
  });

  const paramBlock = params.length ? `param(\n${lines.join("\n")}\n    )` : "param()";

  return `function global:${fnName} {
    [CmdletBinding()]
    ${paramBlock}

    # TODO: implement ${verb} for ${entity}
}`;
}

function toPsMethods(functions: Fn[]) {
  return (functions || []).map((f) => ({
    functionName: f.name,
    inputs: (f.inputs || []).map((p) => ({
      name: p.name,
      type: p.type as UiType,
      mandatory: !!p.mandatory,
    })),
  }));
}

function writeConnectionGlobalsFromFunctions(functions: Fn[]) {
  const seen = new Map<string, { name: string; type: UiType; sensitive?: boolean }>();
  const maybeSensitive = /password|token|secret|bearer/i;

  for (const fn of functions) {
    for (const p of fn.inputs || []) {
      if (p.source !== "Connection") continue;
      if (!seen.has(p.name)) {
        seen.set(p.name, {
          name: p.name,
          type: p.type,
          sensitive: maybeSensitive.test(p.name),
        });
      }
    }
  }
  const arr = Array.from(seen.values()).map((v) => ({
    name: v.name,
    type: v.type,
    source: "ConnectionParameter",
    description: v.name,
    sensitive: !!v.sensitive,
    secure: !!v.sensitive,
  }));
  localStorage.setItem("globals.details.v2", JSON.stringify(arr));
  localStorage.setItem("globals.details", JSON.stringify(arr));
}

export default function WorkbenchPage() {
  const [functions, setFunctions] = useState<Fn[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [xmlLive, setXmlLive] = useState<string>("");
  const xmlPretty = useMemo(() => (xmlLive ? prettyXml(xmlLive) : ""), [xmlLive]);

  const xmlType = (t: string) =>
    /int/i.test(t) ? "Int" : /bool/i.test(t) ? "Bool" : /date/i.test(t) ? "DateTime" : "String";

  const isPwUpload = useRef(false);

  const skipNextNormalXmlBuild = useRef(false);
  /** Collect connection params:
 *  1) globals.details(.v2) if present,
 *  2) else connParamsForSelection() if available,
 *  3) else conservative SQL defaults.
 */

  /** Return ONLY connection-scoped params for a function. */
/** connection params (with secure flag) for a given function name */
function getConnParamsForFunction(
  functions: { name: string; inputs?: { name: string; source?: string }[] }[],
  fnName: string
): Array<{ name: string; secure?: boolean }> {
  const fn = functions.find(f => (f?.name || "").toLowerCase() === fnName.toLowerCase());
  if (!fn) return [];
  const maybeSensitive = /password|token|secret|bearer/i;
  const seen = new Set<string>();
  return (fn.inputs || [])
    .filter(p => p?.source === "Connection")
    .map(p => String(p?.name || "").trim())
    .filter(Boolean)
    .filter(n => !seen.has(n) && seen.add(n))
    .map(n => ({ name: n, secure: maybeSensitive.test(n) }));
}
// --- verb sets (treat Update≡Modify, Delete≡Remove) ---
const LIST_VERBS   = ["Get", "List", "Find", "Read", "Query", "Search", "Fetch", "Select"];
const INSERT_VERBS = ["Create", "Add", "Insert", "New"];
const UPDATE_VERBS = ["Update", "Modify", "Set", "Patch", "Change"]; // <-- Update aliases
const DELETE_VERBS = ["Delete", "Remove", "Erase", "Drop"];           // <-- Delete aliases

function _split(name: string) {
  const m = String(name || "").match(/^([A-Za-z_]+)-(.+)$/);
  return { verb: (m?.[1] || ""), noun: (m?.[2] || "") };
}
function _singularize(s: string) {
  const n = s.toLowerCase();
  if (n.endsWith("ies")) return n.slice(0, -3) + "y";
  if (n.endsWith("es"))  return n.slice(0, -2);
  if (n.endsWith("s"))   return n.slice(0, -1);
  return n;
}
function _nounMatchesEntity(noun: string, entity: string) {
  const n = noun.toLowerCase();
  const e = entity.toLowerCase();
  return n === e || _singularize(n) === e;
}
function _firstFnForEntity(
  functions: { name: string }[],
  entity: string,
  verbs: string[]
): string | null {
  const f = functions.find(fn => {
    const { verb, noun } = _split(fn.name);
    return verbs.some(v => v.toLowerCase() === verb.toLowerCase())
        && _nounMatchesEntity(noun, entity);
  });
  return f ? f.name : null;
}

function _findFnsForEntity(functions: { name: string }[], entity: string) {
  return {
    list:   _firstFnForEntity(functions, entity, LIST_VERBS),
    insert: _firstFnForEntity(functions, entity, INSERT_VERBS),
    update: _firstFnForEntity(functions, entity, UPDATE_VERBS),
    del:    _firstFnForEntity(functions, entity, DELETE_VERBS),
  };
}

// Build SetParameter lines only from that function’s *connection* params
function _setParamsForFn(
  functions: { name: string; inputs?: { name: string; source?: string }[] }[],
  fnName: string
): string {
  const connParams = getConnParamsForFunction(functions, fnName); // you already have this helper
  return connParams.map(p =>
    `        <SetParameter Value="${p.name}" Source="ConnectionParameter" Param="${p.name}"${
      p.secure ? ' ConversionMode="SecureString"' : ""
    }/>`
  ).join("\n");
}
/**
 * For every <Class Name="X">…</Class>:
 *  - Choose functions for X (Get/Create/Update/Delete/Modify/Remove)
 *  - Rebuild <ReadConfiguration> with ONE Listing + ONE Item using that Get-… function
 *  - Rebuild <MethodConfiguration> methods present (Insert/Update/Delete),
 *    each with ONE <Item> and SetParameters ONLY for that function’s connection params
 */
function rebuildReadAndMethodsPerClass(
  xmlIn: string,
  functions: { name: string; inputs?: { name: string; source?: string }[] }[]
): string {
  let xml = xmlIn || "";
  if (!functions?.length) return xml;

  const classRe = /(<Class\b[^>]*\bName="([^"]+)"[^>]*>)([\s\S]*?)(<\/Class>)/gi;

  xml = xml.replace(classRe, (_whole, open: string, className: string, mid: string, close: string) => {
    const { list, insert, update, del } = _findFnsForEntity(functions, className);

    // If NO functions at all for this entity, leave class as-is (the next step may drop it).
    if (!list && !insert && !update && !del) return `${open}${mid}${close}`;

    // ---- ReadConfiguration (only if list exists) ----
    let rc = "";
    if (list) {
      const setLines = _setParamsForFn(functions, list);
      rc =
`    <ReadConfiguration>
      <ListingCommand Command="${list}">
${setLines ? setLines + "\n" : ""}      </ListingCommand>
      <CommandSequence>
        <Item Order="1" Command="${list}">
${setLines ? setLines + "\n" : ""}        </Item>
      </CommandSequence>
    </ReadConfiguration>`;
    }

    // ---- MethodConfiguration (only for present methods) ----
    const methods: string[] = [];
    if (insert) {
      const setLines = _setParamsForFn(functions, insert);
      methods.push(
`      <Method Name="Insert">
        <CommandSequence>
          <Item Order="1" Command="${insert}">
${setLines ? setLines + "\n" : ""}          </Item>
        </CommandSequence>
      </Method>`
      );
    }
    if (update) {
      const setLines = _setParamsForFn(functions, update);
      methods.push(
`      <Method Name="Update">
        <CommandSequence>
          <Item Order="1" Command="${update}">
${setLines ? setLines + "\n" : ""}          </Item>
        </CommandSequence>
      </Method>`
      );
    }
    if (del) {
      const setLines = _setParamsForFn(functions, del);
      methods.push(
`      <Method Name="Delete">
        <CommandSequence>
          <Item Order="1" Command="${del}">
${setLines ? setLines + "\n" : ""}          </Item>
        </CommandSequence>
      </Method>`
      );
    }
    const methodBlock = methods.length ? `    <MethodConfiguration>\n${methods.join("\n")}\n    </MethodConfiguration>` : "";

    // Strip any existing RC/Method blocks and re-insert ours in a clean order:
    let body = mid
      .replace(/<ReadConfiguration>[\s\S]*?<\/ReadConfiguration>\s*/gi, "")
      .replace(/<MethodConfiguration>[\s\S]*?<\/MethodConfiguration>\s*/gi, "");

    // Prefer: Properties → RC → MethodConfiguration → the rest
    // Insert RC after </Properties> if present; else prepend
    if (rc) {
      if (/<Properties>[\s\S]*?<\/Properties>/i.test(body)) {
        body = body.replace(/<Properties>[\s\S]*?<\/Properties>/i, m => `${m}\n${rc}\n`);
      } else {
        body = `${rc}\n${body}`;
      }
    }
    if (methodBlock) {
      // place methods after RC if we added one, else after Properties, else prepend
      if (rc && /<ReadConfiguration>/.test(body)) {
        body = body.replace(/<\/ReadConfiguration>/i, match => `${match}\n${methodBlock}`);
      } else if (/<Properties>[\s\S]*?<\/Properties>/i.test(body)) {
        body = body.replace(/<Properties>[\s\S]*?<\/Properties>/i, m => `${m}\n${methodBlock}\n`);
      } else {
        body = `${methodBlock}\n${body}`;
      }
    }

    body = body.replace(/\n{3,}/g, "\n\n");
    return `${open}${body}${close}`;
  });

  return xml;
}
/**
 * Remove any <Class Name="X">…</Class> for which no corresponding functions exist
 * (no Get/List, no Create/Add/Insert/New, no Update/Modify/Set/Patch/Change, no Delete/Remove/…).
 */
function dropClassesWithoutFunctions(
  xmlIn: string,
  functions: { name: string }[]
): string {
  let xml = xmlIn || "";
  if (!functions?.length) return xml;

  const classRe = /(<Class\b[^>]*\bName="([^"]+)"[^>]*>)([\s\S]*?)(<\/Class>)/gi;

  xml = xml.replace(classRe, (_whole, open: string, className: string, mid: string, close: string) => {
    const { list, insert, update, del } = _findFnsForEntity(functions, className);
    if (!list && !insert && !update && !del) {
      // drop the whole class
      return "";
    }
    return `${open}${mid}${close}`;
  });

  // clean leftover double newlines
  return xml.replace(/\n{3,}/g, "\n\n");
}

/** pick Get-<Entity>s (or closest) for an entity */
function pickListFnForEntity(
  entity: string,
  functions: { name: string }[]
): string | null {
  const wanted = `Get-${entity}s`.toLowerCase();
  const exact  = functions.find(f => (f?.name || "").toLowerCase() === wanted);
  if (exact) return exact.name;

  const alt = functions.find(f => {
    const n = String(f?.name || "");
    const m = n.match(/^get-(.+)$/i);
    if (!m) return false;
    return m[1].replace(/s$/i, "").toLowerCase() === entity.toLowerCase();
  });
  return alt ? alt.name : null;
}




/**
 * Rebuilds <ReadConfiguration> so that:
 *   - There is exactly one <Item ...> per schema entity in <CommandSequence>.
 *   - Each <Item> uses that entity's Get-<Entity>s function (if present).
 *   - Each <Item> contains SetParameters for THAT function's *connection* params only.
 *   - Keeps/repairs a single <ListingCommand> (first entity that has a Get-…).
 */
/**
 * Rebuild <ReadConfiguration> so it contains:
 *   - ONE <ListingCommand> (for the active entity’s Get-…)
 *   - ONE <CommandSequence> with ONE <Item> (same Get-…)
 *   - SetParameters only for that function’s connection params
 */
function ensureReadConfigurationForSingleEntity(
  xmlIn: string,
  functions: { name: string; inputs?: { name: string; source?: string }[] }[],
  schema: { entities?: { name: string }[] } | null,
  activeEntity?: string | null
): string {
  let xml = xmlIn || "";
  const entities = Array.isArray(schema?.entities) ? schema!.entities : [];
  if (!entities.length || !functions.length) return xml;

  // Determine active entity:
  // 1) provided arg, 2) a persisted choice, 3) first in schema
  const persisted = String(localStorage.getItem("active.entity") || "").trim() || null;
  const entity = (activeEntity || persisted || entities[0]?.name || "").trim();
  if (!entity) return xml;

  const listFn = pickListFnForEntity(entity, functions);
  if (!listFn) return xml; // nothing to emit

  const connParams = getConnParamsForFunction(functions, listFn);
  const setLines = connParams.map(p =>
    `    <SetParameter Value="${p.name}" Source="ConnectionParameter" Param="${p.name}"${
      p.secure ? ' ConversionMode="SecureString"' : ""
    }/>`
  ).join("\n");

  const listingXml =
`  <ListingCommand Command="${listFn}">
${setLines ? setLines.replace(/^/gm, "  ") : ""}${setLines ? "\n" : ""}  </ListingCommand>`;

  const itemXml =
`  <CommandSequence>
    <Item Order="1" Command="${listFn}">
${setLines ? setLines + "\n" : ""}    </Item>
  </CommandSequence>`;

  const readBlock =
`<ReadConfiguration>
${listingXml}
${itemXml}
</ReadConfiguration>`;

  // Strong replace: nuke any existing <ReadConfiguration> block entirely
  if (/<ReadConfiguration\b[\s\S]*?<\/ReadConfiguration>/i.test(xml)) {
    xml = xml.replace(/<ReadConfiguration\b[\s\S]*?<\/ReadConfiguration>/i, readBlock);
  } else if (/<\/EnvironmentInitialization>/i.test(xml)) {
    xml = xml.replace(/<\/EnvironmentInitialization>/i, m => `${m}\n${readBlock}\n`);
  } else if (/<\/Initialization>/i.test(xml)) {
    xml = xml.replace(/<\/Initialization>/i, m => `${m}\n${readBlock}\n`);
  } else if (/<MethodConfiguration\b/i.test(xml)) {
    xml = xml.replace(/<MethodConfiguration\b/i, `${readBlock}\n<MethodConfiguration`);
  } else {
    xml = `${xml}\n${readBlock}\n`;
  }

  return xml;
}

/**
 * For each <Class Name="..."> ... </Class> in the XML:
 *   - find the entity name from the Name attribute
 *   - pick that entity's Get-* function
 *   - build ONE <ReadConfiguration> with ONE <ListingCommand> and ONE <CommandSequence>/<Item>
 *   - replace any existing ReadConfiguration in that class with the new single block
 */
function ensureReadConfigurationPerEntityForAllClasses(
  xmlIn: string,
  functions: { name: string; inputs?: { name: string; source?: string }[] }[],
  schema: { entities?: { name: string }[] } | null
): string {
  let xml = xmlIn || "";
  if (!functions?.length) return xml;

  // Process each <Class Name="…">…</Class> independently
  xml = xml.replace(
    /<Class\b([^>]*)>([\s\S]*?)<\/Class>/gi,
    (whole, attrStr: string, classInner: string) => {
      const nameMatch = String(attrStr).match(/\bName="([^"]+)"/i);
      const entity = (nameMatch?.[1] || "").trim();
      if (!entity) return whole;

      const listFn = pickListFnForEntity(entity, functions);
      if (!listFn) {
        // If we can't find a Get-* for this entity, drop any stale ReadConfiguration in the class.
        const cleaned = classInner.replace(/<ReadConfiguration\b[\s\S]*?<\/ReadConfiguration>\s*/gi, "");
        return `<Class${attrStr}>${cleaned}</Class>`;
      }

      const connParams = getConnParamsForFunction(functions, listFn);
      const setLines = connParams
        .map(p =>
          `    <SetParameter Value="${p.name}" Source="ConnectionParameter" Param="${p.name}"${
            p.secure ? ' ConversionMode="SecureString"' : ""
          }/>`
        )
        .join("\n");

      const readBlock =
`<ReadConfiguration>
  <ListingCommand Command="${listFn}">
${setLines ? setLines.replace(/^/gm, "  ") : ""}${setLines ? "\n" : ""}  </ListingCommand>
  <CommandSequence>
    <Item Order="1" Command="${listFn}">
${setLines ? setLines + "\n" : ""}    </Item>
  </CommandSequence>
</ReadConfiguration>`;

      // Replace any existing ReadConfiguration within this class (strong replace). If none, insert near top.
      let body = classInner.replace(/<ReadConfiguration\b[\s\S]*?<\/ReadConfiguration>\s*/gi, "");
      // Prefer to put it right after <Properties> or at the beginning of the class body.
      if (/<Properties>/i.test(body)) {
        body = body.replace(/<Properties>[\s\S]*?<\/Properties>/i, m => `${m}\n${readBlock}\n`);
      } else {
        body = `${readBlock}\n${body}`;
      }
      return `<Class${attrStr}>${body}</Class>`;
    }
  );

  return xml;
}

/** Choose the List function: prefer first Get-* present in the functions array. */
function pickListFnFromFunctions(functions: { name: string }[]): string {
  const firstGet = functions.find(f => /^get-/i.test(String(f?.name || "")));
  return firstGet ? firstGet.name : (functions[0]?.name || "Get-Items");
}

function getConnParamsFallback(): Array<{ name: string; secure?: boolean }> {
  const fromGlobals =
    JSON.parse(
      localStorage.getItem("globals.details.v2") ||
        localStorage.getItem("globals.details") ||
        "[]"
    ) || [];

  if (Array.isArray(fromGlobals) && fromGlobals.length) {
    return fromGlobals.map((g: any) => ({
      name: String(g?.name || "").trim(),
      secure:
        !!g?.secure ||
        !!g?.sensitive ||
        /password|token|secret/i.test(String(g?.name || "")),
    })).filter(x => x.name);
  }

  // Try builder’s current dropdowns, if the function exists in scope
  try {
    // @ts-ignore – exists inside this component file
    if (typeof connParamsForSelection === "function") {
      // @ts-ignore
      const v = connParamsForSelection();
      if (Array.isArray(v) && v.length) {
        return v.map((p: any) => ({
          name: String(p?.name || "").trim(),
          secure: /password|token|secret/i.test(String(p?.name || "")),
        })).filter(x => x.name);
      }
    }
  } catch { /* ignore */ }

  // Conservative defaults so <Item> is never empty
  return [
    { name: "Server" },
    { name: "Port" },
    { name: "Database" },
    { name: "UserName" },
    { name: "Password", secure: true },
  ];
}
  /**
 * Build/repair <ReadConfiguration> so that:
 * - <ListingCommand Command="Get-..."> exists
 * - <CommandSequence><Item Order="1" Command="Get-..."> exists
 * - each block contains <SetParameter> lines for that *function's* connection params only
 */
function ensureReadConfigurationFromFns(
  xmlIn: string,
  functions: { name: string; inputs?: { name: string; source?: string }[] }[]
): string {
  let xml = xmlIn || "";
  if (!Array.isArray(functions) || functions.length === 0) return xml;

  const listFn = pickListFnFromFunctions(functions);
  const connParams = getConnParamsForFunction(functions, listFn); // ← only this fn’s connection params
  const setParamLines = connParams.map(p =>
    `    <SetParameter Value="${p.name}" Source="ConnectionParameter" Param="${p.name}"${
      p.secure ? ' ConversionMode="SecureString"' : ""
    }/>`
  );
  const setBlock = setParamLines.length ? setParamLines.join("\n") + "\n" : "";

  const listingXml =
`  <ListingCommand Command="${listFn}">
${setBlock}  </ListingCommand>`;

  const itemXml =
`  <CommandSequence>
    <Item Order="1" Command="${listFn}">
${setBlock}    </Item>
  </CommandSequence>`;

  const buildRead = () => `<ReadConfiguration>\n${listingXml}\n\n${itemXml}\n</ReadConfiguration>\n`;

  // If there is no <ReadConfiguration> at all, insert a fresh one.
  if (!/<ReadConfiguration>\s*[\s\S]*?<\/ReadConfiguration>/i.test(xml)) {
    if (/<\/EnvironmentInitialization>/i.test(xml)) {
      return xml.replace(/<\/EnvironmentInitialization>/i, m => `${m}\n${buildRead()}`);
    }
    if (/<\/Initialization>/i.test(xml)) {
      return xml.replace(/<\/Initialization>/i, m => `${m}\n${buildRead()}`);
    }
    if (/<MethodConfiguration\b/i.test(xml)) {
      return xml.replace(/<MethodConfiguration\b/i, `${buildRead()}<MethodConfiguration`);
    }
    return `${xml}\n${buildRead()}`;
  }

  // Otherwise, update/repair existing section
  xml = xml.replace(
    /(<ReadConfiguration>\s*)([\s\S]*?)(\s*<\/ReadConfiguration>)/i,
    (_whole, head: string, inner: string, tail: string) => {
      let body = inner;

      // Ensure/repair ListingCommand
      if (!/<ListingCommand\b/i.test(body)) {
        body = `${listingXml}\n\n${body}`;
      } else {
        body = body.replace(
          /<ListingCommand\b([^>]*)>([\s\S]*?)<\/ListingCommand>/i,
          (_m, attrs: string, lcInner: string) => {
            const withCmd = /\bCommand=/i.test(attrs) ? attrs : `${attrs} Command="${listFn}"`;
            // replace inner entirely with the computed SetParameters (no defaults if empty)
            const nextInner = setBlock + lcInner.replace(/<SetParameter\b[\s\S]*?\/>\s*/gi, "");
            return `<ListingCommand${withCmd}>${nextInner}</ListingCommand>`;
          }
        );
      }

      // Ensure/repair CommandSequence/Item
      if (!/<CommandSequence>\s*[\s\S]*<\/CommandSequence>/i.test(body)) {
        body = `${body}\n\n${itemXml}\n`;
      } else {
        body = body.replace(
          /<CommandSequence>\s*([\s\S]*?)\s*<\/CommandSequence>/i,
          (_m, csInner: string) => {
            if (!/<Item\b/i.test(csInner)) {
              return `\n${itemXml}\n`;
            }
            return `<CommandSequence>${
              csInner.replace(
                /<Item\b([^>]*)>([\s\S]*?)<\/Item>/i,
                (_mi, iAttrs: string, iInner: string) => {
                  const withCmd = /\bCommand=/i.test(iAttrs) ? iAttrs : `${iAttrs} Command="${listFn}"`;
                  const withOrder = /\bOrder=/i.test(withCmd) ? withCmd : `${withCmd} Order="1"`;
                  const strippedInner = iInner.replace(/<SetParameter\b[\s\S]*?\/>\s*/gi, "");
                  const nextInner = setBlock + strippedInner;
                  return `<Item${withOrder}>${nextInner}</Item>`;
                }
              )
            }</CommandSequence>`;
          }
        );
      }

      return `${head}${body}${tail}`;
    }
  );

  return xml;
}

  function ensureCommandMappingsAndGlobals(xmlIn: string): string {
  let xml = xmlIn || "";

  const bindings =
    JSON.parse(localStorage.getItem("bindings.v3") || localStorage.getItem("bindings") || "{}");

  // ---- Build <CommandMappings> if missing (unchanged logic) ----
  const hasCM = /<CommandMappings\b/i.test(xml);
  let cmXml = "";
  if (!hasCM && bindings && typeof bindings === "object") {
    const ops: Array<"Insert" | "Update" | "Delete" | "List" | "View"> = [
      "Insert",
      "Update",
      "Delete",
      "List",
      "View",
    ];
    const lines: string[] = ["  <CommandMappings>"];
    for (const ent of Object.keys(bindings)) {
      for (const op of ops) {
        const fnList = bindings[ent]?.[op]?.functions || [];
        if (!Array.isArray(fnList) || fnList.length === 0) continue;

        for (const f of fnList) {
          const fnName = String(f?.functionName || "");
          if (!fnName) continue;

          lines.push(`    <CommandMapping Entity="${ent}" Operation="${op}">`);
          lines.push(`      <Chain>`);
          lines.push(`        <Item Command="${fnName}" />`);
          lines.push(`      </Chain>`);

          const inputs = f?.inputs || {};
          const keys = Object.keys(inputs);
          if (keys.length) {
            lines.push(`      <ParameterBindings>`);
            for (const pName of keys) {
              const val = String(inputs[pName] ?? "").trim();
              if (!val) continue;
              lines.push(`        <Bind Parameter="${pName}" Property="${val}" />`);
            }
            lines.push(`      </ParameterBindings>`);
          }
          lines.push(`    </CommandMapping>`);
        }
      }
    }
    lines.push(`  </CommandMappings>`);
    cmXml = lines.length > 2 ? lines.join("\n") : "";
  }

  // ---- Build SetParameter lines from globals OR fallback ----
  const connParams = getConnParamsFallback();
  const setParamLines = connParams
    .map(({ name, secure }) =>
      `    <SetParameter Value="${name}" Source="ConnectionParameter" Param="${name}"${
        secure ? ' ConversionMode="SecureString"' : ""
      }/>`
    )
    .join("\n");

  // Insert into <ListingCommand> if none exist
  if (setParamLines) {
    xml = xml.replace(/(<ListingCommand\b[^>]*>)(?!\s*\n)/gi, "$1\n");
    xml = xml.replace(
      /(<ListingCommand\b[^>]*>\s*)(?![\s\S]*?<SetParameter\b)/gi,
      (_m, open) => `${open}${setParamLines}\n`
    );
  }

  // Insert into each <Method>/<Item> if none exist
  if (setParamLines && /<MethodConfiguration\b/i.test(xml)) {
    xml = xml.replace(
      /(<MethodConfiguration\b[\s\S]*?<\/MethodConfiguration>)/gi,
      (block: string) =>
        block.replace(
          /(<Item\b[^>]*>)(?![^<]*<SetParameter\b)/gi,
          (_m, openItem) => `${openItem}${setParamLines}\n`
        )
    );
  }

  // ---- Mirror ReadConfiguration → CommandSequence/Item (+ guaranteed non-empty) ----
  xml = xml.replace(
    /(<ReadConfiguration>\s*)([\s\S]*?)(\s*<\/ReadConfiguration>)/i,
    (_whole, head: string, inner: string, tail: string) => {
      const m = inner.match(
        /<ListingCommand\b[^>]*Command="([^"]+)"[^>]*>([\s\S]*?)<\/ListingCommand>/i
      );
      // If no listing command, keep as is
      if (!m) return `${head}${inner}${tail}`;

      const listCmdName = m[1];
      const listingInner = m[2];

      // collect existing <SetParameter> under listing
      const listingSets = Array.from(listingInner.matchAll(/<SetParameter\b[^>]*>/gi)).map(
        (mm) => mm[0]
      );

      // ensure we at least have fallback lines
      const finalSetLines =
        (listingSets.join("\n").trim() || setParamLines || "").trim();

      const itemBlock =
`  <CommandSequence>
    <Item Order="1" Command="${listCmdName}">
${finalSetLines}
    </Item>
  </CommandSequence>`;

      // replace or append CommandSequence
      if (/\b<CommandSequence>[\s\S]*<\/CommandSequence>\b/i.test(inner)) {
        inner = inner.replace(/<CommandSequence>[\s\S]*?<\/CommandSequence>/i, itemBlock);
      } else {
        inner = inner.replace(/<\/ListingCommand>/i, (m0) => `${m0}\n${itemBlock}\n`);
      }
      return `${head}${inner}${tail}`;
    }
  );

  // ---- Append CommandMappings if we built it ----
  if (cmXml) {
    if (/<\/MethodConfiguration>/i.test(xml)) {
      xml = xml.replace(/<\/MethodConfiguration>/i, (m) => `${m}\n\n${cmXml}\n`);
    } else if (/<\/ReadConfiguration>/i.test(xml)) {
      xml = xml.replace(/<\/ReadConfiguration>/i, (m) => `${m}\n\n${cmXml}\n`);
    } else if (/<\/Connector>/i.test(xml)) {
      xml = xml.replace(/<\/Connector>/i, `\n${cmXml}\n</Connector>`);
    } else {
      xml = `${xml}\n${cmXml}\n`;
    }
  }

  return xml;
}



  function stripKeyModSections(xmlIn: string): string {
    let xml = xmlIn || "";

    xml = xml.replace(
      /<Property\b([^>]*?)>([\s\S]*?)<\/Property>/gi,
      (whole, attrStr: string, inner: string) => {
        if (!/IsUniqueKey\s*=\s*"true"/i.test(attrStr)) return whole;

        const nameMatch = attrStr.match(/\bName="([^"]+)"/i);
        const propName = nameMatch ? nameMatch[1] : "";

        let body = inner.replace(/<ModifiedBy>[\s\S]*?<\/ModifiedBy>/gi, "");

        body = body.replace(
          /<CommandMappings>([\s\S]*?)<\/CommandMappings>/gi,
          (_cmWhole, cmInner: string) => {
            let cleaned = cmInner;
            if (propName) {
              const selfClosing = new RegExp(
  String.raw`<Map\b[^>]*\bToCommand="(?:Create|Update|Modify)-[^"]+"\b[^>]*\bParameter="${propName}"[^>]*/>\s*`,
  "gi"
);
              cleaned = cleaned.replace(selfClosing, "");
              const openClose = new RegExp(
  String.raw`<Map\b[^>]*\bToCommand="(?:Create|Update|Modify)-[^"]+"\b[^>]*\bParameter="${propName}"[^>]*>\s*<\/Map>\s*`,
  "gi"
);
              cleaned = cleaned.replace(openClose, "");
            }
            return `<CommandMappings>${cleaned}</CommandMappings>`;
          }
        );

        return `<Property${attrStr}>${body}</Property>`;
      }
    );

    return xml;
  }

  /** Convert
 *   <ReadConfiguration><ListingCommand Command="X">…</ListingCommand></ReadConfiguration>
 * into
 *   <ReadConfiguration><CommandSequence><Item Order="1" Command="X">…</Item></CommandSequence></ReadConfiguration>
 * (keeps the existing SetParameter lines as the Item body).
 */
function normalizeReadConfiguration(xmlIn: string): string {
  let xml = xmlIn || "";

  xml = xml.replace(
    /<ReadConfiguration>\s*([\s\S]*?)\s*<\/ReadConfiguration>/i,
    (_whole, inner: string) => {
      // already in CommandSequence/Item? keep as-is
      if (/<CommandSequence\b[\s\S]*?<Item\b/i.test(inner)) {
        return `<ReadConfiguration>${inner}</ReadConfiguration>`;
      }

      // look for ListingCommand
      const m = inner.match(
        /<ListingCommand\b[^>]*\bCommand\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/ListingCommand>/i
      );
      if (!m) {
        // nothing recognizable, return unchanged
        return `<ReadConfiguration>${inner}</ReadConfiguration>`;
      }

      const cmd = m[1];
      const body = m[2] || "";

      const rebuilt =
        `<CommandSequence>\n` +
        `  <Item Order="1" Command="${cmd}">\n` +
        (body.trim() ? `    ${body.trim()}\n` : "") +
        `  </Item>\n` +
        `</CommandSequence>`;

      return `<ReadConfiguration>\n${rebuilt}\n</ReadConfiguration>`;
    }
  );

  return xml;
}

  function spLine(g: any) {
  const name = String(g?.name || "").trim();
  if (!name) return "";
  const secure = !!g?.secure || !!g?.sensitive || /password|token|secret/i.test(name);
  return `    <SetParameter Value="${name}" Source="ConnectionParameter" Param="${name}"${
    secure ? ' ConversionMode="SecureString"' : ""
  }/>`;
}

 function insertSetParamsIntoCommands(xmlIn: string): string {
  let xml = xmlIn || "";

  const connParams = getConnParamsFallback();
  if (!connParams.length) return xml;

  const spLine = ({ name, secure }: { name: string; secure?: boolean }) =>
    `    <SetParameter Value="${name}" Source="ConnectionParameter" Param="${name}"${
      secure ? ' ConversionMode="SecureString"' : ""
    }/>`;

  // ListingCommand: add any missing
  xml = xml.replace(
    /<ListingCommand\b([^>]*)>([\s\S]*?)<\/ListingCommand>/gi,
    (whole, attrs: string, inner: string) => {
      const existing = new Set<string>();
      inner.replace(/<SetParameter\b[^>]*\bParam="([^"]+)"/gi, (_, p) => {
        existing.add(String(p));
        return "";
      });

      const lines: string[] = [];
      for (const g of connParams) {
        if (!g.name || existing.has(g.name)) continue;
        lines.push(spLine(g));
      }
      if (!lines.length) return whole;
      return `<ListingCommand${attrs}>${lines.join("\n")}\n${inner}</ListingCommand>`;
    }
  );

  // Method/Item: add any missing into each <Item>
  xml = xml.replace(
    /<Method\b([^>]*)>([\s\S]*?)<\/Method>/gi,
    (methodWhole, mAttrs: string, mInner: string) => {
      const updatedInner = mInner
        .replace(
          /<Item\b([^>]*)>([\s\S]*?)<\/Item>/gi,
          (itemWhole, iAttrs: string, iInner: string) => {
            const existing = new Set<string>();
            iInner.replace(/<SetParameter\b[^>]*\bParam="([^"]+)"/gi, (_, p) => {
              existing.add(String(p));
              return "";
            });
            const lines = connParams
              .filter((g) => g.name && !existing.has(g.name))
              .map(spLine);
            if (!lines.length) return itemWhole;
            return `<Item${iAttrs}>\n${lines.join("\n")}\n${iInner}</Item>`;
          }
        )
        .replace(/<Item\b([^>]*)\/>/gi, (itemSelf, iAttrs: string) => {
          const lines = connParams.map(spLine).join("\n");
          return `<Item${iAttrs}>\n${lines}\n</Item>`;
        });
      return `<Method${mAttrs}>${updatedInner}</Method>`;
    }
  );

  // Safety mirror for ReadConfiguration (guarantee non-empty)
  xml = xml.replace(
    /(<ReadConfiguration>\s*)([\s\S]*?)(\s*<\/ReadConfiguration>)/i,
    (_whole, head: string, inner: string, tail: string) => {
      const m = inner.match(
        /<ListingCommand\b[^>]*Command="([^"]+)"[^>]*>([\s\S]*?)<\/ListingCommand>/i
      );
      if (!m) return `${head}${inner}${tail}`;

      const listCmdName = m[1];
      const listingInner = m[2];
      const existingSetLines = Array.from(
        listingInner.matchAll(/<SetParameter\b[^>]*>/gi)
      ).map((mm) => mm[0]);

      let finalSetLines = existingSetLines.join("\n").trim();
      if (!finalSetLines) {
        finalSetLines = connParams.map(spLine).join("\n");
      }

      const itemBlock =
`  <CommandSequence>
    <Item Order="1" Command="${listCmdName}">
${finalSetLines}
    </Item>
  </CommandSequence>`;

      if (/\b<CommandSequence>[\s\S]*<\/CommandSequence>\b/i.test(inner)) {
        inner = inner.replace(/<CommandSequence>[\s\S]*?<\/CommandSequence>/i, itemBlock);
      } else {
        inner = inner.replace(/<\/ListingCommand>/i, (m0) => `${m0}\n${itemBlock}\n`);
      }
      return `${head}${inner}${tail}`;
    }
  );

  return xml;
}



  function writeConnectionGlobalsFromSelection() {
  const fresh = connParamsForSelection(); // uses connFamily/sqlMode/restAuth/soapMode/scimAuth/security
  const maybeSensitive = /password|token|secret|bearer/i;

  const arr = fresh.map(p => ({
    name: p.name,
    type: p.type,
    source: "ConnectionParameter",
    description: p.name,
    sensitive: maybeSensitive.test(p.name),
    secure: maybeSensitive.test(p.name),
  }));

  localStorage.setItem("globals.details.v2", JSON.stringify(arr));
  localStorage.setItem("globals.details", JSON.stringify(arr));
}

/** Keep only connection parameters in the Get-Authorization custom command's CDATA (param block). */
function pruneGetAuthorizationParams(xmlIn: string): string {
  let xml = xmlIn || "";

  // Get the current set of connection parameter names (globals.details is already connection-only)
  const globals = JSON.parse(
    localStorage.getItem("globals.details.v2") ||
    localStorage.getItem("globals.details") ||
    "[]"
  ) as Array<{ name?: string }>;

  const connNames = new Set(
    globals.map(g => String(g?.name || "").trim()).filter(Boolean)
  );
  if (connNames.size === 0) return xml;

  // Find the <CustomCommand Name="Get-Authorization"> <![CDATA[ param( ... ) ]]> block
  xml = xml.replace(
    /(<CustomCommand\b[^>]*\bName="Get-Authorization"[^>]*>\s*<!\[CDATA\[\s*param\(\s*)([\s\S]*?)(\s*\)\s*\]\]>\s*<\/CustomCommand>)/gi,
    (_whole, head: string, mid: string, tail: string) => {
      // Keep only lines that declare a parameter whose "$Name" is in connNames
      // We’ll be lenient: match both "][string]$Name" and "[string] $Name"
      const keptLines: string[] = [];
      for (const line of mid.split(/\r?\n/)) {
        const m = line.match(/\$\s*([A-Za-z_][A-Za-z0-9_]*)\b/);
        if (!m) continue; // not a parameter line
        const pname = m[1];
        if (connNames.has(pname)) keptLines.push(line);
      }
      // If for some reason nothing matched, fall back to original mid to be safe
      const next = keptLines.length ? keptLines.join("\n") : mid;
      return `${head}${next}${tail}`;
    }
  );

  return xml;
}
/** Keep exactly one ListingCommand + one CommandSequence/Item per <ReadConfiguration>,
 *  and de-dupe SetParameter lines by Param within both places.
 */
function normalizeReadConfigurationBlocks(xmlIn: string): string {
  let xml = xmlIn || "";

  // Process every <ReadConfiguration>…</ReadConfiguration>
  xml = xml.replace(
    /<ReadConfiguration>([\s\S]*?)<\/ReadConfiguration>/gi,
    (_whole, inner: string) => {
      const takeFirst = <T,>(arr: T[] | null | undefined) =>
        Array.isArray(arr) && arr.length ? arr[0] : null;

      // 1) First <ListingCommand …>…</ListingCommand>
      const listingMatch = inner.match(/<ListingCommand\b([^>]*)>([\s\S]*?)<\/ListingCommand>/i);
      const listingAttrs = listingMatch ? listingMatch[1] : "";
      const listingInner = listingMatch ? listingMatch[2] : "";

      // 2) All <Item …>…</Item> (we keep only the first)
      const itemMatches = [...inner.matchAll(/<Item\b([^>]*)>([\s\S]*?)<\/Item>/gi)];
      const firstItem = takeFirst(itemMatches);
      const itemAttrs = firstItem ? firstItem[1] : "";
      const itemInner = firstItem ? firstItem[2] : "";

      if (!firstItem) {
        // No items at all: just keep (at most) the original listing, or return original block
        if (listingMatch) {
          const fixedListing = `<ListingCommand${listingAttrs}>${dedupeSetParams(listingInner)}</ListingCommand>`;
          return `<ReadConfiguration>\n${fixedListing}\n</ReadConfiguration>`;
        }
        // Nothing to normalize
        return `<ReadConfiguration>${inner}</ReadConfiguration>`;
      }

      // 3) De-dupe parameters within Listing and Item
      const cleanItemInner = dedupeSetParams(itemInner);

      // If we don’t have a ListingCommand, synthesize from the first Item’s command & params
      let finalListing = "";
      if (listingMatch) {
        finalListing = `<ListingCommand${listingAttrs}>\n${dedupeSetParams(listingInner)}\n</ListingCommand>`;
      } else {
        // Try to extract Command="…" from the item attrs to mirror it in the Listing
        const cmd = (itemAttrs.match(/\bCommand="([^"]+)"/i)?.[1] || "").trim();
        finalListing =
          cmd
            ? `<ListingCommand Command="${cmd}">\n${cleanItemInner}\n</ListingCommand>`
            : ""; // if no command, we silently skip synthesizing
      }

      const finalItem = `<Item${itemAttrs}>\n${cleanItemInner}\n</Item>`;
      const finalSeq = `<CommandSequence>\n${finalItem}\n</CommandSequence>`;

      const nl = (s: string) => (s ? `\n${s}\n` : "\n");
      return `<ReadConfiguration>${nl(finalListing)}${finalSeq}\n</ReadConfiguration>`;
    }
  );

  return xml;
}
function _xmlType(t?: string) {
  const s = String(t || "");
  if (/int/i.test(s)) return "Int";
  if (/bool/i.test(s)) return "Bool";
  if (/date/i.test(s)) return "DateTime";
  return "String";
}

function _getGlobals() {
  return JSON.parse(
    localStorage.getItem("globals.details.v2") ||
    localStorage.getItem("globals.details") ||
    "[]"
  ) as Array<{ name?: string; type?: string; secure?: boolean; sensitive?: boolean }>;
}

function _setParamLine(g: { name?: string; type?: string; secure?: boolean; sensitive?: boolean }) {
  const name = String(g?.name || "").trim();
  if (!name) return "";
  const secure = !!g?.secure || !!g?.sensitive || /password|token|secret/i.test(name);
  const conv = secure ? ' ConversionMode="SecureString"' : "";
  return `          <SetParameter Value="${name}" Source="ConnectionParameter" Param="${name}"${conv}/>`;
}

function _buildSetParamsBlock(): string {
  const globals = _getGlobals();
  const lines = (globals || []).map(_setParamLine).filter(Boolean);
  return lines.length ? `\n${lines.join("\n")}\n        ` : "\n        ";
}

function _dedupeSetParams(fragment: string): string {
  const lines = [...fragment.matchAll(/<SetParameter\b[^>]*\/>/gi)].map(m => m[0]);
  const byParam = new Map<string, string>();
  for (const ln of lines) {
    const key = ln.match(/\bParam="([^"]+)"/i)?.[1] || ln;
    if (!byParam.has(key)) byParam.set(key, ln);
  }
  const uniq = [...byParam.values()].join("\n");
  const stripped = fragment.replace(/<SetParameter\b[^>]*\/>\s*/gi, "");
  const trimmed = stripped.trim();
  return (uniq ? uniq + (trimmed ? "\n" : "") : "") + trimmed;
}

/** Remove duplicate <SetParameter …/> lines within a fragment, uniqued by Param attr. */
function dedupeSetParams(block: string): string {
  const lines = [...block.matchAll(/<SetParameter\b[^>]*\/>/gi)].map(m => m[0]);
  if (!lines.length) return block;

  const byParam = new Map<string, string>();
  for (const line of lines) {
    const p = line.match(/\bParam="([^"]+)"/i)?.[1] || line; // fallback entire line key
    if (!byParam.has(p)) byParam.set(p, line);
  }

  // strip all existing SetParameter and re-insert unique ones at the top (preserving other content)
  const stripped = block.replace(/<SetParameter\b[^>]*\/>\s*/gi, "");
  const uniq = [...byParam.values()].join("\n");
  const trimmed = stripped.trim();
  return uniq + (trimmed ? "\n" + trimmed : "");
}

function _normalizeReadConfigOnce(inner: string): string {
  const listing = inner.match(/<ListingCommand\b[^>]*>[\s\S]*?<\/ListingCommand>/i)?.[0] || "";
  const csAll   = [...inner.matchAll(/<CommandSequence>[\s\S]*?<\/CommandSequence>/gi)].map(m => m[0]);
  let firstCS   = csAll[0] || "";

  // If there’s no CommandSequence, synthesize one from the Listing’s SetParameters
  if (!firstCS) {
    const cmd = listing.match(/\bCommand="([^"]+)"/i)?.[1] || "";
    const sets = (listing.match(/(<SetParameter\b[\s\S]*?\/>)/gi) || []).join("\n");
    if (cmd) {
      const body = _dedupeSetParams(sets);
      firstCS =
        `<CommandSequence>\n` +
        `        <Item Order="1" Command="${cmd}">\n` +
        `        ${body ? body + "\n" : ""}` +
        `        </Item>\n` +
        `      </CommandSequence>`;
    }
  } else {
    // keep only the first <Item> in the first CommandSequence
    firstCS = firstCS.replace(
      /<CommandSequence>([\s\S]*?)<\/CommandSequence>/i,
      (_m, mid) => {
        const item = mid.match(/<Item\b[^>]*>[\s\S]*?<\/Item>/i)?.[0] || "";
        if (!item) return `<CommandSequence>\n</CommandSequence>`;
        // de-dupe SetParameters in that item
        const dedupItem = item.replace(
          /<Item\b([^>]*)>([\s\S]*?)<\/Item>/i,
          (_w: any, attrs: any, body: string) => `<Item${attrs}>\n${_dedupeSetParams(body)}\n        </Item>`
        );
        return `<CommandSequence>\n        ${dedupItem}\n      </CommandSequence>`;
      }
    );
  }

  const out = [
    listing ? listing : "",
    firstCS ? firstCS : "",
  ].filter(Boolean).join("\n");
  return out || inner; // fallback if we couldn't normalize
}
/** Make sure each <Class Name="X"> has exactly one ListingCommand and one Item,
 *  both pointing at Get-${X}s, with the current connection SetParameters.
 */


/** collect every <SetParameter .../> inside a fragment (listing/items), dedupe by Param */
function _collectSetParams(fragment: string): string[] {
  const lines = [...fragment.matchAll(/<SetParameter\b[^>]*\/>/gi)].map(m => m[0]);
  const byParam = new Map<string,string>();
  for (const ln of lines) {
    const key = ln.match(/\bParam="([^"]+)"/i)?.[1] || ln;
    if (!byParam.has(key)) byParam.set(key, ln);
  }
  return [...byParam.values()];
}

/** Build one canonical ReadConfiguration for a class name using:
 *   - any existing SetParameters found under its current ReadConfiguration, OR
 *   - current connection globals if none were present.
 */
function _buildCanonicalRCForClass(xmlMid: string, className: string): string {
  const getFn = `Get-${className}s`;

  // harvest any existing SetParameters from current RC (listing + items)
  const rcMatch = xmlMid.match(/<ReadConfiguration>([\s\S]*?)<\/ReadConfiguration>/i);
  const harvested = rcMatch ? _collectSetParams(rcMatch[1]) : [];

  // if none, fall back to globals
  let setLines = harvested.length ? harvested : (_getGlobals().map(_setParamLine).filter(Boolean));

  // dedupe again by Param (in case lines came from both listing & items)
  const byParam = new Map<string,string>();
  for (const ln of setLines) {
    const key = ln.match(/\bParam="([^"]+)"/i)?.[1] || ln;
    if (!byParam.has(key)) byParam.set(key, ln);
  }
  setLines = [...byParam.values()];

  const setBlock = setLines.length ? `\n          ${setLines.join("\n          ")}\n        ` : "\n        ";

  return [
    `    <ReadConfiguration>`,
    `      <ListingCommand Command="${getFn}">`,
    setBlock.replace(/^/gm, "  "),
    `      </ListingCommand>`,
    `      <CommandSequence>`,
    `        <Item Order="1" Command="${getFn}">`,
    setBlock,
    `        </Item>`,
    `      </CommandSequence>`,
    `    </ReadConfiguration>`
  ].join("\n");
}

/** Replace each class’s ReadConfiguration with a fresh, canonical block (one Listing + one Item).
 *  This eliminates the duplicated <Item> you see in the User class and also ensures Role/Group get one.




/** Build one canonical ReadConfiguration for a class using harvested SetParameters or globals. */
function _buildCanonicalRC(className: string, harvested: string[]): string {
  const getFn = `Get-${className}s`;

  // If we didn’t harvest any, fall back to globals (connection parameters)
  let setLines = harvested;
  if (!setLines.length) {
    const globals: Array<{ name?: string; type?: string; secure?: boolean; sensitive?: boolean }> =
      JSON.parse(
        localStorage.getItem("globals.details.v2") ||
        localStorage.getItem("globals.details") ||
        "[]"
      );

    const typeOf = (t?: string) =>
      /int/i.test(String(t)) ? "Int" :
      /bool/i.test(String(t)) ? "Bool" :
      /date/i.test(String(t)) ? "DateTime" : "String";

    const buildLine = (g: any) => {
      const nm = String(g?.name || "").trim();
      if (!nm) return "";
      const secure = !!g?.secure || !!g?.sensitive || /password|token|secret/i.test(nm);
      const conv = secure ? ` ConversionMode="SecureString"` : "";
      return `        <SetParameter Value="${nm}" Source="ConnectionParameter" Param="${nm}"${conv}/>`;
    };

    setLines = globals.map(buildLine).filter(Boolean);
  }

  // final safety de-dupe by Param
  const uniqByParam = new Map<string, string>();
  for (const ln of setLines) {
    const key = ln.match(/\bParam="([^"]+)"/i)?.[1] || ln;
    if (!uniqByParam.has(key)) uniqByParam.set(key, ln);
  }
  const uniqLines = [...uniqByParam.values()];

  const setBlock = uniqLines.length
    ? `\n${uniqLines.join("\n")}\n      `
    : "\n      ";

  return [
    `    <ReadConfiguration>`,
    `      <ListingCommand Command="${getFn}">`,
    setBlock,
    `      </ListingCommand>`,
    `      <CommandSequence>`,
    `        <Item Order="1" Command="${getFn}">`,
    setBlock.replace(/^/gm, "  "),
    `        </Item>`,
    `      </CommandSequence>`,
    `    </ReadConfiguration>`
  ].join("\n");
}

/** Rebuild each class’s ReadConfiguration once, placed BEFORE MethodConfiguration, no duplicates. */
function fixReadConfigurationPerClass(xmlIn: string): string {
  let xml = xmlIn || "";
  const entities = JSON.parse(localStorage.getItem("schema.entities") || "[]") as Array<{ name: string }>;
  if (!Array.isArray(entities) || !entities.length) return xml;

  for (const e of entities) {
    const className = String(e?.name || "").trim();
    if (!className) continue;

    // Isolate the entire <Class Name="X">…</Class>
    const classRe = new RegExp(
      String.raw`(<Class\b[^>]*\bName="${className.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}"[^>]*>)([\s\S]*?)(<\/Class>)`,
      "i"
    );

    xml = xml.replace(classRe, (_whole, open: string, mid: string, close: string) => {
      // 1) harvest SetParameters from existing RC (listing + items), then remove ALL RC blocks
      const existingRC = [...mid.matchAll(/<ReadConfiguration>([\s\S]*?)<\/ReadConfiguration>/gi)];
      const harvested = existingRC.flatMap(m => _collectSetParams(m[1]));
      let bodyNoRC = mid.replace(/<ReadConfiguration>[\s\S]*?<\/ReadConfiguration>/gi, "");

      // 2) extract MethodConfiguration (to re-order RC before it), but keep original content
      const mMatch = bodyNoRC.match(/<MethodConfiguration>([\s\S]*?)<\/MethodConfiguration>/i);
      const methodBlock = mMatch ? mMatch[0] : "";
      const bodyWithoutMethod = methodBlock
        ? bodyNoRC.replace(mMatch![0], "")
        : bodyNoRC;

      // 3) build a single canonical RC
      const rc = _buildCanonicalRC(className, harvested);

      // 4) assemble in correct order:
      //    [everything except RC & Method] + RC + Method + (the rest already accounted for)
      //    If there was no MethodConfiguration, RC goes at the top.
      let newMid: string;
      if (methodBlock) {
        // insert RC immediately before MethodConfiguration
        const beforeMethod = bodyWithoutMethod.trimEnd();
        newMid = `${beforeMethod}\n${rc}\n${methodBlock}\n`;
      } else {
        // no MethodConfiguration → put RC at the start
        newMid = `${rc}\n${bodyWithoutMethod.trimStart()}`;
      }

      // normalize spacing
      newMid = newMid.replace(/\n{3,}/g, "\n\n");
      return `${open}${newMid}${close}`;
    });
  }

  return xml;
}
/** ---------- FINAL DEDUPE SWEEP FOR ReadConfiguration ---------- **/

function _rcUniqueSetParams(lines: string[]): string[] {
  const byParam = new Map<string, string>();
  for (const ln of lines) {
    const key = (ln.match(/\bParam="([^"]+)"/i)?.[1] || ln).toLowerCase();
    if (!byParam.has(key)) byParam.set(key, ln);
  }
  return [...byParam.values()];
}

function _rcCollectSetParams(fragment: string): string[] {
  return [...fragment.matchAll(/<SetParameter\b[^>]*\/>/gi)].map(m => m[0]);
}

function _rcBuild(className: string, command: string, setParams: string[]): string {
  const sp = _rcUniqueSetParams(setParams);
  const block = sp.length ? `\n${sp.map(s => `        ${s}`).join("\n")}\n      ` : "\n      ";
  return [
    `    <ReadConfiguration>`,
    `      <ListingCommand Command="${command}">`,
    block,
    `      </ListingCommand>`,
    `      <CommandSequence>`,
    `        <Item Order="1" Command="${command}">`,
    block.replace(/^/gm, "  "),
    `        </Item>`,
    `      </CommandSequence>`,
    `    </ReadConfiguration>`
  ].join("\n");
}

/**
 * For every <Class Name="X">…</Class>:
 *  - Gather ALL existing ReadConfiguration blocks.
 *  - Union & dedupe their SetParameters.
 *  - Keep exactly ONE ReadConfiguration with one Item.
 *  - Put it where the FIRST RC originally was (structure order preserved).
 */
function sweepDedupeReadConfigurations(xmlIn: string): string {
  let xml = xmlIn || "";
  const classesRe = /(<Class\b[^>]*\bName="([^"]+)"[^>]*>)([\s\S]*?)(<\/Class>)/gi;

  xml = xml.replace(classesRe, (_whole, open: string, className: string, mid: string, close: string) => {
    // Find all RCs in this class
    const rcMatches = [...mid.matchAll(/<ReadConfiguration>([\s\S]*?)<\/ReadConfiguration>/gi)];
    if (rcMatches.length === 0) {
      // nothing to dedupe here
      return `${open}${mid}${close}`;
    }

    // Index of first RC to keep position
    const firstRc = rcMatches[0];
    const firstRcStart = firstRc.index ?? 0;

    // Collect union of all SetParameters from Listing + Items
    const allSetParams: string[] = [];
    for (const m of rcMatches) allSetParams.push(..._rcCollectSetParams(m[1]));

    // Choose command: prefer first listing command name; fallback to Get-<Class>s
    const firstListingCmd =
      rcMatches
        .map(m => m[1].match(/<ListingCommand\b[^>]*\bCommand="([^"]+)"/i)?.[1])
        .find(Boolean) || `Get-${className}s`;

    // Build canonical RC
    const canonical = _rcBuild(className, firstListingCmd, allSetParams);

    // Remove ALL RCs
    let body = mid.replace(/<ReadConfiguration>[\s\S]*?<\/ReadConfiguration>/gi, "");

    // Reinsert canonical RC exactly where the FIRST was
    const before = body.slice(0, firstRcStart);
    const after  = body.slice(firstRcStart);
    const rebuilt = `${before}${canonical}\n${after}`.replace(/\n{3,}/g, "\n\n");

    return `${open}${rebuilt}${close}`;
  });

  return xml;
}

function rebuildXmlPreview() {
  const { xml } = buildXmlAllConfirmedFromLocalStorage();
  let x = xml;

  // Build per-class RC + MethodConfiguration using per-function connection params
  x = rebuildReadAndMethodsPerClass(x, functions);

  // Remove classes that lack any corresponding functions
  x = dropClassesWithoutFunctions(x, functions);

  // Keep your other cleanups (do NOT re-insert global SetParameters anywhere)
  x = pruneGetAuthorizationParams(x); // keeps only current connection globals in Get-Authorization
  x = stripKeyModSections(x);        // remove ModifiedBy + Create/Update mapping for key props
  x = sweepDedupeReadConfigurations(x); // final dedupe/normalize of RC blocks

  setXmlLive(x);
}



/** Rewrite each function's script param(...) from its current inputs, then refresh LS + XML */
function reflectInputsEverywhere(nextFns: Fn[]): Fn[] {
  // 1) update scripts' param(...) blocks from inputs[]
  const withScripts = applyInputsToScripts(nextFns); // you already have this helper

  // 2) mirror to localStorage + XML so normal flow uses the latest per-function params
  syncPsMethodsFromFns(withScripts);             // updates ps.methods(.v2)
  writeConnectionGlobalsFromFunctions(withScripts); // builds globals from source==="Connection"
  rebuildXmlPreview();                           // your normal-flow XML builder

  return withScripts;
}




  


  

  const relevant = new Set([
    "schema.entities",
    "ps.methods.v2",
    "saved.mappings.v3",
    "bindings.v3",
    "prop.meta.v1",
    "globals.details.v2",
    "plugin.assemblies",
    "assemblies.paths",
    "assemblies.list",
    "page2.confirmed.tables",
  ]);

  const [lastSchema, setLastSchema] = useState<{
    entities: { name: string; attributes?: { name: string; type?: string }[] }[];
  } | null>(null);
  const [fnQuery, setFnQuery] = useState("");
  const [newName, setNewName] = useState("");

  const [adding, setAdding] = useState(false);
  const [paramsEnabled, setParamsEnabled] = useState(false);

  type ConnFamily = "SQL" | "REST" | "SOAP" | "SCIM";
  type SqlMode = "Discrete" | "ConnString";
  type RestAuth = "None" | "Basic" | "Bearer" | "OAuth2CC" | "HMAC" | "NTLM" | "ApiKey";
  type SoapMode = "WsAddressing" | "Plain";
  // replace your current ScimAuth with this:
type ScimAuth = "None" | "Basic" | "Bearer" | "OAuth2CC" | "APIKeyHeader" | "HMAC" | "NTLM";

  type SecurityChoice =
    | "None"
    | "TLS"
    | "mTLS"
    | "APIKeyHeader"
    | "WSUserPass"
    | "SSLRequired";

  const [connFamily, setConnFamily] = useState<ConnFamily>("SQL");
  const [sqlMode, setSqlMode] = useState<SqlMode>("Discrete");
  const [restAuth, setRestAuth] = useState<RestAuth>("None");
  const [soapMode, setSoapMode] = useState<SoapMode>("Plain");
  const [scimAuth, setScimAuth] = useState<ScimAuth>("None");
  const [security, setSecurity] = useState<SecurityChoice>("None");
  const [expanded, setExpanded] = useState<Expanded>(null);

  useEffect(() => {
    
  if (isUploadMode()) return;
  // put here the states that change when a user edits:

    if (!paramsEnabled) return;
    writeConnectionGlobalsFromFunctions(functions);
    rebuildXmlPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connFamily, sqlMode, restAuth, soapMode, scimAuth, security]);

  const jsonInputRef = useRef<HTMLInputElement | null>(null);
  const pwInputRef = useRef<HTMLInputElement | null>(null);

  const makeNewFn = (name: string): Fn => ({
    id: globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2),
    name,
    script: "",
    convo: "",
    chat: "",
    xmlPreview: "",
  });

  const isValidPsFn = (s: string) =>
    /^[A-Za-z_][A-Za-z0-9_]*-[A-Za-z_][A-Za-z0-9_]*$/.test((s || "").trim());

  const nameExists = (n: string) => {
    const q = (n || "").trim().toLowerCase();
    return functions.some((f) => f.name.toLowerCase() === q);
  };

  const downloadText = (filename: string, text: string) => {
    const blob = new Blob([text ?? ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const convertScriptToXmlPreview = (name: string, script: string) => {
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<?xml version="1.0" encoding="UTF-8"?>
<Function name="${name}">
  <Script><![CDATA[
${script}
  ]]></Script>
</Function>`;
  };


  
  const selected = useMemo(
    () => functions.find((f) => f.id === selectedId) ?? null,
    [functions, selectedId]
  );

 

  const newPid = () =>
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

  const asUi = (t?: string | UiType): UiType => {
    const s = String(t ?? "").toLowerCase();
    if (s.includes("bool")) return "Bool";
    if (s.includes("int")) return "Int";
    if (s.includes("date")) return "DateTime";
    return "String";
  };

  const makeParam = (p: Partial<PsParam> & { name: string }): PsParam => ({
    pid: p.pid ?? newPid(),
    name: p.name,
    type: p.type ? asUi(p.type) : "String",
    mandatory: !!p.mandatory,
    source: (p.source ?? "Schema") as SourceType,
  });

  function buildStubParams(fnName: string, schema: any): PsParam[] {
    const { verb, entity } = parseFnName(fnName); // FIX: use renamed
    if (!verb || !entity || !schema?.entities) return [];
    const V = canonicalVerb(verb);
    const ent = (schema.entities as any[]).find(
      (e) => (e?.name || "").toLowerCase() === entity.toLowerCase()
    );
    if (!ent) return [];

    const attrs: Array<{ name: string; type?: string }> = Array.isArray(ent.attributes)
      ? ent.attributes
      : [];

    const keyName = getKeyName(attrs);

    const withoutKey = attrs.filter((a) => a.name !== keyName);

    const P = (name: string, t?: string, mandatory = false) =>
      makeParam({ name, type: ui(t), mandatory, source: "Schema" });

    if (V === "Get") {
      return [P(keyName, attrs.find((a) => a.name === keyName)?.type, false)];
    }
    if (V === "Create") {
      const list = withoutKey.length ? withoutKey : [{ name: "Name", type: "String" }];
      return list.map((a) => P(a.name, a.type, true));
    }
    if (V === "Update") {
      const list = withoutKey.length ? withoutKey : [{ name: "Name", type: "String" }];
      return [
        P(keyName, attrs.find((a) => a.name === keyName)?.type, true),
        ...list.map((a) => P(a.name, a.type, false)),
      ];
    }
    if (V === "Delete") {
      return [P(keyName, attrs.find((a) => a.name === keyName)?.type, true)];
    }
    return [];
  }

  function securityOptionsForSelection(
    family: ConnFamily,
    rest: RestAuth,
    soap: SoapMode
  ): SecurityChoice[] {
    if (family === "REST" || family === "SCIM") return ["None", "TLS", "mTLS", "APIKeyHeader"];
    if (family === "SOAP") return ["None", "TLS", "mTLS", "WSUserPass"];
    if (family === "SQL") return ["None", "SSLRequired"];
    return ["None"];
  }

  

  function connParamsForSelection(): PsParam[] {
  // tiny helper to keep calls short without introducing new types/symbols
  const req = (name: string, type: UiType): PsParam =>
    makeParam({ name, type, mandatory: true, source: "Connection" });
  const opt = (name: string, type: UiType): PsParam =>
    makeParam({ name, type, mandatory: false, source: "Connection" });

  let base: PsParam[] = [];

  if (connFamily === "SQL") {
    // Minimal SQL
    if (sqlMode === "Discrete") {
      base = [
        req("Server", "String"),
        req("Database", "String"),
        req("UserName", "String"),
        req("Password", "String"),
        opt("Port", "Int"), // optional, common but not required everywhere
      ];
    } else {
      base = [req("ConnectionString", "String")];
    }
  } else if (connFamily === "REST") {
    // Minimal REST
    base = [req("BaseUrl", "String")];

    if (restAuth === "Basic") {
      base.push(req("Username", "String"), req("Password", "String"));
    } else if (restAuth === "Bearer") {
      base.push(req("BearerToken", "String"));
    } else if (restAuth === "OAuth2CC") {
      base.push(req("TokenUrl", "String"), req("ClientId", "String"), req("ClientSecret", "String"));
    } else if (restAuth === "ApiKey") {
      base.push(req("ApiKey", "String")); // header name can default internally
    } else if (restAuth === "HMAC") {
      base.push(req("AccessKeyId", "String"), req("SecretKey", "String"));
    } else if (restAuth === "NTLM") {
      base.push(req("NtlmUsername", "String"), req("NtlmPassword", "String"), opt("Domain", "String"));
    }
  } else if (connFamily === "SOAP") {
    // Minimal SOAP
    base = [req("ServiceUrl", "String")];
    if (soapMode === "WsAddressing") {
      base.push(req("Action", "String"));
    }
  } else {
    // SCIM (minimal)
    base = [req("BaseUrl", "String")];

    if (scimAuth === "Basic") {
      base.push(req("Username", "String"), req("Password", "String"));
    } else if (scimAuth === "Bearer") {
      base.push(req("BearerToken", "String"));
    } else if (scimAuth === "OAuth2CC") {
      base.push(req("TokenUrl", "String"), req("ClientId", "String"), req("ClientSecret", "String"));
    } else if (scimAuth === "APIKeyHeader") {
      base.push(req("ApiKey", "String"));
    } else if (scimAuth === "HMAC") {
      base.push(req("AccessKeyId", "String"), req("SecretKey", "String"));
    } else if (scimAuth === "NTLM") {
      base.push(req("NtlmUsername", "String"), req("NtlmPassword", "String"), opt("Domain", "String"));
    }
  }

  // Security add-ons (only essentials)
  const extras: PsParam[] = [];
  switch (security) {
    case "mTLS":
      extras.push(req("ClientCertificatePath", "String"), req("ClientCertificatePassword", "String"));
      break;
    case "APIKeyHeader":
      // As a *security* layer (separate from REST/SCIM auth), just the key
      extras.push(req("ApiKey", "String"));
      break;
    case "WSUserPass":
      // Only meaningful for SOAP; keep minimal pair
      extras.push(req("WsUsername", "String"), req("WsPassword", "String"));
      break;
    // TLS / SSLRequired / None → no extra required fields here
  }

  // De-dupe by name while preserving first occurrence
  const seen = new Set<string>();
  const uniq: PsParam[] = [];
  for (const p of [...base, ...extras]) {
    if (!p.name || seen.has(p.name)) continue;
    seen.add(p.name);
    uniq.push(p);
  }
  return uniq;
}


  function refreshSelectedConnParams() {
    setFunctions((prev) => {
      if (!selectedId) return prev;

      return prev.map((f) => {
        if (f.id !== selectedId) return f;

        const current = f.inputs ?? [];
        const nonConn = current.filter((p) => p.source !== "Connection");
        const freshConn = connParamsForSelection();

        const connByName = new Map<string, PsParam>();
        for (const cp of freshConn) connByName.set(cp.name, cp);
        for (const p of nonConn) connByName.set(p.name, p);

        const finalList: PsParam[] = [...nonConn];
        for (const cp of freshConn) {
          if (!finalList.some((x) => x.name === cp.name)) finalList.push(cp);
        }

        return { ...f, inputs: finalList };
      });
    });
  }

  const filteredFunctions = useMemo(() => {
    const q = fnQuery.trim().toLowerCase();
    if (!q) return functions;
    return functions.filter((f) => f.name.toLowerCase().includes(q));
  }, [functions, fnQuery]);

  function stripFences(s: string) {
    const t = String(s || "").trim();
    const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return (m ? m[1] : t).trim();
  }

  useEffect(() => {
     if (isUploadMode()) return;
    const allowed = securityOptionsForSelection(connFamily, restAuth, soapMode);
    if (!allowed.includes(security)) setSecurity(allowed[0] ?? "None");
  }, [connFamily, restAuth, soapMode]); // intentionally not including `security`

  function ensureSelectedHasInputs() {
    if (!selectedId) return;
    setFunctions((prev) =>
      prev.map((f) => {
        if (f.id !== selectedId) return f;
        return { ...f, inputs: f.inputs ?? [] };
      })
    );
  }
  useEffect(() => {
     if (isUploadMode()) return;
    ensureSelectedHasInputs();
  }, [selectedId]);

  function addManualParam() {
    if (!selectedId) return;
    setFunctions((prev) =>
      prev.map((f) => {
        if (f.id !== selectedId) return f;
        const base = "NewParam";
        let name = base,
          i = 1;
        const names = new Set((f.inputs ?? []).map((p) => p.name));
        while (names.has(name)) name = `${base}${i++}`;
        const next = makeParam({ name, type: "String", mandatory: false, source: "Manual" });
        return { ...f, inputs: [...(f.inputs ?? []), next] };
      })
    );
  }
  function removeParam(pid: string) {
    if (!selectedId) return;
    setFunctions((prev) =>
      prev.map((f) => {
        if (f.id !== selectedId) return f;
        return { ...f, inputs: (f.inputs ?? []).filter((p) => p.pid !== pid) };
      })
    );
  }
  function renameParam(pid: string, nextName: string) {
  const newName = (nextName || "").trim();
  if (!selectedId || !newName) return;

  const curFn = functions.find(f => f.id === selectedId);
  if (!curFn) return;
  const target = (curFn.inputs ?? []).find(p => p.pid === pid);
  if (!target) return;

  const oldName = target.name;
  const tType   = target.type;
  if (oldName === newName) return;

  setFunctions(prev => {
    const mapped = prev.map(fn => {
      const existsCollision = (fn.inputs ?? []).some(p => p.name === newName);
      const inputs = (fn.inputs ?? []).map(p =>
        (p.name === oldName && p.type === tType && !existsCollision) ? { ...p, name: newName } : p
      );
      return { ...fn, inputs };
    });
    return reflectInputsEverywhere(mapped);
  });
}


  function setParamMandatory(pid: string, val: boolean) {
  if (!selectedId) return;
  setFunctions(prev => {
    const mapped = prev.map(f => {
      if (f.id !== selectedId) return f;
      const inputs = (f.inputs ?? []).map(p => (p.pid === pid ? { ...p, mandatory: val } : p));
      return { ...f, inputs };
    });
    return reflectInputsEverywhere(mapped);
  });
}

  function setParamType(pid: string, t: UiType) {
  if (!selectedId) return;
  setFunctions(prev => {
    const mapped = prev.map(f => {
      if (f.id !== selectedId) return f;
      const inputs = (f.inputs ?? []).map(p => (p.pid === pid ? { ...p, type: asUi(t) } : p));
      return { ...f, inputs };
    });
    return reflectInputsEverywhere(mapped);
  });
}


  function sameNameAndType(a: PsParam, b: PsParam) {
  return a.name === b.name && a.type === b.type;
}
  function setParamSource(pid: string, s: SourceType) {
  const currentSel = functions.find(f => f.id === selectedId);
  if (!currentSel) return;
  const target = (currentSel.inputs ?? []).find(p => p.pid === pid);
  if (!target) return;

  const { name: targetName, type: targetType } = target;

  setFunctions(prev => {
    const mapped = prev.map(fn => {
      const inputs = (fn.inputs ?? []).map(p =>
        (p.name === targetName && p.type === targetType) ? { ...p, source: s } : p
      );
      return { ...fn, inputs };
    });
    return reflectInputsEverywhere(mapped);
  });
}



  function detectKeyForFn(fnName: string, schema: any): string | null {
    if (!schema?.entities) return null;
    const m = String(fnName || "").match(/^([A-Za-z_]+)-(.+)$/);
    if (!m) return null;
    const verb = canonicalVerb(m[1]);
    const raw = m[2];
    const entity = verb === "Get" && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    const ent = (schema.entities as any[]).find(
      (e) => (e?.name || "").toLowerCase() === entity.toLowerCase()
    );
    if (!ent) return null;

    const attrs = Array.isArray(ent.attributes) ? ent.attributes : [];
    return (
      attrs.find((a: any) => !!a?.IsKey)?.name ||
      attrs.find((a: any) => /^id$/i.test(a.name))?.name ||
      attrs.find((a: any) => /id$/i.test(a.name))?.name ||
      attrs[0]?.name || null
    );
  }

  function buildParamBlockFromInputs(inputs: PsParam[] = [], keyName?: string | null): string {
    if (!inputs.length) return "param()\n    # NOTE: This function currently has no parameters";

    const lines = inputs.map((p, idx) => {
      const attrs = p.mandatory
        ? "[Parameter(Mandatory=$true, ValueFromPipelineByPropertyName = $true)] [ValidateNotNullOrEmpty()]"
        : "[Parameter(Mandatory=$false, ValueFromPipelineByPropertyName = $true)]";
      const comma = idx === inputs.length - 1 ? "" : ",";
      const keyTag = keyName && p.name === keyName ? " # Key" : "";
      return `        ${attrs} ${psType(p.type)} $${p.name}${comma} # Source: ${p.source}${keyTag}`;
    });

    return `param(\n${lines.join("\n")}\n    )`;
  }

  function findMatching(text: string, openIdx: number, openChar: string, closeChar: string): number {
    let depth = 0;
    let inS = false,
      inD = false,
      esc = false;
    for (let i = openIdx; i < text.length; i++) {
      const ch = text[i];

      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "`") {
        esc = true;
        continue;
      }

      if (inS) {
        if (ch === "'") inS = false;
        continue;
      }
      if (inD) {
        if (ch === '"') inD = false;
        continue;
      }
      if (ch === "'") {
        inS = true;
        continue;
      }
      if (ch === '"') {
        inD = true;
        continue;
      }

      if (ch === openChar) depth++;
      else if (ch === closeChar) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function normalizeParamBlock(block: string) {
    return block.replace(/^\s+|\s+$/g, "");
  }
  function withSingleBlank(before: string, block: string, after: string, indent = "") {
    const b = before.replace(/\s+$/g, "");
    const a = after.replace(/^\s+/g, "");
    const indented = block
      .split("\n")
      .map((l) => (l.length ? indent + l : indent))
      .join("\n");
    return `${b}\n${indented}\n${a}`;
  }

  function upsertParamBlockInScript(script: string, fnName: string, paramBlockRaw: string): string {
    if (!script?.trim()) return script;
    const paramBlock = normalizeParamBlock(paramBlockRaw);

    const fnRe = new RegExp(
      String.raw`function\s+(?:global:)?${fnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*\{`,
      "i"
    );
    const mFn = script.match(fnRe);
    if (mFn && typeof mFn.index === "number") {
      const openCurlyIdx = mFn.index + mFn[0].length - 1;
      const closeCurlyIdx = findMatching(script, openCurlyIdx, "{", "}");
      if (closeCurlyIdx >= 0) {
        const bodyStart = openCurlyIdx + 1;
        const bodyEnd = closeCurlyIdx;

        const head = script.slice(0, bodyStart);
        const body = script.slice(bodyStart, bodyEnd);
        const tail = script.slice(bodyEnd);

        const bodyIndent = (body.match(/^[ \t]*/m) || ["    "])[0] || "    ";

        const mParam = body.match(/(^|\s)param\s*\(/i);
        if (mParam && typeof mParam.index === "number") {
          const tokenStart = mParam.index + (mParam[1] ? mParam[1].length : 0);
          const lp = body.indexOf("(", tokenStart);
          if (lp >= 0) {
            const rp = findMatching(body, lp, "(", ")");
            if (rp >= 0) {
              const left = body.slice(0, tokenStart);
              const right = body.slice(rp + 1);
              const merged = withSingleBlank(left, paramBlock, right, bodyIndent);
              return `${head}${merged}${tail}`;
            }
          }
        }

        const mBind = body.match(/\[CmdletBinding\(\)\]\s*/i);
        if (mBind && typeof mBind.index === "number") {
          const bindEnd = mBind.index + mBind[0].length;
          const left = body.slice(0, bindEnd);
          const right = body.slice(bindEnd);
          const merged = withSingleBlank(left, paramBlock, right, bodyIndent);
          return `${head}${merged}${tail}`;
        }

        const merged = withSingleBlank("", paramBlock, body, bodyIndent);
        return `${head}${merged}${tail}`;
      }
    }
    return script;
  }
/** Rebuild selected function’s connection params from the current dropdown selection,
 *  preserving any user edits on existing connection params (e.g., Mandatory).
 *  Then rewrite its param(...) and refresh ps.methods/globals/XML.
 */
function rebaseSelectedFunctionConnParams() {
  if (!selectedId) return;

  setFunctions(prev => {
    const freshConn = connParamsForSelection(); // built from (connFamily, sqlMode, restAuth, soapMode, scimAuth, security)

    const mapped = prev.map(fn => {
      if (fn.id !== selectedId) return fn;

      const current = fn.inputs ?? [];
      const nonConn = current.filter(p => p.source !== "Connection");
      const oldConnMap = new Map(
        current.filter(p => p.source === "Connection").map(p => [p.name, p])
      );

      // merge: fresh set wins, but keep Mandatory/Type if user changed it
      const mergedConn = freshConn.map(cp => {
        const old = oldConnMap.get(cp.name);
        return old
          ? { ...cp, pid: old.pid, mandatory: old.mandatory, type: old.type }
          : cp;
      });

      return { ...fn, inputs: [...nonConn, ...mergedConn] };
    });

    // rewrite scripts + sync storage + rebuild XML
    return reflectInputsEverywhere(mapped);
  });
}

  useEffect(() => {
  // If you were in Upload-PW mode, get out
  

  // Always keep globals + XML in sync (what you already do)
  

  // When the Parameter editor is enabled, actually push the new conn template
  // into the **selected function**, and reflect in script/XML.
  if (paramsEnabled && selectedId) {
    if (isUploadMode()) exitUploadMode();
    rebaseSelectedFunctionConnParams();
  } else {
    // still refresh XML so ConnectionParameters and Get-Authorization stay correct
    rebuildXmlPreview();
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [connFamily, sqlMode, restAuth, soapMode, scimAuth, security, selectedId, paramsEnabled]);
 


  // Always reflect dropdown changes in XML/globals (independent of the on/off toggle)
useEffect(() => {
   
  writeConnectionGlobalsFromSelection(); // step 0
  rebuildXmlPreview();                   // will prune + reinsert
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [connFamily, sqlMode, restAuth, soapMode, scimAuth, security]);

/** Build the SQL/default connection params list once based on current dropdowns */
function buildDefaultConnParams(): PsParam[] {
  // Always “SQL / Discrete / None” defaults on reload.
  // If you want it to obey the current state, change the literals below to use state.
  const defaults: PsParam[] = [
    makeParam({ name: "Server",   type: "String",  mandatory: true,  source: "Connection" }),
    makeParam({ name: "Port",     type: "Int",     mandatory: false, source: "Connection" }),
    makeParam({ name: "Database", type: "String",  mandatory: true,  source: "Connection" }),
    makeParam({ name: "UserName", type: "String",  mandatory: true,  source: "Connection" }),
    makeParam({ name: "Password", type: "String",  mandatory: true,  source: "Connection" }),
  ];
  return defaults;
}


function getGlobals() {
  return JSON.parse(
    localStorage.getItem("globals.details.v2") ||
    localStorage.getItem("globals.details") ||
    "[]"
  ) || [];
}

function rebuildConnectionParameters(xmlIn: string): string {
  const g = getGlobals();
  if (!g.length) return xmlIn;

  const block = [
    "<ConnectionParameters>",
    ...g.map((x: { name: any; description: any; secure: any; sensitive: any; }) => {
      const nm = String(x?.name || "").trim();
      const desc = (x?.description || nm).replace(/"/g, "&quot;");
      const sens = (x?.secure || x?.sensitive || /password|token|secret/i.test(nm)) ? ' IsSensibleData="true"' : "";
      return `  <ConnectionParameter Description="${desc}" Name="${nm}"${sens}/>`;
    }),
    "</ConnectionParameters>",
  ].join("\n");

  let xml = xmlIn || "";
  if (/<ConnectionParameters>[\s\S]*?<\/ConnectionParameters>/i.test(xml)) {
    return xml.replace(/<ConnectionParameters>[\s\S]*?<\/ConnectionParameters>/i, block);
  }
  if (/<Initialization>/i.test(xml)) {
    return xml.replace(/<Initialization>/i, `${block}\n<Initialization>`);
  }
  if (/<Connector\b[^>]*>/i.test(xml)) {
    return xml.replace(/(<Connector\b[^>]*>)/i, `$1\n${block}\n`);
  }
  return `${block}\n${xml}`;
}

/** Rebuild the Get-Authorization custom command’s CDATA from current globals. */
function rebuildGetAuthorization(xmlIn: string): string {
  const g = JSON.parse(
    localStorage.getItem("globals.details.v2") ||
      localStorage.getItem("globals.details") ||
      "[]"
  ) as Array<{ name?: string; type?: string; secure?: boolean; sensitive?: boolean }>;
  if (!Array.isArray(g) || g.length === 0) return xmlIn || "";

  const typeOf = (t?: string) =>
    /int/i.test(String(t)) ? "[int]" :
    /bool/i.test(String(t)) ? "[bool]" :
    /date/i.test(String(t)) ? "[datetime]" :
    "[string]";

  const paramLines = g.map((x, i) => {
    const nm = String(x?.name || "").trim();
    const comma = i === g.length - 1 ? "" : ",";
    return `  [Parameter(Mandatory=$false,ValueFromPipelineByPropertyName=$true)] ${typeOf(x?.type)} $${nm}${comma}`;
  });

  const assignLines = g.map(x => {
    const nm = String(x?.name || "").trim();
    return `if ($PSBoundParameters.ContainsKey('${nm}')) { $global:${nm} = $${nm} ; }`;
  });

  const cdata = ["<![CDATA[","param(",...paramLines,")",...assignLines,"]]>"].join("\n");

  // Upsert the CDATA inside the Get-Authorization custom command
  return (xmlIn || "").replace(
    /(<CustomCommand\b[^>]*\bName\s*=\s*["']Get-Authorization["'][^>]*>\s*)(?:<!\[CDATA\[[\s\S]*?\]\]>)?([\s\S]*?)(<\/CustomCommand>)/i,
    (_m, open, _inner, close) => `${open}${cdata}${close}`
  );
}

/** remove every connection-origin SetParameter anywhere in the XML */
function pruneAllConnectionSetParams(xmlIn: string): string {
  let xml = xmlIn || "";

  // self-closing SetParameter with Source=ConnectionParameter (or older "Connection")
  xml = xml.replace(
    /<SetParameter\b[^>]*\bSource\s*=\s*"(?:ConnectionParameter|Connection)"[^>]*\/>\s*/gi,
    ""
  );

  // collapse extra blank lines left behind
  xml = xml.replace(/\n\s*\n\s*\n+/g, "\n\n");
  return xml;
}

  /** On first load: add SQL (current dropdown selection) connection params to ALL functions */
function seedConnectionParamsForAll() {
  setFunctions(prev =>
    prev.map(f => {
      const current  = f.inputs ?? [];
      const nonConn  = current.filter(p => p.source !== "Connection");
      const freshConn = connParamsForSelection(); // uses current defaults (SQL etc.)

      // de-dupe: keep user non-connection first, then add any missing connection params
      const finalList = [...nonConn];
      for (const cp of freshConn) {
        if (!finalList.some(x => x.name === cp.name)) finalList.push(cp);
      }
      return { ...f, inputs: finalList };
    })
  );
}
const seededOnLoad = useRef(false);
useEffect(() => {
   if (isUploadMode()) return;
  if (seededOnLoad.current) return;
  if (!functions.length)    return; // wait until functions exist

  if (!hasAnyConnParams(functions)) {
    const next = seedConnectionParamsForAllNow(functions);
    setFunctions(next);
  }

  seededOnLoad.current = true;
}, [functions]);


  function confirmAdd() {
    const name = newName.trim();
    if (!name) return;
    if (!isValidPsFn(name)) {
      alert('Use PowerShell Verb-Noun (e.g., "Get-Users").');
      return;
    }
    if (nameExists(name)) {
      alert(`"${name}" already exists.`);
      return;
    }
    const fn = makeNewFn(name);
    setFunctions((prev) => [fn, ...prev]);
    setSelectedId(fn.id);
    setNewName("");
    setAdding(false);
  }

  function openFn(fn: Fn) {
    setSelectedId(fn.id);

    if (!fn.script?.trim() && lastSchema) {
      const stub = buildPsStub(fn.name, lastSchema);
      const params = buildStubParams(fn.name, lastSchema);
      if (stub) {
        setFunctions((prev) =>
          prev.map((f) =>
            f.id === fn.id
              ? {
                  ...f,
                  script: stub,
                  inputs: f.inputs?.length ? f.inputs : params,
                }
              : f
          )
        );
      }
    }
  }

  function removeFunction(id: string) {
    setFunctions((prev) => prev.filter((f) => f.id !== id));
    setSelectedId((prev) => (prev === id ? null : prev));
  }

  function updateSelected(partial: Partial<Fn>) {
    setFunctions((prev) => prev.map((f) => (f.id === selectedId ? { ...f, ...partial } : f)));
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text || "");
    } catch {
      /* ignore */
    }
  }

  const [pendingDelete, setPendingDelete] = useState<Fn | null>(null);
  function confirmDelete(fn: Fn) {
    setPendingDelete(fn);
  }
  function cancelDelete() {
    setPendingDelete(null);
  }
  function doDelete() {
    if (!pendingDelete) return;
    removeFunction(pendingDelete.id);
    setPendingDelete(null);
  }
  // NLog.dll path (saved in localStorage)
const DEFAULT_NLOG = "C:\\Program Files\\One Identity\\One Identity Manager\\NLog.dll";

const [nlogPath, setNlogPath] = useState<string>(DEFAULT_NLOG);

// read after mount (browser only)
useEffect(() => {
  try {
    const saved = window.localStorage?.getItem("nlog.path");
    if (saved) setNlogPath(saved);
  } catch {}
}, []);

// write changes (browser only)
useEffect(() => {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("nlog.path", nlogPath || "");
    }
  } catch {
    // ignore if storage is unavailable (private mode, quota, etc.)
  }
}, [nlogPath]);


function psSingleQuoted(s: string) {
  return `'${String(s || "").replace(/'/g, "''")}'`;
}
  /** -------------- logger block -------------- */
 /** -------------- logger block -------------- */
function buildLoggerBlock(nlog: string) {
  const dll = psSingleQuoted(nlog);
  return [
    "#Logger code starting here.",
    `Add-Type -Path ${dll}`,
    "",
    "function global:Get-FunctionName ([int]$StackNumber = 1) {return [string]$(Get-PSCallStack)[$StackNumber].FunctionName}",
    "",
    "function global:Get-Logger() {",
    "\tparam ([parameter(mandatory=$false)] [System.String]$Object ) ",
    "\t$method = Get-FunctionName -StackNumber 2",
    "",
    "\t$logCfg\t\t\t\t\t= Get-NewLogConfig",
    "\t$debugLog \t\t\t\t= Get-NewLogTarget -targetType \"file\"",
    "\t$debugLog.archiveEvery \t\t= \"Day\"",
    "\t$debugLog.ArchiveNumbering \t= \"Rolling\"\t",
    "\t$debugLog.CreateDirs\t\t= $true\t",
    "\t$debugLog.FileName \t\t= "+ dll.replace("NLog.dll","debugLog.log"),
    "\t#$debugLog.Encoding \t\t\t= [System.Text.Encoding]::GetEncoding(\"utf-8\")",
    "\t$debugLog.KeepFileOpen \t\t= $false",
    "\t$debugLog.Layout \t\t\t= Get-LogMessageLayout -layoutId 3 -method $method -Object $Object",
    "\t$debugLog.maxArchiveFiles \t= 31",
    "    $debugLog.archiveFileName   = "+dll.replace("NLog.dll","Debug.{#}.log"),
    "\t$logCfg.AddTarget(\"file\", $debugLog)",
    "\t",
    "\t$console \t\t\t\t\t= Get-NewLogTarget -targetType \"console\"",
    "\t$console.Layout \t\t\t= Get-LogMessageLayout -layoutId 3 -method $method -Object $Object",
    "\t$logCfg.AddTarget(\"console\", $console)",
    "\t",
    "\tIf ($NLogLevel -eq \"Trace\") { ",
    "\t\t$rule1 = New-Object NLog.Config.LoggingRule(\"Logger\", [NLog.LogLevel]::Trace, $debugLog)",
    "\t    $logCfg.LoggingRules.Add($rule1)",
    "    }else",
    "    { ",
    "        $rule1 = New-Object NLog.Config.LoggingRule(\"Logger\", [NLog.LogLevel]::Info, $console)",
    "\t    $logCfg.LoggingRules.Add($rule1)",
    "    }",
    "\t",
    "\t$rule2 = New-Object NLog.Config.LoggingRule(\"Logger\", [NLog.LogLevel]::Info, $debugLog)",
    "\t$logCfg.LoggingRules.Add($rule2)",
    "    ",
    "    If ($NLogLevel -eq \"Debug\") { ",
    "\t    $rule3 = New-Object NLog.Config.LoggingRule(\"Logger\", [NLog.LogLevel]::Debug, $debugLog)",
    "\t    $logCfg.LoggingRules.Add($rule3)",
    "    }",
    "\t",
    "\t[NLog.LogManager]::Configuration = $logCfg",
    "",
    "\t$Log = Get-NewLogger -loggerName \"Logger\"",
    "    ",
    "    return $Log",
    "}",
    "",
    "function global:Get-NewLogger() {",
    "    param ( [parameter(mandatory=$true)] [System.String]$loggerName ) ",
    "    [NLog.LogManager]::GetLogger($loggerName) ",
    "}",
    "",
    "function global:Get-NewLogConfig() { New-Object NLog.Config.LoggingConfiguration }",
    "",
    "function global:Get-NewLogTarget() {",
    "\tparam ( [parameter(mandatory=$true)] [System.String]$targetType ) ",
    "\tswitch ($targetType) {",
    "\t\t\"console\" { New-Object NLog.Targets.ColoredConsoleTarget }",
    "\t\t\"file\"    { New-Object NLog.Targets.FileTarget }",
    "\t\t\"mail\"    { New-Object NLog.Targets.MailTarget }",
    "\t}",
    "}",
    "",
    "function global:Get-LogMessageLayout() {",
    "\tparam ( ",
    "        [parameter(mandatory=$true)] [System.Int32]$layoutId,",
    "        [parameter(mandatory=$false)] [String]$method,",
    "\t\t[parameter(mandatory=$false)] [String]$Object",
    "    ) ",
    "\tswitch ($layoutId) {",
    "\t\t1 { $layout = '${longdate} | ${machinename} | ${processid} | ${processname} | ${level} | ${logger} | ${message}' }",
    "\t\t2 { $layout = '${longdate} | ${machinename} | ${processid} | ${processname} | ${level} | ${logger} | ${message}' }",
    "        3 { $layout = '${longdate} [${level}] (${processid}) ' + $($method) +' | '  + $($Object) +' ${message}' }",
    "\t}",
    "\treturn $layout",
    "}",
  ].join("\n");
}


  function cleanFn(ps?: string) {
    const t = (ps || "").trim();
    if (!t) return "";
    return /^function\s/i.test(t) ? t : t;
  }

  function extractPester(text?: string): string[] {
    const src = text || "";
    const out: string[] = [];
    const re = /(^|\s)Describe\s+['"][\s\S]*?\{[\s\S]*?\}\s*$/gmi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push(m[0].trim());
    return out;
  }

  function buildCombinedPs(allFns: Fn[]): string {
    const fnParts = allFns.map((f) => cleanFn(f.script)).filter(Boolean);

    const tests = allFns.flatMap((f) => {
      const fromConvo = extractPester(f.convo);
      return fromConvo.length ? fromConvo : extractPester(f.script);
    });

    const pieces = [
      fnParts.join("\n\n"),
      "",
      buildLoggerBlock(nlogPath),
      "",
      tests.length ? "# Tests\n" + tests.join("\n\n") : "# Tests\n# (none found)",
    ];

    return pieces.join("\n\n");
  }

  function downloadTextFile(filename: string, contents: string) {
    const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function openPreviewBlob(contents: string, title = "preview.ps1") {
    const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  const handleUploadPerfectJsonClick = () => jsonInputRef.current?.click();
  const handleUploadPerfectJsonChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const raw = await file.text();
      const stripF = (s: string) => {
        const t = String(s || "").trim();
        const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        return (m ? m[1] : t).trim();
      };
      const cleaned = stripF(raw);

      let data: any = null;
      try {
        data = JSON.parse(cleaned);
      } catch {
        const m = cleaned.match(/\{[\s\S]*\}$/);
        if (m) {
          try {
            data = JSON.parse(m[0]);
          } catch {}
        }
      }
      if (!data) {
        alert("Could not parse JSON.");
        return;
      }

      if (Array.isArray(data.entities)) {
        const schema = data as { entities: SchemaEntity[] };

        const generated = fnsFromSchema(schema).map((fn) => ({
          ...fn,
          inputs: buildStubParams(fn.name, schema),
          script: buildPsStub(fn.name, schema) ?? "",
        }));

        const seeded = seedConnectionParamsForAllNow(generated);
        setFunctions(seeded);
        setSelectedId(seeded[0]?.id ?? null);
        setLastSchema(schema);

        seedConfirmedTables(schema);
        const saved = seedSavedMappings(schema, generated);
        seedPropMetaWithRBs(schema);
        syncPsMethodsFromFns(seeded);
        writeConnectionGlobalsFromFunctions(seeded);
        seedBindingsV3(schema, seeded, saved);

        setXmlLive(buildXmlAllConfirmedFromLocalStorage().xml);
        return;
      }

      const toFn = (d: any, i = 0): Fn => ({
        id: d?.id ?? globalThis.crypto?.randomUUID?.() ?? `fn_${i}`,
        name: String(d?.name ?? d?.functionName ?? `Function_${i}`),
        script: String(d?.script ?? d?.code ?? ""),
        convo: String(d?.convo ?? d?.response ?? ""),
        chat: String(d?.chat ?? d?.prompt ?? ""),
        xmlPreview: String(d?.xmlPreview ?? d?.xml ?? ""),
        inputs: Array.isArray(d?.inputs)
          ? d.inputs.map((p: any) => ({
              pid:
                p?.pid ??
                globalThis.crypto?.randomUUID?.() ??
                `p_${Math.random().toString(36).slice(2)}`,
              name: String(p?.name ?? ""),
              type: ui(p?.type),
              mandatory: !!p?.mandatory,
              source: (p?.source ?? "Schema") as SourceType,
            }))
          : [],
      });

      const arr = Array.isArray(data) ? data : [data];
      let fns: Fn[] = arr.map(toFn);
      
      const seen = new Set<string>();
      fns = fns.map((f) => {
        let name = (f.name || "Function").trim() || "Function";
        if (seen.has(name)) {
          let i = 2;
          while (seen.has(`${name} (${i})`)) i++;
          name = `${name} (${i})`;
        }
        seen.add(name);
        return { ...f, name };
      });

      const seeded = seedConnectionParamsForAllNow(fns);
      setFunctions(seeded);
      setSelectedId(seeded[0]?.id ?? null);

    } catch {
      alert("Failed to read or parse the file.");
    } finally {
      e.target.value = "";
    }
  };
/** Return all PowerShell function blocks found in `text` (name + full body). */
function extractAllFunctions(text: string): Array<{ name: string; code: string }> {
  const src = stripFences(text || "");
  const out: Array<{ name: string; code: string }> = [];
  const re = /function\s+(?:global:)?([A-Za-z_][A-Za-z0-9_-]*)\s*\{/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1];
    const openIdx = m.index + m[0].length - 1; // position of "{"
    const closeIdx = findMatching(src, openIdx, "{", "}");
    if (closeIdx > openIdx) {
      const code = src.slice(m.index, closeIdx + 1).trim();
      out.push({ name, code });
      // continue scanning after this function
      re.lastIndex = closeIdx + 1;
    }
  }
  return out;
}
const updateFunctionFromChat = useCallback(() => {
  if (!selected) return;
  const raw = (selected.convo || "").trim();
  if (!raw) {
    alert("No chat response to apply.");
    return;
  }

  // reuse your existing helpers already in this file:
  const all = extractAllFunctions(raw); // returns [{ name, code }, ...]
  if (!all.length) {
    alert("No PowerShell function found in the chat response.");
    return;
  }

  const chosen = pickFunctionForSelected(all, selected.name) || all[0];
  if (!chosen?.code) {
    alert("Couldn’t find a matching function to update.");
    return;
  }

  // update ONLY the function script; do not touch tests / description
  setFunctions(prev =>
    prev.map(f =>
      f.id === selected.id ? { ...f, script: chosen.code } : f
    )
  );
}, [selected, setFunctions]);

/** Pick the “best” function for the current selection. */
function pickFunctionForSelected(all: Array<{ name: string; code: string }>, selectedName: string) {
  if (!all.length) return null;
  // 1) exact (case-insensitive) name match
  const exact = all.find(f => f.name.toLowerCase() === selectedName.toLowerCase());
  if (exact) return exact;
  // 2) single function → obvious choice
  if (all.length === 1) return all[0];
  // 3) heuristic: prefer one whose name shares the noun of Verb-Noun
  const noun = (selectedName.split("-")[1] || "").toLowerCase();
  if (noun) {
    const byNoun = all.find(f => (f.name.split("-")[1] || "").toLowerCase() === noun);
    if (byNoun) return byNoun;
  }
  // 4) fallback: first one
  return all[0];
}

  /** Rewrite each function's script param(...) from its current inputs */
function applyInputsToScripts(list: Fn[]): Fn[] {
  return list.map(f => {
    const keyName = detectKeyForFn(f.name, lastSchema);
    const block   = buildParamBlockFromInputs(f.inputs ?? [], keyName);
    const next    = upsertParamBlockInScript(f.script || "", f.name, block);
    return next !== f.script ? { ...f, script: next } : f;
  });
}
function seedConnectionParamsForAllNow(list: Fn[]): Fn[] {
  const fresh = buildDefaultConnParams();

  // 1) add connection params (dedupe by name)
  const withInputs = list.map(f => {
    const current  = f.inputs ?? [];
    const nonConn  = current.filter(p => p.source !== "Connection");
    const final    = [...nonConn];
    for (const cp of fresh) {
      if (!final.some(x => x.name === cp.name)) final.push(cp);
    }
    return { ...f, inputs: final };
  });

  // 2) rewrite param(...) blocks in scripts to match inputs
  const withScripts = applyInputsToScripts(withInputs);

  // 3) reflect globals + ps.methods + XML immediately
  writeConnectionGlobalsFromFunctions(withScripts);
  syncPsMethodsFromFns(withScripts);
  rebuildXmlPreview();

  return withScripts;
}
function dedupeSetParametersEverywhere(xmlIn: string): string {
  let xml = xmlIn || "";
  const uniq = (block: string) => {
    const lines = [...block.matchAll(/<SetParameter\b[^>]*\/>/gi)].map(m => m[0]);
    if (!lines.length) return block;
    const by = new Map<string, string>();
    for (const ln of lines) {
      const key = (ln.match(/\bParam="([^"]+)"/i)?.[1] || ln).toLowerCase();
      if (!by.has(key)) by.set(key, ln);
    }
    const stripped = block.replace(/<SetParameter\b[^>]*\/>\s*/gi, "");
    const head = [...by.values()].join("\n");
    const tail = stripped.trim();
    return head + (tail ? "\n" + tail : "");
  };

  xml = xml.replace(
    /<ListingCommand\b([^>]*)>([\s\S]*?)<\/ListingCommand>/gi,
    (_w, a: string, inner: string) => `<ListingCommand${a}>${uniq(inner)}</ListingCommand>`
  );

  xml = xml.replace(
    /<Item\b([^>]*)>([\s\S]*?)<\/Item>/gi,
    (_w, a: string, inner: string) => `<Item${a}>${uniq(inner)}</Item>`
  );

  return xml;
}

/** Quick check: do we already have any connection params? */
function hasAnyConnParams(list: Fn[]): boolean {
  return list.some(f => (f.inputs || []).some(p => p.source === "Connection"));
}
  const handleUploadPwClick = () => pwInputRef.current?.click();
  // put both of these inside your WorkbenchPage component

/** Centralized handler used by the file-input change event. */
const handleUploadPwChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  // allow re-selecting the same file next time
  e.target.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    let imported = parsePsFileToFns(text);

    if (!imported.length) {
      alert("No PowerShell functions were found in the file.");
      return;
    }

    // de-dupe names (Get-Users, Get-Users (2), …)
    const seen = new Set<string>();
    imported = imported.map((fn) => {
      let name = (fn.name || "Function").trim() || "Function";
      if (seen.has(name)) {
        let i = 2;
        while (seen.has(`${name} (${i})`)) i++;
        name = `${name} (${i})`;
      }
      seen.add(name);
      return { ...fn, name };
    });

    await handleUploadPw(imported);
  } catch (err) {
    console.error(err);
    alert("Failed to read or parse the PowerShell file.");
  }
};


function isGlobalFunction(fn: { name?: string; script?: string }) {
  const name = String(fn?.name || "").trim();
  if (!name || !fn?.script) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // require explicit "function global:Name"
  const re = new RegExp(`\\bfunction\\s+global:\\s*${esc}\\b`, "i");
  return re.test(fn.script);
}
function makeAllParamsManualForNonGlobals<T extends {
  name: string;
  script?: string;
  inputs?: { pid?: string; name: string; type?: any; mandatory?: boolean; source?: string }[];
}>(fns: T[]): T[] {
  return fns.map(fn => {
    if (isGlobalFunction(fn)) return fn; // leave globals untouched
    const inputs = (fn.inputs || []).map(p =>
      (p.source === "Manual")
        ? p
        : { ...p, source: "Manual" as const }
    );
    return { ...fn, inputs };
  });
}

function forceUpsertConnectionParameters(
  xmlIn: string,
  fromFns: { name: string; script?: string; inputs?: { name: string; source?: string }[] }[]
): string {
  const source = fromFns.filter(isGlobalFunction);  // <— enforce here too
  const maybeSensitive = /password|token|secret|bearer/i;
  const seen = new Map<string, { name: string; secure: boolean }>();

  for (const fn of source) {
    for (const p of fn.inputs || []) {
      if (String(p.source) !== "Connection") continue;
      const nm = String(p.name || "").trim();
      if (!nm || seen.has(nm)) continue;
      seen.set(nm, { name: nm, secure: maybeSensitive.test(nm) });
    }
  }
  const items = [...seen.values()];

  // 2) if none, don’t touch existing XML
  if (!items.length) return xmlIn || "";

  // 3) build the block
  const block =
    "<ConnectionParameters>\n" +
    items
      .map(({ name, secure }) =>
        `  <ConnectionParameter Description="${name}" Name="${name}"${
          secure ? ' IsSensibleData="true"' : ""
        }/>`
      )
      .join("\n") +
    "\n</ConnectionParameters>";

  // 4) replace or insert the block
  let xml = xmlIn || "";
  if (/<ConnectionParameters>[\s\S]*?<\/ConnectionParameters>/i.test(xml)) {
    xml = xml.replace(/<ConnectionParameters>[\s\S]*?<\/ConnectionParameters>/i, block);
  } else if (/<Initialization>/i.test(xml)) {
    xml = xml.replace(/<Initialization>/i, `${block}\n<Initialization>`);
  } else if (/<Connector\b[^>]*>/i.test(xml)) {
    xml = xml.replace(/(<Connector\b[^>]*>)/i, `$1\n${block}\n`);
  } else {
    xml = `${block}\n${xml}`;
  }
  return xml;
}

/**
 * Builds the final XML for an uploaded .ps1 using the uploadPwxml library.
 * – Figures out schema
 * – Gets current base XML (or falls back to builder output)
 * – Lets uploadPwxml apply connection-param logic, PredefinedCommands, RC/Method SetParameters, etc.
 * – Updates functions list, selection, and xml preview
 */
const handleUploadPw = async (importedFns: Fn[]) => {
  skipNextNormalXmlBuild.current = true;
  isPwUpload.current = true;

  const ents = JSON.parse(localStorage.getItem("schema.entities") || "[]");
  const schema = { entities: ents as any[] };

  // Your existing classification
  importedFns = classifyParamsForUpload(importedFns, schema);

  // ⬇️ NEW: every param of non-global functions becomes Manual
  importedFns = makeAllParamsManualForNonGlobals(importedFns);

  // Only globals can define connection parameters/globals
  const globalFns = importedFns.filter(isGlobalFunction);

  // Show in UI
  setFunctions(importedFns);
  setSelectedId(importedFns[0]?.id ?? null);

  // Build XML from upload flow
  let x = buildXmlFromUploadPw(importedFns, schema);

  // ⬇️ Only globals upsert <ConnectionParameters>
  x = forceUpsertConnectionParameters(x, globalFns);

  // Keep ps.methods for editor features (all functions)
  syncPsMethodsFromFns(importedFns);

  // ⬇️ Only globals write connection globals
  writeConnectionGlobalsFromFunctions(globalFns);

  // Rebuild Get-Authorization from the (now global-only) globals
  x = rebuildGetAuthorization(x);

  // Tidy
  x = sweepDedupeReadConfigurations(x);

  setXmlLive(prettyXml(x));
  startUploadMode();
};





// your existing effect should skip once just after Upload pw:
useEffect(() => {
  if (!functions.length) return;
  if (isPwUpload.current) { isPwUpload.current = false; return; }

  if (skipNextNormalXmlBuild.current) {
    skipNextNormalXmlBuild.current = false; // consume the skip
    return;
  }
  // normal (non-upload) behavior here…
  const ents = JSON.parse(localStorage.getItem("schema.entities") || "[]");
  if (!ents?.length) return;
  const schema = { entities: ents };
  syncPsMethodsFromFns(functions);
  const saved = seedSavedMappings(schema, functions);
  if (!localStorage.getItem("prop.meta.v1")) seedPropMetaWithRBs(schema);
  writeConnectionGlobalsFromFunctions(functions);
  seedBindingsV3(schema, functions, saved);
  rebuildXmlPreview();
}, [functions]);

  const handlePreviewPw = () => {
    const contents = buildCombinedPs(functions);
    openPreviewBlob(contents, "combined.ps1");
  };

  const handleDownloadPw = () => {
    const contents = buildCombinedPs(functions);
    const safe = "AllFunctions.ps1";
    downloadTextFile(safe, contents);
  };

  const handleDownloadXML = () => {
    const text = (xmlPretty || xmlLive || "").trim();
    if (!text) return;
    const blob = new Blob([text], { type: "application/xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Connector.xml";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
// Types the result your /api/ai/result returns.
// Adjust fields if your backend uses different names.
type AiJobResult = {
  ok?: boolean;
  result?: string;        // model output (function, text, etc.)
  tests?: string;         // optional
  description?: string;   // optional
  [k: string]: unknown;
};

/** Small helper: wait */
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Poll /api/ai/result?id=... until the job is ready.
 * - Treats HTTP 202 as "still running"
 * - Tries to parse JSON; if not JSON, returns { result: rawText }
 * - Throws on non-2xx (except 202)
 *
 * @param id          Job id returned by /api/ai/submit
 * @param opts.maxMs  Optional total timeout (ms). Defaults to no hard cap.
 * @param opts.signal Optional AbortSignal for cancellation.
 */
 async function pollAiResult(
  id: string,
  opts: { maxMs?: number; signal?: AbortSignal } = {}
): Promise<AiJobResult> {
  if (!id) throw new Error("pollAiResult: missing id");

  // backoff sequence (you can tweak these)
  const waits = [1500, 2000, 2500, 3000, 4000, 5000, 7000, 9000];

  const start = Date.now();
  let attempt = 0;

  while (true) {
    // Honor caller abort/timeout
    if (opts.signal?.aborted) throw new Error("Polling aborted");
    if (opts.maxMs && Date.now() - start > opts.maxMs) {
      throw new Error("Polling timed out");
    }

    const res = await fetch(`/api/ai/result?id=${encodeURIComponent(id)}`, {
      method: "GET",
      signal: opts.signal,
      headers: { "Accept": "application/json,text/plain;q=0.9,*/*;q=0.8" },
    });

    // 202 = not ready yet
    if (res.status === 202) {
      const wait = waits[Math.min(attempt, waits.length - 1)];
      attempt++;
      await sleep(wait);
      continue;
    }

    const text = await res.text();

    if (!res.ok) {
      // surface any error text from server
      throw new Error(text || `Result error (${res.status})`);
    }

    // Try to parse JSON; if it fails, return raw as { result }
    try {
      const json = JSON.parse(text) as AiJobResult;
      return json;
    } catch {
      return { result: text };
    }
  }
}

function getSchemaPretty(): string {
  // prefer lastSchema, fall back to localStorage
  try {
    const ents = JSON.parse(localStorage.getItem("schema.entities") || "[]");
    const schema = (ents?.length ? { entities: ents } : null) as any;
    return JSON.stringify(schema, null, 2);
  } catch {
    return "null";
  }
}

function buildSpecForFn(fn: Fn, cfg: {
  connFamily: string;
  sqlMode: string;
  restAuth: string;
  soapMode: string;
  scimAuth: string;
  security: string;
}): any {
  const globals =
    JSON.parse(
      localStorage.getItem("globals.details.v2") ||
      localStorage.getItem("globals.details") || "[]"
    ) || [];

  return {
    functionName: fn.name,
    inputs: (fn.inputs || []).map(p => ({
      name: p.name,
      type: p.type,
      mandatory: !!p.mandatory,
      source: p.source,
    })),
    connection: {
      family: cfg.connFamily,
      sqlMode: cfg.sqlMode,
      restAuth: cfg.restAuth,
      soapMode: cfg.soapMode,
      scimAuth: cfg.scimAuth,
      security: cfg.security,
      globals, // connection parameters (with secure flags if you set them)
    },
  };
}

  // Call this with the message the user typed (selected?.chat)
async function handleAIFromChat(userPrompt?: string) {
  const fn = selected;                    // the currently selected function
  if (!fn) return;
  const message = (userPrompt ?? fn.chat ?? "").trim();
  if (!message) return;

  try {
    setSending(true);                    // <— START waiting
    updateSelected({ convo: "" }); // <— placeholder in Chat response

    // Build a simple instruction + attach the user's message and current function
    const body = [
      "You are a helpful PowerShell assistant.",
      "If you provide code, do not wrap in markdown fences.",
      "Keep any <# ... #> comment blocks intact if present.",
    ].join("\n");

    const specObj = buildSpecForFn(selected!, {
  connFamily,
  sqlMode,
  restAuth,
  soapMode,
  scimAuth,
  security,
});
const specText   = JSON.stringify(specObj, null, 2);
const schemaText = getSchemaPretty();

// Compose a single fileText the API will receive
const compositeFileText =
`### SPEC
${specText}

### SCHEMA
${schemaText}

### CODE: ${selected!.name}.ps1
${selected!.script || ""}`;


    const payload = {
      body,                    // system-ish rules
      message,                 // user's prompt
      fileText: compositeFileText || "",              // current function text
      filename: `${fn.name || "Function"}.ps1`,
    };

    // Submit job
    const submitRes = await fetch("/api/ai/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const submitText = await submitRes.text();
    if (!submitRes.ok) throw new Error(submitText || `Submit failed (${submitRes.status})`);

    // Extract an id from JSON or raw text
    let id = "";
    try { id = JSON.parse(submitText).id || JSON.parse(submitText).request_id || ""; }
    catch { id = submitText.trim(); }
    if (!id) throw new Error("Submit did not return an id.");

    

    // Poll for result
    const { result = "", tests = "", description = "" } = await pollAiResult(id);
    const reply = String(result || "").trim();

    // Update the UI: put reply into chat response (convo)
    updateSelected({ convo: reply });

    // Optional: if the model returned a full function, replace the script too:
    // updateSelected({ script: reply });

    // Optional: stash tests/description if you keep them elsewhere
    // updateSelected({ xmlPreview: tests }); // or wherever you want to put it

    
  } catch (err: any) {
    
    alert(err?.message || "AI chat failed");
  } finally {
    setSending(false);
  }
}
 const canSend = !!(selected?.chat?.trim());
  const sendChat = () => {
    if (!selected || !selected.chat.trim()) return;
    handleAIFromChat();
  };

  const expandedTitle = useMemo(() => {
    switch (expanded) {
      case "script":
        return "Function";
      case "convo":
        return "Chat Response";
      case "chat":
        return "Chat Input";
      case "xml":
        return "XML Preview";
      default:
        return "";
    }
  }, [expanded]);

  const expandedValue = useMemo(() => {
    if (!selected) return "";
    switch (expanded) {
      case "script":
        return selected.script;
      case "convo":
        return selected.convo;
      case "chat":
        return selected.chat;
      case "xml":
        return selected.xmlPreview;
      default:
        return "";
    }
  }, [expanded, selected]);


 


  const onExpandedChange = useCallback(
    (val: string) => {
      if (!selected) return;
      switch (expanded) {
        case "script":
          updateSelected({ script: val });
          break;
        case "convo":
          updateSelected({ convo: val });
          break;
        case "chat":
          updateSelected({ chat: val });
          break;
        case "xml":
          updateSelected({ xmlPreview: val });
          break;
      }
    },
    [expanded, selected]
  );

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const [sending, setSending] = useState(false);

  function CornerSquareBtn({
    onClick,
    title = "Action",
  }: {
    onClick: () => void;
    title?: string;
  }) {
    return (
      <button
        onClick={onClick}
        title={title}
        className="absolute bottom-2 right-2 h-6 w-6 rounded border border-slate-300
                   bg-white hover:bg-slate-50 inline-flex items-center justify-center
                   text-[10px] leading-none shadow-sm"
      >
        <span className="block h-3 w-3 border border-slate-500" />
      </button>
    );
  }

  const logoutHref = "/.auth/logout?post_logout_redirect_uri=/login";
  return (
    <main className="min-h-screen bg-slate-50">
      {/* top row buttons */}
      <div className="sticky top-0 z-20 border-b border-white/10 bg-black/95 text-white backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 py-3 flex flex-wrap gap-2">
          <button
            onClick={handleUploadPerfectJsonClick}
            className="rounded-md px-3 py-1.5 text-sm text-white bg-sky-600 hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-400/60"
          >
            upload json
          </button>
          <button
            onClick={handleUploadPwClick}
            className="rounded-md px-3 py-1.5 text-sm text-white bg-violet-600 hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-400/60"
          >
            Upload pw
          </button>
          <button
            onClick={handlePreviewPw}
            className="rounded-md px-3 py-1.5 text-sm text-black bg-amber-300 hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-300/60"
          >
            Preview pw
          </button>
          <button
            onClick={handleDownloadPw}
            className="rounded-md px-3 py-1.5 text-sm text-white bg-emerald-600 hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
          >
            Download pw
          </button>
          <button
            onClick={handleDownloadXML}
            className="rounded-md px-3 py-1.5 text-sm text-white bg-cyan-600 hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
          >
            Download XML
          </button>

          <input
            ref={jsonInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleUploadPerfectJsonChange}
          />
          <input
            ref={pwInputRef}
            type="file"
            accept=".ps1,text/plain"
            className="hidden"
            onChange={handleUploadPwChange}
          />
          <button
  onClick={() => {
    window.location.href = "/.auth/logout?post_logout_redirect_uri=/";
  }}
  className="inline-flex items-center justify-center rounded-md border px-3 py-2 hover:bg-slate-50"
>
  Sign out
</button>
          
          <div className="ml-auto flex items-center gap-1">
  <label className="text-sm text-white/80">Path for NLog.dll</label>
  <input
    value={nlogPath}
    onChange={(e) => setNlogPath(e.target.value)}
    className="rounded-md border border-white/30 bg-black/20 text-white placeholder-white/50
             px-3 py-1.5 text-sm hover:border-white/40
              focus:outline-none focus:ring-2 focus:ring-white/30 focus:border-white/60"
   placeholder="C:\Program Files\One Identity\One Identity Manager\NLog.dll"
  />
</div>

        </div>
        
      </div>

      <div className={["transition filter", expanded ? "blur-[3px]" : "blur-0"].join(" ")}>
        <div
          className="
            mx-auto 
            max-w-[1600px]
            px-2 lg:px-3
            py-5 
            grid grid-cols-1 
            lg:grid-cols-[280px_1fr]
            gap-3
          "
        >
          
          
          {/* === ASIDE === */}
          <aside className="w-[280px] shrink-0 border-r bg-white -ml-2 lg:-ml-3">
            <div className="p-3 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700">Functions</h3>
                <button
                  onClick={() => setAdding((v) => !v)}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                >
                  + Add
                </button>
              </div>

              {adding && (
                <div className="mt-1 flex flex-wrap gap-2">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newName.trim()) confirmAdd();
                      if (e.key === "Escape") {
                        setAdding(false);
                        setNewName("");
                      }
                    }}
                    placeholder="Verb-Noun (e.g., Get-Users)"
                    className="flex-[1_1_140px] min-w-0 rounded-md border border-slate-300 px-3 py-2 text-sm
                               focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <button
                    onClick={confirmAdd}
                    disabled={!newName.trim()}
                    className="shrink-0 rounded-md bg-emerald-600 px-3 py-2 text-sm text-white
                               hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => {
                      setAdding(false);
                      setNewName("");
                    }}
                    className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm
                               text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                </div>
              )}

              <input
                value={fnQuery}
                onChange={(e) => setFnQuery(e.target.value)}
                placeholder="Search functions…"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-sky-500"
              />

              <ul className="mt-1 max-h-[calc(100vh-230px)] overflow-auto pr-1 space-y-1">
                {filteredFunctions.length === 0 ? (
                  <li className="py-6 text-center text-xs text-slate-500">No functions yet.</li>
                ) : (
                  filteredFunctions.map((fn) => (
                    <li
                      key={fn.id}
                      className="group flex items-center justify-between rounded-md
                                 border border-slate-200 bg-white px-2 py-1.5 text-sm
                                 hover:bg-slate-50"
                    >
                      <button
                        onClick={() => openFn(fn)}
                        className="truncate text-left font-medium text-slate-800"
                        title={fn.name}
                      >
                        {fn.name}
                      </button>
                      <button
                        onClick={() => confirmDelete(fn)}
                        className="rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5
                                   text-xs font-medium text-rose-700 hover:bg-rose-100"
                        title="Remove function"
                      >
                        Remove
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </aside>

          {/* RIGHT: editor card + XML preview */}
          <section className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {/* LEFT column: Edit Parameters card */}
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-end gap-2 border-b border-slate-100 px-4 py-2">
                <span className="text-sm font-semibold text-slate-800">Edit Parameters</span>
                <button
                  onClick={() => setParamsEnabled((v) => !v)}
                  role="switch"
                  aria-checked={paramsEnabled}
                  className={[
                    "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                    paramsEnabled ? "bg-emerald-500" : "bg-slate-300",
                  ].join(" ")}
                  title={paramsEnabled ? "Parameters enabled" : "Parameters disabled"}
                >
                  <span
                    className={[
                      "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
                      paramsEnabled ? "translate-x-5" : "translate-x-1",
                    ].join(" ")}
                  />
                </button>
              </div>

              <div className="p-3 space-y-3">
                {!paramsEnabled ? (
                  <>
                    {/* function card */}
                    <div className="relative rounded-xl border border-slate-300 overflow-hidden">
                      <div className="h-10 flex items-center justify-center text-sm text-slate-500 border-b border-slate-200 relative">
                        function
                        <button
                          onClick={() => copy(selected?.script ?? "")}
                          className="absolute right-2 top-1.5 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-50"
                        >
                          Copy
                        </button>
                      </div>
                      <textarea
                        className="h-48 w-full resize-none p-3 font-mono text-[13px] outline-none"
                        value={selected?.script ?? ""}
                        readOnly
                        placeholder="PowerShell goes here…"
                      />
                      <CornerSquareBtn onClick={() => setExpanded("script")} title="Expand" />
                    </div>

                     {/* chat response */}
<div className="relative rounded-xl border border-slate-300 overflow-hidden mt-3">
  <div className="h-10 flex items-center justify-between px-3 text-sm text-slate-600 border-b border-slate-200">
    <span>chat response</span>
      <button
    onClick={updateFunctionFromChat}
    className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-400"
    title="Replace the Function section above with the function found in this chat response"
  >
    Update function
  </button>
    {/* removed the right-side status from the header */}
  </div>

  <div className="relative">
    <textarea
      className="h-36 w-full resize-none p-3 text-sm outline-none"
      value={selected?.convo ?? ""}
      readOnly
      placeholder=""
      aria-live="polite"
    />
    {/* Thinking… ONLY inside the textarea, on the LEFT */}
    {sending && (
      <div
        className="pointer-events-none absolute top-2 left-3 flex items-center gap-2"
        role="status"
        aria-atomic="true"
      >
        <span className="font-semibold">
          Thinking<span className="animate-pulse">…</span>
        </span>
      </div>
    )}
  </div>

  <CornerSquareBtn onClick={() => setExpanded("convo")} title="Expand" />
</div>

                    {/* chat input */}
                    <div className="relative rounded-xl border border-slate-300 overflow-hidden">
                      <div className="h-10 flex items-center justify-between px-3 text-sm text-slate-600 border-b border-slate-200">
                        <span>chat input</span>
                      </div>

                      <div className="relative">
                        <textarea
                          className="h-24 w-full resize-none p-3 pt-10 pr-12 text-sm outline-none"
                          value={selected?.chat ?? ""}
                          onChange={(e) => updateSelected({ chat: e.target.value })}
                          onKeyDown={(e) => {
                            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                              e.preventDefault();
                              sendChat();
                            }
                          }}
                          placeholder="Type a message to the AI…  (Ctrl/⌘+Enter to send)"
                          disabled={sending}
                        />
                        <button
  onClick={sendChat}
  disabled={sending || !(selected?.chat || "").trim()}
  aria-disabled={sending || !(selected?.chat || "").trim()}
  aria-busy={sending}
  title={sending ? "Waiting for response…" : "Send (Ctrl/⌘+Enter)"}
  className={[
    "absolute top-2 right-2 inline-flex h-9 w-9 items-center justify-center rounded-full text-white shadow",
    sending
      ? "bg-emerald-800 cursor-not-allowed opacity-80"
      : "bg-emerald-700 hover:bg-emerald-800 active:bg-emerald-900",
  ].join(" ")}
>
  {sending ? (
    // small spinner
    <svg viewBox="0 0 24 24" className="h-5 w-5 animate-spin" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  ) : (
    // paper-plane icon
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  )}
</button>
                      </div>

                      <CornerSquareBtn onClick={() => setExpanded("chat")} title="Expand" />
                    </div>
                  </>
                ) : (
                  /* PARAMETERS EDITOR */
                  <div className="space-y-3">
                    {/* Row of dropdowns */}
                    <div className="flex flex-wrap items-center gap-3">
                      {/* Connection */}
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-slate-700">Connection</span>
                        <select
                          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                          value={connFamily}
                          onChange={(e) => setConnFamily(e.target.value as ConnFamily)}
                        >
                          <option>SQL</option>
                          <option>REST</option>
                          <option>SOAP</option>
                          <option>SCIM</option>
                        </select>
                      </div>

                      {connFamily === "SQL" && (
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-slate-700">Mode</span>
                          <select
                            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                            value={sqlMode}
                            onChange={(e) => setSqlMode(e.target.value as SqlMode)}
                          >
                            <option value="Discrete">Server/Port/Database</option>
                            <option value="ConnString">ConnectionString</option>
                          </select>
                        </div>
                      )}
                      {connFamily === "REST" && (
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-slate-700">Auth</span>
                          <select
                            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                            value={restAuth}
                            onChange={(e) => setRestAuth(e.target.value as RestAuth)}
                          >
                            <option>None</option>
                            <option>Basic</option>
                            <option>Bearer</option>
                            <option value="OAuth2CC">OAuth2CC</option>
                            <option value="HMAC">HMAC</option>
                            <option value="NTLM">NTLM</option>
                          </select>
                        </div>
                      )}
                      {connFamily === "SOAP" && (
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-slate-700">Mode</span>
                          <select
                            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                            value={soapMode}
                            onChange={(e) => setSoapMode(e.target.value as SoapMode)}
                          >
                            <option value="Plain">Plain</option>
                            <option value="WsAddressing">WS-Addressing</option>
                          </select>
                        </div>
                      )}
                      {connFamily === "SCIM" && (
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-slate-700">Auth</span>
                          <select
                            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                            value={scimAuth}
                            onChange={(e) => setScimAuth(e.target.value as ScimAuth)}
                          >
                            <option>None</option>
                            <option>Basic</option>
                            <option>Bearer</option>
                            <option value="OAuth2CC">OAuth2CC</option>
                            <option>APIKeyHeader</option>
                            <option>HMAC</option>
                            <option>NTLM</option>
                          </select>
                        </div>
                      )}


                      {/* Security */}
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-slate-700">Security</span>
                        <select
                          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                          value={security}
                          onChange={(e) => setSecurity(e.target.value as SecurityChoice)}
                        >
                          {securityOptionsForSelection(connFamily, restAuth, soapMode).map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <button
                          onClick={addManualParam}
                          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700"
                        >
                          + Add parameter
                        </button>
                      </div>
                    </div>

                    {/* Parameters list */}
                    <div className="grid gap-2">
                      {(selected?.inputs ?? []).length === 0 && (
                        <div className="text-sm text-slate-500 px-1">No parameters for this function.</div>
                      )}

                      {(selected?.inputs ?? []).map((p) => (
                        <div key={p.pid} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] items-start gap-3">
                            <div className="min-w-0">
                              <input
                                className="w-full max-w-[320px] rounded-md border border-slate-300 px-2 py-1 text-sm"
                                defaultValue={p.name}
                                onBlur={(e) => {
                                  const v = (e.target as HTMLInputElement).value.trim();
                                  if (v && v !== p.name) renameParam(p.pid, v);
                                  else (e.target as HTMLInputElement).value = p.name;
                                }}
                              />

                              <div className="mt-2">
                                <label className="block text-[12px] text-slate-700 mb-1">Source</label>
                                <select
                                  className="w-44 rounded-md border border-slate-300 px-2 py-[6px] text-sm"
                                  value={p.source}
                                  onChange={(e) => setParamSource(p.pid, e.target.value as SourceType)}
                                >
                                  <option>Schema</option>
                                  <option>Connection</option>
                                  <option>Manual</option>
                                </select>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center justify-end gap-3">
                              <label className="inline-flex items-center gap-1 text-[12px] text-slate-700">
                                <input
                                  type="checkbox"
                                  checked={p.mandatory}
                                  onChange={(e) => setParamMandatory(p.pid, e.target.checked)}
                                />
                                Mandatory
                              </label>

                              <div className="inline-flex items-center gap-2">
                                <span className="text-[12px] text-slate-700">Type</span>
                                <select
                                  className="rounded-md border border-slate-300 px-2 py-[6px] text-[12px]"
                                  value={p.type}
                                  onChange={(e) => setParamType(p.pid, e.target.value as UiType)}
                                >
                                  <option value="String">String</option>
                                  <option value="Bool">Bool</option>
                                  <option value="Int">Int</option>
                                  <option value="DateTime">DateTime</option>
                                </select>
                              </div>

                              <button
                                onClick={() => removeParam(p.pid)}
                                className="text-xs text-rose-600 hover:text-rose-800"
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT column: XML preview */}
            <div className="relative rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                <div className="text-sm font-medium text-slate-700">XML Preview</div>
                <button
                  onClick={() => copy(xmlPretty)} 
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50"
                >
                  copy
                </button>
              </div>

              <textarea
                className="h-[520px] w-full resize-none p-3 font-mono text-[13px] outline-none bg-slate-50 border-t"
                value={xmlPretty}
                readOnly
                spellCheck={false}
              />
              <CornerSquareBtn onClick={() => setExpanded("xml")} title="Expand" />
            </div>
          </section>
        </div>
      </div>

      {/* ---------- FULLSCREEN OVERLAY ---------- */}
      {expanded && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-sm"
          onClick={() => setExpanded(null)}
          aria-modal="true"
          role="dialog"
        >
          <div
            className="absolute left-1/2 top-1/2 w-[min(1400px,96vw)] h-[min(88vh,96vh)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-200 bg-white shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">{expandedTitle}</div>
              <div className="flex items-center gap-2">
                {expanded === "xml" && (
                  <button
                    onClick={() => {
                      const blob = new Blob([xmlPretty], {
                        type: "application/xml;charset=utf-8",
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${(selected?.name || "Function")}.expanded.xml`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50"
                  >
                    Download
                  </button>
                )}
                <button
                  onClick={() => copy(expanded === "xml" ? xmlPretty : expandedValue)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50"
                >
                  Copy
                </button>
                <button
                  onClick={() => setExpanded(null)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50"
                >
                  Close (Esc)
                </button>
              </div>
            </div>

            <textarea
              className="flex-1 w-full resize-none p-6 font-mono text-[14px] outline-none"
              value={expanded === "xml" ? xmlPretty : expandedValue}
              readOnly={expanded === "xml"}
              onChange={(e) => {
                if (expanded !== "xml") onExpandedChange(e.target.value);
              }}
              placeholder={
                expanded === "xml"
                  ? "<xml/>"
                  : expanded === "script"
                  ? "PowerShell goes here…"
                  : expanded === "convo"
                  ? "returned function by AI"
                  : "Type a message to the AI…"
              }
            />
          </div>
        </div>
      )}

      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="del-title"
        >
          <div className="w-[min(520px,92vw)] rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h3 id="del-title" className="text-sm font-semibold text-slate-900">
                Remove function?
              </h3>
              <button
                onClick={cancelDelete}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="px-4 py-4">
              <p className="text-sm text-slate-700">
                You’re about to remove <span className="font-semibold">{pendingDelete.name}</span>. This
                action can’t be undone.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-3">
              <button
                onClick={cancelDelete}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={doDelete}
                className="rounded-md bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
