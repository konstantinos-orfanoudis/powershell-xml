// app/api/process/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs"; // ensure Node runtime for larger uploads

const N8N_SUBMIT_FILE_URL = process.env.N8N_SUBMIT_FILE_URL!;
const HDR_NAME = process.env.N8N_AUTH_HEADER_NAME;   // e.g. "X-API-Key"
const HDR_VALUE = process.env.N8N_AUTH_HEADER_VALUE; // e.g. "my-secret"

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  if (!N8N_SUBMIT_FILE_URL) return bad("server missing N8N_SUBMIT_URL", 500);

  // Expect multipart/form-data with:
  // - file: File
  // - namingHints: string (optional)
  let inForm: FormData;
  try {
    inForm = await req.formData();
  } catch {
    return bad("request must be multipart/form-data with a 'file' field");
  }

  const file = inForm.get("file");
  if (!(file instanceof File)) {
    return bad("no file provided (expected form field 'file')");
  }

  const request_id = inForm.get("request_id")

  const namingHints = inForm.get("namingHints");
  const fileName = (file as File).name || "upload.bin";
  const fileType = inForm.get("fileType");
  // Build outbound multipart form for n8n
  const outForm = new FormData();
  outForm.append("file", file, fileName);
  if (typeof request_id === "string" && request_id.trim()) {
    outForm.append("request_id",request_id);
  }
  if (typeof namingHints === "string" && namingHints.trim()) {
    outForm.append("namingHints", namingHints);
  }
  if (typeof fileType === "string" && fileType.trim()) {
    outForm.append("fileType", fileType);
  }
  if (typeof fileName === "string" && fileName.trim()) {
    outForm.append("fileName", fileName);
  }
  // Custom headers (do NOT set Content-Type for FormData; fetch will set the boundary)
  const headers: Record<string, string> = {};
  if (HDR_NAME && HDR_VALUE) headers[HDR_NAME] = HDR_VALUE;

  let res: Response;
  try {
    res = await fetch(N8N_SUBMIT_FILE_URL, {
      method: "POST",
      headers,
      body: outForm,
    });
  } catch (e: any) {
    return bad(`n8n submit failed: ${e?.message ?? String(e)}`, 502);
  }

  const status = res.status;
  const ct = res.headers.get("content-type") || "";
  let body: any = null;
  try {
    body = ct.includes("application/json") ? await res.json() : await res.text();
  } catch {
    // ignore parse error
  }

  // On HTTP error, return compact message + code
  if (!res.ok) {
    const msg =
      typeof body === "string"
        ? body.slice(0, 200)
        : body?.error || `${status} ${res.statusText || "Error"}`;
    return NextResponse.json({ ok: false, error: msg, status }, { status });
  }

  // Extract request id from common shapes or from a UUID in a text payload
  let requestId: string | undefined;
  if (body && typeof body === "object") {
    requestId = body.request_id || body.id || body.requestId;
  }
  if (!requestId && typeof body === "string") {
    const m = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
    requestId = m?.[0];
  }
  if (!requestId) {
    return bad("submit returned unexpected payload (missing request id)", 502);
  }

  // Return compact, UI-friendly shape
  return NextResponse.json({ ok: true, id: requestId, status }, { status: 200 });
}
