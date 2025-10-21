// detectUploads.ts
export type UploadKind = "scim" | "soap" | "unknown";

/** Quick filename hint */
function hintFromName(name: string): "scim-hint" | "soap-hint" | "unknown" {
  const n = name.toLowerCase();
  if (n.endsWith(".wsdl") || n.endsWith(".xsd") || n.includes("wsdl")) return "soap-hint";
  if (n.endsWith(".json") && (n.includes("scim") || n.includes("schema") || n.includes("resourcetypes"))) {
    return "scim-hint";
  }
  return "unknown";
}

/** Heuristics to spot SCIM JSON discovery docs (/Schemas and /ResourceTypes) */
function isLikelyScimJson(text: string): boolean {
  try {
    const j = JSON.parse(text);

    // 1) /Schemas response shape: { "Resources": [ { "id": "urn:ietf:params:scim:schemas:..." , "attributes": [...] } ] }
    if (Array.isArray(j?.Resources) && j.Resources.some((r: any) =>
        typeof r?.id === "string" && r.id.startsWith("urn:ietf:params:scim:schemas:"))) {
      return true;
    }

    // 2) Single Schema doc: { "id": "urn:ietf:params:scim:schemas:...", "attributes": [...] }
    if (typeof j?.id === "string" && j.id.startsWith("urn:ietf:params:scim:schemas:") && Array.isArray(j?.attributes)) {
      return true;
    }

    // 3) /ResourceTypes response: { "Resources": [ { "id": "User", "schema": "urn:...:User", ... } ] }
    if (Array.isArray(j?.Resources) && j.Resources.some((r: any) =>
        (typeof r?.schema === "string" && r.schema.startsWith("urn:ietf:params:scim:schemas:")) ||
        (Array.isArray(r?.schemaExtensions) && r.schemaExtensions.some((se: any) =>
          typeof se?.schema === "string" && se.schema.startsWith("urn:ietf:params:scim:schemas:")
        ))
      )) {
      return true;
    }

    // 4) Some vendors return an array of schemas directly
    if (Array.isArray(j) && j.some((r: any) =>
        typeof r?.id === "string" && r.id.startsWith("urn:ietf:params:scim:schemas:"))) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/** Heuristics to spot SOAP XML (WSDL/XSD) */
function isLikelySoapXml(text: string): boolean {
  const t = text.slice(0, 2000); // sniff the head
  // WSDL namespace or elements
  if (/\bwsdl:definitions\b/i.test(t) || /http:\/\/schemas\.xmlsoap\.org\/wsdl\//i.test(t)) return true;
  // XSD schema (common with SOAP toolchains)
  if (/\b(xs|xsd):schema\b/i.test(t)) return true;
  // SOAP envelope (in case someone uploaded a sample SOAP message)
  if (/http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\//i.test(t) || /\bsoap:Envelope\b/i.test(t)) return true;
  return false;
}

/**
 * Detect if the user uploaded SCIM discovery files vs SOAP artifacts.
 * Call this with the File objects from your page (e.g., `items.map(i => i.file)`).
 */
export async function detectUploadKind(files: File[]): Promise<UploadKind> {
  if (!files?.length) return "unknown";

  // Quick filename pass
  let nameHints = { scim: 0, soap: 0 };
  for (const f of files) {
    const h = hintFromName(f.name);
    if (h === "scim-hint") nameHints.scim++;
    if (h === "soap-hint") nameHints.soap++;
  }

  // Read small slices to keep this cheap
  const texts = await Promise.all(
    files.slice(0, 6).map(async (f) => {
      const blob = f.size > 200_000 ? f.slice(0, 200_000) : f; // first 200KB is plenty
      return (await blob.text()).trim();
    })
  );

  const scimHits = texts.filter(isLikelyScimJson).length;
  const soapHits = texts.filter(isLikelySoapXml).length;

  // Combine hints + content
  const scimScore = scimHits * 3 + nameHints.scim;
  const soapScore = soapHits * 3 + nameHints.soap;

  if (scimScore === 0 && soapScore === 0) return "unknown";
  return scimScore >= soapScore ? "scim" : "soap";
}
