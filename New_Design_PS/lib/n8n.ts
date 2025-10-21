export const N8N_SUBMIT_URL = process.env.N8N_SUBMIT_URL || '';
export const N8N_RESULT_URL = process.env.N8N_RESULT_URL || '';
export const N8N_SECRET = process.env.N8N_SECRET || '';

export function n8nHeaders(extra?: Record<string, string>) {
  return { ...(extra || {}), ...(N8N_SECRET ? { 'x-shared-secret': N8N_SECRET } : {}) };
}
