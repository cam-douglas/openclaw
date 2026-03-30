import { Type } from "@sinclair/typebox";
import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-contract";
import { startWebLoginWithQr, waitForWebLogin } from "../login-qr-api.js";

function pngBase64FromDataUrl(qrDataUrl: string): string | null {
  const match = qrDataUrl.trim().match(/^data:image\/png;base64,(.+)$/i);
  const raw = (match?.[1] ?? "").trim();
  return raw.length > 0 ? raw : null;
}

export function createWhatsAppLoginTool(): ChannelAgentTool {
  return {
    label: "WhatsApp Login",
    name: "whatsapp_login",
    ownerOnly: true,
    description: "Generate a WhatsApp QR code for linking, or wait for the scan to complete.",
    // NOTE: Using Type.Unsafe for action enum instead of Type.Union([Type.Literal(...)]
    // because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
    parameters: Type.Object({
      action: Type.Unsafe<"start" | "wait">({
        type: "string",
        enum: ["start", "wait"],
      }),
      timeoutMs: Type.Optional(Type.Number()),
      force: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, args) => {
      const action = (args as { action?: string })?.action ?? "start";
      if (action === "wait") {
        const result = await waitForWebLogin({
          timeoutMs:
            typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
              ? (args as { timeoutMs?: number }).timeoutMs
              : undefined,
        });
        return {
          content: [{ type: "text", text: result.message }],
          details: { connected: result.connected },
        };
      }

      const result = await startWebLoginWithQr({
        timeoutMs:
          typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (args as { timeoutMs?: number }).timeoutMs
            : undefined,
        force:
          typeof (args as { force?: unknown }).force === "boolean"
            ? (args as { force?: boolean }).force
            : false,
      });

      if (!result.qrDataUrl) {
        return {
          content: [
            {
              type: "text",
              text: result.message,
            },
          ],
          details: { qr: false },
        };
      }

      const pngBase64 = pngBase64FromDataUrl(result.qrDataUrl);
      const textLines = [
        result.message,
        "",
        "Open WhatsApp → Linked Devices and scan the QR in the attached image.",
      ];
      if (result.qrPngPath) {
        textLines.push(
          "",
          `PNG on gateway host: ${result.qrPngPath}`,
          "Open that file on the server or copy it locally (for example scp) if the image does not show in chat.",
        );
      }
      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text: textLines.join("\n") }];
      if (pngBase64) {
        // Structured image block: many clients render this; markdown data URLs often do not.
        content.push({ type: "image", data: pngBase64, mimeType: "image/png" });
      }
      return {
        content,
        details: { qr: true, qrPngPath: result.qrPngPath },
      };
    },
  };
}
