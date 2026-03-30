import fsp from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import { renderQrPngBase64 } from "./qr-image.js";

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]+/g, "-") || "default";
}

async function writePngBase64ToTemp(base64: string, label: string): Promise<string> {
  const safe = sanitizeLabel(label);
  const filePath = path.join(resolvePreferredOpenClawTmpDir(), `openclaw-whatsapp-qr-${safe}.png`);
  await fsp.writeFile(filePath, Buffer.from(base64, "base64"), { mode: 0o600 });
  return filePath;
}

/** Persist a `data:image/png;base64,...` payload from `startWebLoginWithQr`. */
export async function writeWhatsAppQrDataUrlToTempFile(
  qrDataUrl: string,
  label: string,
): Promise<string | null> {
  const trimmed = qrDataUrl.trim();
  const match = trimmed.match(/^data:image\/png;base64,(.+)$/i);
  const base64 = (match?.[1] ?? "").trim();
  if (!base64) {
    return null;
  }
  return writePngBase64ToTemp(base64, label);
}

/** Encode raw Baileys QR text and write PNG (CLI / terminal login). */
export async function writeRawWhatsAppQrToTempPng(
  qr: string,
  label: string,
): Promise<string | null> {
  const trimmed = qr.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const base64 = await renderQrPngBase64(trimmed);
    return await writePngBase64ToTemp(base64, label);
  } catch {
    return null;
  }
}
