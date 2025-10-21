// lib/soapSchema.ts
// Sync SOAP/WSDL/XSD → Schema.json extractor (no UI, no File/async).

export type AttrType = "String" | "Int" | "Bool" | "Datetime";
export type Attribute = { name: string; type: AttrType; MultiValue: boolean; IsKey?: boolean };
export type Entity = { name: string; attributes: Attribute[] };
export type Schema = { name: string; version: string; entities: Entity[] };

// ---------------- input normalization (no File, no async) ----------------
export type SoapInput =
  | string
  | string[]
  | { name: string; text: string }[]
  | Record<string, string>;

type FileLike = { name: string; text: string };

function normalizeInput(input: SoapInput): FileLike[] {
  if (typeof input === "string") return [{ name: "input.xml", text: input }];
  if (Array.isArray(input)) {
    if (input.length === 0) return [];
    if (typeof input[0] === "string") {
      return (input as string[]).map((t, i) => ({ name: `input-${i}.xml`, text: t }));
    }
    return input as { name: string; text: string }[];
  }
  // object map
  return Object.entries(input).map(([name, text]) => ({ name, text }));
}

// ---------------- parser core (DOM-based) ----------------
type QName = { ns?: string; local: string };
type Env = {
  nsDocs: Map<string, Document[]>;
  prefixToNs: Map<string, string>;
  docs: Document[];
  globals: Map<string, Element>;
  types: Map<string, Element>;
  keys: Map<string, Set<string>>;
  wsdlRoots: Set<string>;
};

const XS = "http://www.w3.org/2001/XMLSchema";
const WSDL = "http://schemas.xmlsoap.org/wsdl/";

const PRIMITIVE_MAP: Record<string, AttrType> = {
  string: "String",
  normalizedString: "String",
  token: "String",
  language: "String",
  Name: "String",
  NCName: "String",
  ID: "String",
  IDREF: "String",
  anyURI: "String",
  QName: "String",
  boolean: "Bool",
  byte: "Int",
  short: "Int",
  int: "Int",
  integer: "Int",
  long: "Int",
  nonNegativeInteger: "Int",
  positiveInteger: "Int",
  nonPositiveInteger: "Int",
  negativeInteger: "Int",
  unsignedByte: "Int",
  unsignedShort: "Int",
  unsignedInt: "Int",
  unsignedLong: "Int",
  decimal: "Int",
  float: "Int",
  double: "Int",
  date: "Datetime",
  dateTime: "Datetime",
  time: "Datetime",
};

function parseXml(text: string): Document {
  const p = new DOMParser();
  const doc = p.parseFromString(text, "text/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error(err.textContent || "XML parse error");
  return doc;
}
function qname(s: string | null | undefined, ctxEl: Element): QName | null {
  if (!s) return null;
  const [pref, local] = s.includes(":") ? s.split(":", 2) : [null, s];
  if (!local) return null;
  if (!pref) return { local };
  const ns = ctxEl.lookupNamespaceURI(pref) || undefined;
  return { ns, local };
}
const keyOfQName = (q: QName) => (q.ns || "") + ":" + q.local;
const keyOf = (ns: string | undefined, local: string) => (ns || "") + ":" + local;

function childEls(el: Element, ns?: string, local?: string): Element[] {
  const arr: Element[] = [];
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 1) {
      const e = n as Element;
      if ((ns && e.namespaceURI !== ns) || (local && e.localName !== local)) continue;
      arr.push(e);
    }
  }
  return arr;
}
const findEls = (doc: Document, ns: string, local: string) =>
  Array.from(doc.getElementsByTagNameNS(ns, local));

function primitiveFromXsdType(q: QName | null): AttrType | null {
  if (!q) return null;
  if (q.ns !== XS) return null;
  return PRIMITIVE_MAP[q.local] || "String";
}
function collectNamespaces(doc: Document): Map<string, string> {
  const map = new Map<string, string>();
  const root = doc.documentElement;
  if (!root) return map;
  for (const attr of Array.from(root.attributes)) {
    if (attr.name === "xmlns") map.set("", attr.value);
    else if (attr.name.startsWith("xmlns:")) map.set(attr.name.slice(6), attr.value);
  }
  return map;
}

function initEnv(files: FileLike[]): Env {
  const env: Env = {
    nsDocs: new Map(),
    prefixToNs: new Map(),
    docs: [],
    globals: new Map(),
    types: new Map(),
    keys: new Map(),
    wsdlRoots: new Set(),
  };
  for (const f of files) {
    const doc = parseXml(f.text);
    env.docs.push(doc);
    const nsmap = collectNamespaces(doc);
    for (const [p, u] of nsmap) env.prefixToNs.set(p, u);
    const ns = doc.documentElement?.namespaceURI;
    const tns = doc.documentElement?.getAttribute("targetNamespace") || undefined;

    if (ns === XS) {
      const arr = env.nsDocs.get(tns || "") || [];
      arr.push(doc);
      env.nsDocs.set(tns || "", arr);
    } else if (ns === WSDL) {
      const arr = env.nsDocs.get("WSDL") || [];
      arr.push(doc);
      env.nsDocs.set("WSDL", arr);
    }
  }

  // index global elements/types/keys + WSDL roots
  for (const doc of env.docs) {
    const ns = doc.documentElement?.namespaceURI;
    if (ns === XS) {
      const tns = doc.documentElement?.getAttribute("targetNamespace") || undefined;

      for (const el of findEls(doc, XS, "element")) {
        const parent = el.parentElement;
        if (parent?.namespaceURI === XS && parent.localName === "schema") {
          const name = el.getAttribute("name");
          if (name) env.globals.set(keyOf(tns, name), el);
        }
      }
      for (const ct of findEls(doc, XS, "complexType")) {
        const name = ct.getAttribute("name"); if (name) env.types.set(keyOf(tns, name), ct);
      }
      for (const st of findEls(doc, XS, "simpleType")) {
        const name = st.getAttribute("name"); if (name) env.types.set(keyOf(tns, name), st);
      }

      const keys = findEls(doc, XS, "key").concat(findEls(doc, XS, "unique"));
      for (const key of keys) {
        const selector = childEls(key, XS, "selector")[0];
        const field = childEls(key, XS, "field")[0];
        const selPath = selector?.getAttribute("xpath") || "";
        const fldPath = field?.getAttribute("xpath") || "";
        if (selPath && fldPath && !selPath.includes("/") && !fldPath.includes("/")) {
          const tgt = keyOf(tns, selPath.trim());
          const set = env.keys.get(tgt) || new Set<string>();
          set.add(fldPath.trim());
          env.keys.set(tgt, set);
        }
      }
    } else if (ns === WSDL) {
      for (const msg of findEls(doc, WSDL, "message")) {
        for (const part of childEls(msg, WSDL, "part")) {
          const elRef = part.getAttribute("element");
          if (!elRef) continue;
          const q = qname(elRef, part);
          if (q) env.wsdlRoots.add(keyOf(q.ns, q.local));
        }
      }
    }
  }
  return env;
}

function resolveGlobal(env: Env, ctx: Element, ref: string): Element | null {
  const q = qname(ref, ctx);
  if (!q) return null;
  const k = keyOfQName(q);
  return env.globals.get(k) || env.types.get(k) || null;
}

function walkElementToAttributes(env: Env, el: Element, into: Attribute[], tns?: string) {
  const ref = el.getAttribute("ref");
  const name = el.getAttribute("name");
  const minOccurs = Number(el.getAttribute("minOccurs") || "1");
  const maxOccurs = el.getAttribute("maxOccurs") || "1";
  const isMulti = maxOccurs === "unbounded" || Number(maxOccurs) > 1;

  if (ref && !name) {
    const referred = resolveGlobal(env, el, ref);
    if (referred && referred.namespaceURI === XS && referred.localName === "element") {
      const cloned = referred.cloneNode(true) as Element;
      if (isMulti) cloned.setAttribute("maxOccurs", "unbounded");
      if (minOccurs === 0) cloned.setAttribute("minOccurs", "0");
      walkElementToAttributes(env, cloned, into, tns);
      return;
    }
  }

  const typ = el.getAttribute("type");
  const prim = primitiveFromXsdType(qname(typ, el));
  if (prim) {
    into.push({ name: name || "field", type: prim, MultiValue: isMulti });
    return;
  }

  const inlineCT = childEls(el, XS, "complexType")[0];
  const inlineST = childEls(el, XS, "simpleType")[0];

  if (inlineST) {
    const rest = childEls(inlineST, XS, "restriction")[0];
    const baseName = rest?.getAttribute("base");
    const t = primitiveFromXsdType(qname(baseName || "", inlineST)) || "String";
    into.push({ name: name || "field", type: t, MultiValue: isMulti });
    return;
  }

  if (inlineCT) {
    const seq = childEls(inlineCT, XS, "sequence")[0];
    const all = childEls(inlineCT, XS, "all")[0];
    const choice = childEls(inlineCT, XS, "choice")[0];

    if (seq || all) {
      for (const c of childEls(seq || all)) {
        if (c.namespaceURI === XS && c.localName === "element") {
          walkElementToAttributes(env, c, into, tns);
        }
      }
    }
    if (choice) {
      for (const c of childEls(choice)) {
        if (c.namespaceURI === XS && c.localName === "element") {
          walkElementToAttributes(env, c, into, tns);
        }
      }
    }
    for (const a of childEls(inlineCT, XS, "attribute")) {
      const aname = a.getAttribute("name");
      const t = primitiveFromXsdType(qname(a.getAttribute("type"), a));
      if (aname && t) into.push({ name: aname, type: t, MultiValue: false });
    }
    return;
  }

  if (typ) {
    const target = resolveGlobal(env, el, typ);
    if (target) {
      if (target.localName === "simpleType") {
        into.push({ name: name || "field", type: "String", MultiValue: isMulti });
        return;
      }
      if (target.localName === "complexType") {
        const fake = el.ownerDocument!.createElementNS(XS, "xs:element");
        fake.setAttribute("name", name || "field");
        fake.appendChild(target.cloneNode(true));
        if (isMulti) fake.setAttribute("maxOccurs", "unbounded");
        walkElementToAttributes(env, fake, into, tns);
        return;
      }
    }
  }

  into.push({ name: name || "field", type: "String", MultiValue: isMulti });
}

function elementToEntity(env: Env, el: Element, tns?: string): Entity {
  const name = el.getAttribute("name") || "Entity";
  const attrs: Attribute[] = [];
  walkElementToAttributes(env, el, attrs, tns);

  // dedupe
  const seen = new Set<string>();
  const dedup: Attribute[] = [];
  for (const a of attrs) {
    if (seen.has(a.name)) continue;
    seen.add(a.name);
    dedup.push(a);
  }

  // mark keys from xs:key/unique or common id-ish names
  const kset = env.keys.get(keyOf(tns, name));
  if (kset?.size) {
    for (const a of dedup) if (kset.has(a.name)) a.IsKey = true;
  }
  if (!dedup.some(a => a.IsKey)) {
    for (const a of dedup) {
      if (/^(id|.*_ID|.*Id|.*ID)$/.test(a.name)) { a.IsKey = true; break; }
    }
  }

  return { name, attributes: dedup };
}

function collectEntities(env: Env, scope: "wsdl" | "all" | "union" = "wsdl"): Entity[] {
  const out = new Map<string, Entity>();
  const add = (el: Element) => {
    const tns = el.ownerDocument.documentElement.getAttribute("targetNamespace") || undefined;
    const ent = elementToEntity(env, el, tns);
    const k = keyOf(tns, ent.name);
    if (!out.has(k)) out.set(k, ent);
    else {
      const cur = out.get(k)!;
      const have = new Set(cur.attributes.map(a => a.name));
      for (const a of ent.attributes) if (!have.has(a.name)) cur.attributes.push(a);
      if (!cur.attributes.some(a => a.IsKey)) {
        const kAttr = ent.attributes.find(a => a.IsKey);
        if (kAttr) {
          const idx = cur.attributes.findIndex(a => a.name === kAttr.name);
          if (idx >= 0) cur.attributes[idx].IsKey = true;
        }
      }
    }
  };

  const addAllGlobals = () => { for (const [, el] of env.globals) add(el); };

  if (scope === "all") {
    addAllGlobals();
  } else if (scope === "union") {
    if (env.wsdlRoots.size) for (const k of env.wsdlRoots) { const el = env.globals.get(k); if (el) add(el); }
    addAllGlobals();
  } else { // "wsdl"
    if (env.wsdlRoots.size) {
      for (const k of env.wsdlRoots) { const el = env.globals.get(k); if (el) add(el); }
    } else {
      addAllGlobals();
    }
  }
  return Array.from(out.values());
}


// ---------------- exported sync API (no Files) ----------------
export function buildSchemaFromSoap(
  input: SoapInput,
  opts?: { name?: string; version?: string; scope?: "wsdl" | "all" | "union" }
): Schema {
  const files = normalizeInput(input);
  const env = initEnv(files);
  const entities = collectEntities(env, opts?.scope ?? "wsdl"); // default “wsdl” to keep old behavior
  return { name: opts?.name || "Connector", version: opts?.version || "1.0.0", entities };
}

