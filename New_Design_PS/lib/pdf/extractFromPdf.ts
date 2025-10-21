import "server-only";
import { Buffer } from "node:buffer";
const pdf = require("pdf-parse"); // <-- default export function

export async function extractPdfText(pdfBytes: ArrayBuffer | Uint8Array) {
  const buf =
    pdfBytes instanceof Uint8Array
      ? Buffer.from(pdfBytes)
      : Buffer.from(new Uint8Array(pdfBytes));
  const res = await pdf(buf);
  const text = (res?.text || "").trim();
  if (!text) throw new Error("No extractable text found in PDF.");
  return text;
}
