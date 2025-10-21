// UploadPwxml.ts

export type UiType = "String" | "Bool" | "Int" | "DateTime";

type SourceType = "Schema" | "Connection" | "Manual";
export type FnInput = { name?: string; type?: string };
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

export type SchemaAttr = { name: string; type?: string };
export type SchemaEntity = { name: string; attributes?: SchemaAttr[] };
export type Schema = { entities?: SchemaEntity[] };

const SENSITIVE_RE = /password|token|secret|bearer/i;
const lc = (s: string) => String(s || "").trim().toLowerCase();
const esc = (s: string) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- helpers

const normalizeFnName = (n: string) => String(n || "").replace(/^global:\s*/i, "");

function schemaPropSet(schema: Schema): Set<string> {
  const set = new Set<string>();
  for (const e of (schema.entities || [])) {
    for (const a of (e.attributes || [])) set.add(lc(a.name));
  }
  return set;
}
// --- Upload-only session state ---------------------------------------------

let __uploadMode = false;

/** Call this right after a successful PW upload. */
export function startUploadMode() {
  __uploadMode = true;
}

/** Call this once the user edits *anything* (schema, function params/names, mappings, etc.). */
export function exitUploadMode() {
  __uploadMode = false;
}

/** Useful if your page wants to know whether to show any upload-only UI. */
export function isUploadMode() {
  return __uploadMode;
}

function isGlobalFunction(fn: Fn): boolean {
  const norm = normalizeFnName(fn.name);
  const nameBare = norm.replace(/[^A-Za-z0-9_-]/g, "");
  const re = new RegExp(String.raw`function\s+global:\s*${nameBare}\b`, "i");
  return re.test(fn.script || "");
}

function splitVerbNoun(name: string) {
  const norm = normalizeFnName(name);
  const m = String(norm || "").match(/^([A-Za-z_]+)-(.+)$/);
  return { verb: (m?.[1] || ""), noun: (m?.[2] || "") };
}

function singularize(s: string) {
  const n = lc(s);

  // 1) 'ies' -> 'y'  (policies -> policy)
  if (n.endsWith("ies")) return n.slice(0, -3) + "y";

  // 2) remove 'es' only for endings that really take 'es' in plural
  //    (boxes -> box, statuses -> status, quizzes -> quiz, churches -> church, brushes -> brush)
  if (/(ses|xes|zes|ches|shes)$/i.test(n)) return n.slice(0, -2);

  // 3) otherwise just drop a single trailing 's' (roles -> role, users -> user)
  if (n.endsWith("s")) return n.slice(0, -1);

  return n;
}

function nounMatchesEntity(noun: string, entity: string) {
  const n = lc(noun), e = lc(entity);
  return n === e || singularize(n) === e;
}

function getFnByName(fns: Fn[], name: string) {
  const n = lc(normalizeFnName(name));
  return fns.find(f => lc(normalizeFnName(f.name)) === n) || null;
}

function firstFnForEntity(fns: Fn[], entity: string, verbs: string[]): string | null {
  const found = fns.find(fn => {
    const { verb, noun } = splitVerbNoun(fn.name);
    return verbs.some(v => lc(v) === lc(verb)) && nounMatchesEntity(noun, entity);
  });
  return found ? normalizeFnName(found.name) : null;
}

function namesMatchOrIdPair(param: string, prop: string) {
  const p = lc(param);
  const a = lc(prop);
  if (p === a) return true;
  if (p.endsWith("id") && p.slice(0, -2) === a) return true; // RoleId vs Role
  if (a.endsWith("id") && a.slice(0, -2) === p) return true; // Role vs RoleId
  if (a === "id" && (p.endsWith("id") || p === "id")) return true;
  return false;
}

/** For a given function, return params that are NOT schema properties, uniqued by name. */
function effectiveParamsForFn(fn: Fn | null, props: Set<string>) {
  if (!fn) return [] as { name: string; secure: boolean }[];
  const seen = new Set<string>();
  const out: { name: string; secure: boolean }[] = [];
  for (const p of (fn.inputs || [])) {
    const nm = String(p?.name || "").trim();
    if (!nm) continue;
    const key = lc(nm);
    if (seen.has(key)) continue;
    if (props.has(key)) { seen.add(key); continue; } // exclude schema props
    seen.add(key);
    out.push({ name: nm, secure: SENSITIVE_RE.test(nm) });
  }
  return out;
}

function setParamLine(p: { name: string; secure: boolean }, indent = "          ") {
  const conv = p.secure ? ' ConversionMode="SecureString"' : "";
  return `${indent}<SetParameter Value="${esc(p.name)}" Source="ConnectionParameter" Param="${esc(p.name)}"${conv}/>`;
}

/** ConnectionParameters come ONLY from global: functions' params (minus schema props). */
function collectConnectionParametersFromGlobals(fns: Fn[], schema: Schema) {
  const props = schemaPropSet(schema);
  const names = new Map<string, { name: string; secure: boolean }>();
  for (const fn of fns) {
    if (!isGlobalFunction(fn)) continue;
    for (const p of (fn.inputs || [])) {
      const nm = String(p?.name || "").trim();
      if (!nm) continue;
      const key = lc(nm);
      if (props.has(key)) continue; // skip schema properties
      if (!names.has(key)) names.set(key, { name: nm, secure: SENSITIVE_RE.test(nm) });
    }
  }
  return Array.from(names.values());
}
// === NEW: classify parameters during Upload PW ===

type SourceTag = "Connection" | "Schema" | "Manual";

// map Schema: property name (lower) -> UiType
function _schemaPropTypeMap(schema: Schema): Map<string, UiType> {
  const m = new Map<string, UiType>();
  for (const e of (schema.entities || [])) {
    for (const a of (e.attributes || [])) {
      const name = String(a?.name || "").trim();
      if (!name) continue;
      m.set(name.toLowerCase(), toXmlType(a?.type));
    }
  }
  return m;
}

// normalize ps param type into UiType for comparison
function _paramUiType(pType?: string): UiType {
  const s = String(pType || "");
  if (/int/i.test(s)) return "Int";
  if (/bool/i.test(s)) return "Bool";
  if (/date/i.test(s)) return "DateTime";
  return "String";
}

/**
 * Classify each imported fn param with source:
 *  - "Connection" if the param name is part of the (to-be) ConnectionParameters set
 *  - "Schema"     if matches a schema property by name AND UiType
 *  - "Manual"     otherwise
 *
 * NOTE: we do not mutate the array; we return a new one with `source` set.
 */
export function classifyParamsForUpload(importedFns: Fn[], schema: Schema): Fn[] {
  // 1) figure out which names will be ConnectionParameters (same logic as XML):
  const connParams = collectConnectionParametersFromGlobals(importedFns, schema)
    .map(p => String(p.name || "").trim())
    .filter(Boolean);

  const connSet = new Set(connParams.map(n => n.toLowerCase()));
  const schemaTypes = _schemaPropTypeMap(schema);

  const next: Fn[] = importedFns.map(fn => {
    const inputs = (fn.inputs || []).map(inp => {
      const name = String(inp?.name || "").trim();
      if (!name) return { ...inp };

      // Connection?
      if (connSet.has(name.toLowerCase())) {
        return { ...inp, source: "Connection" as SourceTag };
      }

      // Schema? (name & type match)
      const pType = _paramUiType(inp?.type);
      const sType = schemaTypes.get(name.toLowerCase()); // exact name match only
      if (sType && sType === pType) {
        return { ...inp, source: "Schema" as SourceTag };
      }

      // Fallback
      return { ...inp, source: "Manual" as SourceTag };
    });

    return { ...fn, inputs };
  });

  return next;
}

function buildConnectionParametersXml(params: Array<{ name: string; secure: boolean }>) {
  const lines = params.map(p => {
    const sens = p.secure ? ' IsSensibleData="true"' : "";
    return `    <ConnectionParameter Description="${esc(p.name)}" Name="${esc(p.name)}"${sens}/>`;
  });
  lines.unshift(`    <ConnectionParameter Description="Path to the supporting PowerShell Module eg. C:\\temp\\SalesforceFunctions.psm1 (optional)" Name="PathToPSModule"/>`);
  return `  <ConnectionParameters>\n${lines.join("\n")}\n  </ConnectionParameters>\n`;
}

function buildGetAuthorizationCData(params: Array<{ name: string }>) {
  if (!params.length) return "<![CDATA[ [CmdletBinding()] param() ]]>";
  const plist = params.map((p, i) =>
    `        [Parameter(Mandatory=$false,ValueFromPipelineByPropertyName=$true)] [string] $${p.name}${i === params.length-1 ? "" : ","}`
  );
  const assigns = params.map(p => `        if ($PSBoundParameters.ContainsKey('${p.name}')) { $global:${p.name} = $${p.name} ; }`);
  return ["<![CDATA[ [CmdletBinding()]", "        param(", ...plist, "        )", ...assigns, "        ]]>"].join("\n");
}

function buildCustomCommands(params: Array<{ name: string }>) {
  const importSf =
`      <CustomCommand Name="Import-SFModule">
        <![CDATA[ param(
        [parameter(Mandatory=$true,ValueFromPipelineByPropertyName=$true)]
        [ValidateNotNullOrEmpty()]
        [String]$_PathToPSModule
        )
        Import-Module -Force -Verbose $_PathToPSModule ]]>
      </CustomCommand>`;

  const getAuth =
`      <CustomCommand Name="Get-Authorization">
        ${buildGetAuthorizationCData(params)}
      </CustomCommand>`;

  return [
    "    <CustomCommands>",
    importSf,
    getAuth,
    "    </CustomCommands>",
    "",
  ].join("\n");
}

function buildPredefinedCommands(fns: Fn[]) {
  const globals = fns.filter(isGlobalFunction);
  if (!globals.length) return "    <PredefinedCommands/>\n";
  const lines = globals.map(fn => `      <Command Name="${esc(normalizeFnName(fn.name))}"/>`);
  return `    <PredefinedCommands>\n${lines.join("\n")}\n    </PredefinedCommands>\n`;
}

function buildConnectSequence(params: Array<{ name: string; secure: boolean }>) {
  const getAuthSet = params.map(p => setParamLine(p, "            ")).join("\n");
  return [
    "    <EnvironmentInitialization>",
    "      <Connect>",
    "        <CommandSequence>",
    '          <Item Order="1" Command="Import-SFModule">',
    '            <SetParameter Value="PathToPSModule" Source="ConnectionParameter" Param="_PathToPSModule"/>',
    "          </Item>",
    '          <Item Order="2" Command="Get-Authorization">',
    getAuthSet ? getAuthSet : "",
    "          </Item>",
    "        </CommandSequence>",
    "      </Connect>",
    "      <Disconnect/>",
    "    </EnvironmentInitialization>",
  ].join("\n");
}

function toXmlType(t?: string): UiType {
  const s = String(t || "");
  if (/int/i.test(s)) return "Int";
  if (/bool/i.test(s)) return "Bool";
  if (/date/i.test(s)) return "DateTime";
  return "String";
}


function findEntityFns(entity: string, fns: Fn[]) {
  const LIST_VERBS   = ["Get", "List", "Find", "Read", "Query", "Search", "Fetch", "Select"];
  const INSERT_VERBS = ["Create", "Add", "Insert", "New"];
  const UPDATE_VERBS = ["Update", "Modify", "Set", "Patch", "Change"];
  const DELETE_VERBS = ["Delete", "Remove", "Erase", "Drop"];

  const list   = firstFnForEntity(fns, entity, LIST_VERBS);
  const insert = firstFnForEntity(fns, entity, INSERT_VERBS);
  const update = firstFnForEntity(fns, entity, UPDATE_VERBS);
  const del    = firstFnForEntity(fns, entity, DELETE_VERBS);

  return { list, insert, update, del };
}

// ---------- per-class builders

function buildPropertiesXml(entity: SchemaEntity, fns: Fn[], schema: Schema) {
  const { list, insert, update, del } = findEntityFns(entity.name, fns);

  const fnHasParamForProp = (fnName: string | null, prop: string) => {
    if (!fnName) return false;
    const fn = getFnByName(fns, fnName);
    if (!fn) return false;
    return (fn.inputs || []).some(p => namesMatchOrIdPair(String(p?.name || ""), prop));
  };

  const props = entity.attributes || [];
  if (!props.length) return "      <Properties/>\n";

  const keyName =
    props.find(a => /^id$/i.test(a.name))?.name ||
    props.find(a => /id$/i.test(a.name))?.name ||
    props[0].name;

  const lines: string[] = [];
  for (const a of props) {
    const isKey = a.name === keyName;
    const dt = toXmlType(a.type);
    const baseAttrs = [
      `Name="${esc(a.name)}"`,
      `DataType="${dt}"`,
      isKey ? `IsDisplay="true" IsUniqueKey="true" IsMandatory="true"` : `IsMandatory="true"`,
    ].join(" ");

    // CommandMappings
    const maps: string[] = [];
    // Always map key -> list if list exists (helps when optional key param parsing is missed),
    // otherwise for non-key require the param to actually exist on the function.
    if (list && isKey) {
      maps.push(`            <Map ToCommand="${esc(list)}" Parameter="${esc(a.name)}"/>`);
    } else if (insert && !isKey && fnHasParamForProp(insert, a.name)) {
      maps.push(`            <Map ToCommand="${esc(insert)}" Parameter="${esc(a.name)}"/>`);
    }
    if (update && fnHasParamForProp(update, a.name)) {
      maps.push(`            <Map ToCommand="${esc(update)}" Parameter="${esc(a.name)}"/>`);
    }
    if (del && isKey && fnHasParamForProp(del, a.name)) {
      maps.push(`            <Map ToCommand="${esc(del)}" Parameter="${esc(a.name)}"/>`);
    }
    const cm = maps.length ? `\n          <CommandMappings>\n${maps.join("\n")}\n          </CommandMappings>` : "";

    // ModifiedBy: never for key; otherwise only include if fn exists AND has this property
    let mb = "";
    if (!isKey) {
      const modBy: string[] = [];
      if (insert && fnHasParamForProp(insert, a.name)) modBy.push(`            <ModBy Command="${esc(insert)}"/>`);
      if (update && fnHasParamForProp(update, a.name)) modBy.push(`            <ModBy Command="${esc(update)}"/>`);
      if (modBy.length) mb = `\n          <ModifiedBy>\n${modBy.join("\n")}\n          </ModifiedBy>`;
    }

    // ReturnBindings only if a real list function exists
    const rb = list
      ? `\n          <ReturnBindings>\n            <Bind Path="${esc(a.name)}" CommandResultOf="${esc(list)}"/>\n          </ReturnBindings>`
      : "";

    lines.push(`        <Property ${baseAttrs}>${cm}${mb}${rb}\n        </Property>`);
  }

  return `      <Properties>\n${lines.join("\n")}\n      </Properties>\n`;
}

function buildReadConfigurationXml(entity: SchemaEntity, fns: Fn[], schema: Schema) {
  const { list } = findEntityFns(entity.name, fns);
  if (!list) return ""; // no listing if no real Get-*
  const props = schemaPropSet(schema);
  const listFn = getFnByName(fns, list);
  const eff = effectiveParamsForFn(listFn, props);
  const sets = eff.map(p => setParamLine(p)).join("\n");
  return [
    "      <ReadConfiguration>",
    `        <ListingCommand Command="${esc(list)}">`,
    sets ? sets : "",
    "        </ListingCommand>",
    "        <CommandSequence>",
    `          <Item Order="1" Command="${esc(list)}">`,
    sets ? sets : "",
    "          </Item>",
    "        </CommandSequence>",
    "      </ReadConfiguration>",
    "",
  ].join("\n");
}

function buildMethodConfigurationXml(entity: SchemaEntity, fns: Fn[], schema: Schema) {
  const { insert, update, del } = findEntityFns(entity.name, fns);
  const props = schemaPropSet(schema);
  const blocks: string[] = [];

  if (insert) {
    const fn = getFnByName(fns, insert);
    const eff = effectiveParamsForFn(fn, props).map(p => setParamLine(p, "            ")).join("\n");
    blocks.push(
      [
        `      <Method Name="Insert">`,
        `        <CommandSequence>`,
        `          <Item Order="1" Command="${esc(insert)}">`,
        eff ? eff : "",
        `          </Item>`,
        `        </CommandSequence>`,
        `      </Method>`,
      ].join("\n")
    );
  }
  if (update) {
    const fn = getFnByName(fns, update);
    const eff = effectiveParamsForFn(fn, props).map(p => setParamLine(p, "            ")).join("\n");
    blocks.push(
      [
        `      <Method Name="Update">`,
        `        <CommandSequence>`,
        `          <Item Order="1" Command="${esc(update)}">`,
        eff ? eff : "",
        `          </Item>`,
        `        </CommandSequence>`,
        `      </Method>`,
      ].join("\n")
    );
  }
  if (del) {
    const fn = getFnByName(fns, del);
    const eff = effectiveParamsForFn(fn, props).map(p => setParamLine(p, "            ")).join("\n");
    blocks.push(
      [
        `      <Method Name="Delete">`,
        `        <CommandSequence>`,
        `          <Item Order="1" Command="${esc(del)}">`,
        eff ? eff : "",
        `          </Item>`,
        `        </CommandSequence>`,
        `      </Method>`,
      ].join("\n")
    );
  }

  if (!blocks.length) return "";
  return `    <MethodConfiguration>\n${blocks.join("\n")}\n    </MethodConfiguration>\n`;
}

function buildClassXml(entity: SchemaEntity, fns: Fn[], schema: Schema) {
  const { list, insert, update, del } = findEntityFns(entity.name, fns);
  if (!list && !insert && !update && !del) return ""; // omit class entirely

  const props = buildPropertiesXml(entity, fns, schema);
  const read  = buildReadConfigurationXml(entity, fns, schema);
  const methods = buildMethodConfigurationXml(entity, fns, schema);

  const parts: string[] = [];
  parts.push(`    <Class Name="${esc(entity.name)}">`);
  parts.push(props.trimEnd());
  if (read.trim()) parts.push(read.trimEnd());
  if (methods.trim()) parts.push(methods.trimEnd());
  parts.push("    </Class>");
  return parts.join("\n") + "\n";
}

// ---------- public API

export function buildXmlFromUploadPw(importedFns: Fn[], schema: Schema) {
  const connParams = collectConnectionParametersFromGlobals(importedFns, schema);

  const header =
`<?xml version="1.0" encoding="utf-8"?>
<PowershellConnectorDefinition Description="Example SQL Connector" Version="1.0" Id="CustomConnector">
  <PluginAssemblies/>`;

  const connXml = buildConnectionParametersXml(connParams);

  const initOpen = "  <Initialization>\n";
  const customCmds = buildCustomCommands(connParams);
  const predefined = buildPredefinedCommands(importedFns);
  const connectSeq = buildConnectSequence(connParams);
  const initClose = "  </Initialization>\n";

  const classXmls = (schema.entities || [])
    .map(e => buildClassXml(e, importedFns, schema))
    .filter(x => !!x && x.trim().length > 0)
    .join("\n");

  const schemaXml = `  <Schema>\n${classXmls}  </Schema>\n`;

  const xml =
    [
      header,
      connXml.trimEnd(),
      initOpen.trimEnd(),
      customCmds.trimEnd(),
      predefined.trimEnd(),
      connectSeq.trimEnd(),
      initClose.trimEnd(),
      schemaXml.trimEnd(),
      "</PowershellConnectorDefinition>",
    ].join("\n") + "\n";

  return xml;
}
