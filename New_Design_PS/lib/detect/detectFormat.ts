// lib/detect/detectFormat.ts

export type DetectedKind =
  | "soap-wsdl"
  | "soap-xsd"
  | "soap-envelope"
  | "scim-schemas-json"
  | "scim-resourceTypes-json"
  | "scim-generic-json"
  | "unknown";

export type DetectionResult = {
  kind: DetectedKind;
  isSoap: boolean;
  isScim: boolean;
  reason: string;
};

const SOAP_ENVELOPE_11 = /xmlns:(soap|SOAP)="http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\/"/i;
const SOAP_ENVELOPE_12 = /xmlns:(soap|SOAP)="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"/i;
const SOAP_ENVELOPE_TAG = /<(soap:)?Envelope\b/i;

const WSDL_TAG = /<((wsdl:)?definitions)\b/i;
const WSDL_NS = /xmlns:(wsdl|wsdl0?)="http:\/\/schemas\.xmlsoap\.org\/wsdl\/"/i;

const XSD_TAG = /<((xs|xsd):)?schema\b/i;
const XSD_NS = /xmlns:(xs|xsd)="http:\/\/www\.w3\.org\/2001\/XMLSchema"/i;

// Quick XML test (not a full parse)
const LOOKS_LIKE_XML = /^\s*<\?xml[\s\S]*?\?>|^\s*<[\s\S]+>$/i;

// SCIM markers (JSON)
const SCIM_URN_PREFIX = "urn:ietf:params:scim:schemas";
const SCIM_RT_URN = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";

/**
 * Detect whether a text blob is SOAP (WSDL/XSD/Envelope) or SCIM JSON.
 * Input: raw file contents as string.
 */
export function detectFormat(raw: string): DetectionResult {
  const text = (raw || "").trim();
  if (!text) {
    return { kind: "unknown", isSoap: false, isScim: false, reason: "Empty content" };
  }

  // --- Try JSON first (SCIM is JSON) ---
  const asJson = tryParseJson(text);
  if (asJson.ok) {
    const j = asJson.value;
    // Many SCIM payloads include a top-level "schemas" array with SCIM URNs.
    if (isScimSchemasDoc(j)) {
      return {
        kind: "scim-schemas-json",
        isSoap: false,
        isScim: true,
        reason: "JSON with 'schemas' containing SCIM URNs",
      };
    }
    // ResourceTypes responses usually have Resources[] with ResourceType schema URN.
    if (isScimResourceTypesDoc(j)) {
      return {
        kind: "scim-resourceTypes-json",
        isSoap: false,
        isScim: true,
        reason: "JSON ResourceTypes with SCIM ResourceType URN",
      };
    }
    // Generic SCIM JSON (common fields like 'meta.resourceType', 'id' as SCIM URN, etc.)
    if (isLikelyScimJson(j)) {
      return {
        kind: "scim-generic-json",
        isSoap: false,
        isScim: true,
        reason: "JSON with SCIM-looking structure",
      };
    }
    // JSON but not SCIM
  }

  // --- Then XML heuristics for SOAP/WSDL/XSD ---
  if (LOOKS_LIKE_XML.test(text)) {
    // SOAP Envelope (runtime messages)
    if ((SOAP_ENVELOPE_11.test(text) || SOAP_ENVELOPE_12.test(text)) && SOAP_ENVELOPE_TAG.test(text)) {
      return {
        kind: "soap-envelope",
        isSoap: true,
        isScim: false,
        reason: "XML with SOAP Envelope namespace",
      };
    }
    // WSDL (service definition)
    if (WSDL_TAG.test(text) || WSDL_NS.test(text)) {
      return {
        kind: "soap-wsdl",
        isSoap: true,
        isScim: false,
        reason: "XML with WSDL <definitions> or WSDL namespace",
      };
    }
    // XSD (schema)
    if (XSD_TAG.test(text) || XSD_NS.test(text)) {
      return {
        kind: "soap-xsd",
        isSoap: true,
        isScim: false,
        reason: "XML with XSD <schema> or XMLSchema namespace",
      };
    }
  }

  return { kind: "unknown", isSoap: false, isScim: false, reason: "No strong SOAP/SCIM markers found" };
}

/* ---------------- helpers ---------------- */

function tryParseJson(s: string): { ok: true; value: any } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

function isScimSchemasDoc(j: any): boolean {
  // Single object or list of objects that define SCIM schemas (RFC 7643)
  if (Array.isArray(j)) return j.some(isScimSchemasDoc);
  if (j && Array.isArray(j.schemas)) {
    // schemas field contains URNs; presence of SCIM prefix is the strongest hint
    if (j.schemas.some((x: any) => typeof x === "string" && x.startsWith(SCIM_URN_PREFIX))) return true;
  }
  // SCIM Schema documents also often have attributes[] with type/mutability/etc.
  if (j && Array.isArray(j.attributes) && (typeof j.id === "string") && j.id.startsWith(SCIM_URN_PREFIX)) {
    return true;
  }
  return false;
}

function isScimResourceTypesDoc(j: any): boolean {
  // Typical /ResourceTypes response: { "totalResults": n, "Resources": [ { "schemas": [ResourceTypeURN], ... } ] }
  const resources = Array.isArray(j?.Resources) ? j.Resources : Array.isArray(j) ? j : null;
  if (!resources) return false;
  return resources.some((r: any) =>
    Array.isArray(r?.schemas) && r.schemas.some((x: any) => x === SCIM_RT_URN)
  );
}

function isLikelyScimJson(j: any): boolean {
  // Heuristics: SCIM resources often have meta.resourceType, id, and a 'schemas' array with SCIM URN prefix
  const hasMetaRT = typeof j?.meta?.resourceType === "string";
  const hasScimSchemas =
    Array.isArray(j?.schemas) && j.schemas.some((x: any) => typeof x === "string" && x.startsWith(SCIM_URN_PREFIX));

  // Also allow arrays of resources
  if (Array.isArray(j)) {
    return j.some(isLikelyScimJson);
  }
  return !!(hasMetaRT || hasScimSchemas);
}
