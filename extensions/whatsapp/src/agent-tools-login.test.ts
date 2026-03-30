import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWhatsAppLoginTool } from "./agent-tools-login.js";

vi.mock("../login-qr-api.js", () => ({
  startWebLoginWithQr: vi.fn(),
  waitForWebLogin: vi.fn(),
}));

const { startWebLoginWithQr, waitForWebLogin } = await import("../login-qr-api.js");

describe("whatsapp agent-tools-login", () => {
  beforeEach(() => {
    vi.mocked(startWebLoginWithQr).mockReset();
    vi.mocked(waitForWebLogin).mockReset();
  });

  it("returns structured image + gateway PNG path on start", async () => {
    vi.mocked(startWebLoginWithQr).mockResolvedValue({
      message: "Scan this QR in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,YWJj",
      qrPngPath: "/tmp/openclaw-whatsapp-qr-default.png",
    });

    const tool = createWhatsAppLoginTool();
    const res = await tool.execute("tc1", { action: "start" });

    expect(res.content).toHaveLength(2);
    expect(res.content[0]).toMatchObject({ type: "text" });
    expect(String((res.content[0] as { text?: string }).text)).toContain(
      "/tmp/openclaw-whatsapp-qr-default.png",
    );
    expect(res.content[1]).toEqual({
      type: "image",
      data: "YWJj",
      mimeType: "image/png",
    });
    expect((res as { details?: { qrPngPath?: string } }).details?.qrPngPath).toBe(
      "/tmp/openclaw-whatsapp-qr-default.png",
    );
  });

  it("wait returns text only", async () => {
    vi.mocked(waitForWebLogin).mockResolvedValue({
      connected: true,
      message: "Linked.",
    });
    const tool = createWhatsAppLoginTool();
    const res = await tool.execute("tc2", { action: "wait" });
    expect(res.content).toEqual([{ type: "text", text: "Linked." }]);
  });
});
