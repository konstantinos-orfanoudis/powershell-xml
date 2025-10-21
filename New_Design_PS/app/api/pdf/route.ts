import { NextResponse } from "next/server";
import { extractPdfText } from "@/lib/pdf/extractFromPdf";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ ok: false, error: "Missing file" }, { status: 400 });
    }

    const buf = await file.arrayBuffer();
    const text = await extractPdfText(buf);

    return NextResponse.json({ ok: true, text });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "PDF extract failed" },
      { status: 500 }
    );
  }
}
