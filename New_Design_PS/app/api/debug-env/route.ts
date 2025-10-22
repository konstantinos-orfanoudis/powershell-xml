export const runtime = "nodejs";

const KEYS: any[] = [
  "N8N_SUBMIT_URL",
    "N8N_RESULT_URL",
    "N8N_SECRET",
"N8N_AUTH_HEADER_NAME",
"N8N_AUTH_HEADER_VALUE",
"NEXT_PUBLIC_AI_SUBMIT_URL",
"N8N_SUBMIT_FILE_URL",
"N8N_RESULT_FILES_URL"
];

export async function GET() {
  const result = Object.fromEntries(KEYS.map(k => [k, !!process.env[k]]));
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
