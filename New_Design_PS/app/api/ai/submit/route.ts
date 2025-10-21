import { NextRequest, NextResponse } from 'next/server';

const N8N_SUBMIT_URL = process.env.N8N_SUBMIT_URL!;
const HDR_NAME = process.env.N8N_AUTH_HEADER_NAME;   // e.g. X-API-Key
const HDR_VALUE = process.env.N8N_AUTH_HEADER_VALUE; // e.g. my-secret

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  if (!N8N_SUBMIT_URL) return bad('server missing N8N_SUBMIT_URL', 500);

  const psText = await req.text();
  const filename = req.headers.get('x-filename') ?? 'powershell-prototypes.ps1';

  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Filename': filename,
  };
  if (HDR_NAME && HDR_VALUE) headers[HDR_NAME] = HDR_VALUE;

  let res: Response;
  try {
    res = await fetch(N8N_SUBMIT_URL, { method: 'POST', headers, body: psText });
  } catch (e: any) {
    return bad(`n8n submit failed: ${e?.message ?? String(e)}`, 502);
  }

  const ct = res.headers.get('content-type') || '';
  let body: any = null;

  try {
    body = ct.includes('application/json') ? await res.json() : await res.text();
  } catch {
    // ignore parse error
  }

  if (!res.ok) {
    const msg = typeof body === 'string' ? body : body?.error || `n8n submit returned ${res.status}`;
    return bad(msg, res.status);
  }

  // Make it tolerant: {ok,request_id} | {id} | raw text containing UUID
  let requestId: string | undefined;
  if (body && typeof body === 'object') {
    requestId = body.request_id || body.id || body.requestId;
  }
  if (!requestId && typeof body === 'string') {
    const m = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
    requestId = m?.[0];
  }

  if (!requestId) return bad('submit returned unexpected payload', 502);

  return NextResponse.json({ ok: true, id: requestId });
}
