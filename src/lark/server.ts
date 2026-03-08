/**
 * Lark/Feishu Webhook Server
 *
 * HTTP server for receiving inbound events from Lark platform.
 * Parses JSON events and forwards to agent session router.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { LarkMessageEvent, LarkMessageHandler, LarkTextContent, LarkWebhookEvent } from "./types.js";


/** Lark webhook server options */
export interface LarkServerOptions {
  /** Listen port */
  port: number;
  /** Verification token (optional) */
  verificationToken?: string;
  /** Message handler */
  onMessage: LarkMessageHandler;
}

/** Lark webhook HTTP server */
export class LarkWebhookServer {
  private server: Server | null = null;

  constructor(private readonly options: LarkServerOptions) {}

  /** Start webhook server */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", (err) => {
        reject(new Error(`Lark webhook server error: ${err.message}`));
      });

      this.server.listen(this.options.port, () => {
        console.info(`[lark] webhook listening on port ${this.options.port}`);
        resolve();
      });
    });
  }

  /** Stop webhook server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        console.info("[lark] webhook server stopped");
        resolve();
      });
    });
  }

  /** Handle incoming HTTP request */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Only accept POST
    if (req.method !== "POST") {
      res.writeHead(405).end("Method Not Allowed");
      return;
    }

    // Read body
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }

    // Parse JSON
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }

    // Handle URL verification challenge
    if (this.isChallenge(data)) {
      this.handleChallenge(data, res);
      return;
    }

    // Handle message event (v2 format: header + event)
    if (this.isMessageEvent(data)) {
      try {
        await this.handleMessage(data);
        res.writeHead(200).end(JSON.stringify({ code: 0, msg: "success" }));
      } catch (err) {
        console.error("[lark] message handler error:", err);
        res.writeHead(500).end(JSON.stringify({ code: 500, msg: "Internal error" }));
      }
      return;
    }

    // Handle message event (v1 legacy format: { type: "message", event: {...} })
    if (this.isLegacyMessageEvent(data)) {
      try {
        await this.handleLegacyMessage(data as LarkLegacyEvent);
        res.writeHead(200).end(JSON.stringify({ code: 0, msg: "success" }));
      } catch (err) {
        console.error("[lark] legacy message handler error:", err);
        res.writeHead(500).end(JSON.stringify({ code: 500, msg: "Internal error" }));
      }
      return;
    }

    // Unknown event type
    console.warn("[lark] unknown event type:", data);
    res.writeHead(200).end(JSON.stringify({ code: 0, msg: "unknown" }));
  }

  /** Check if event is URL verification challenge */
  private isChallenge(data: unknown): data is { challenge: string; token?: string } {
    return (
      typeof data === "object" &&
      data !== null &&
      "challenge" in data &&
      typeof (data as { challenge: string }).challenge === "string"
    );
  }

  /** Handle URL verification challenge */
  private handleChallenge(
    data: { challenge: string; token?: string },
    res: ServerResponse,
  ): void {
    // Verify token if configured
    if (this.options.verificationToken && data.token !== this.options.verificationToken) {
      console.warn("[lark] invalid verification token");
      res.writeHead(403).end("Invalid token");
      return;
    }

    // Return challenge
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ challenge: data.challenge }));
    console.info("[lark] URL verification successful");
  }

  /** Check if event is message event (v2 format) */
  private isMessageEvent(data: unknown): data is LarkMessageEvent {
    return (
      typeof data === "object" &&
      data !== null &&
      "header" in data &&
      "event" in data &&
      (data as LarkMessageEvent).header.event_type === "im.message.receive_v1"
    );
  }

  /** Check if event is legacy v1 message event
   * v1 format: top-level type="event_callback", inner event.type="message"
   */
  private isLegacyMessageEvent(data: unknown): boolean {
    const d = data as Record<string, unknown>;
    if (typeof d !== "object" || d === null) return false;
    if (typeof d.event !== "object" || d.event === null) return false;
    const evt = d.event as Record<string, unknown>;
    return (d.type === "event_callback" || d.type === "message") && evt.type === "message";
  }

  /** Handle message event (v2) */
  private async handleMessage(event: LarkMessageEvent): Promise<void> {
    const { sender, message, chat_id, parent_id } = event.event;
    const content = this.parseMessageContent(message.content, message.msg_type);

    await this.options.onMessage({
      senderId: sender.sender_id.open_id || sender.sender_id.user_id,
      senderName: sender.sender_id.user_id,
      chatId: chat_id,
      text: content.text,
      messageId: message.message_id,
      parentMessageId: parent_id || message.root_id,
    });
  }

  /** Handle legacy v1 message event */
  private async handleLegacyMessage(data: LarkLegacyEvent): Promise<void> {
    const e = data.event;
    const text = e.text_without_at_bot ?? e.text ?? "";
    const chatId = e.open_chat_id ?? "";
    const senderId = e.open_id ?? e.user_open_id ?? "";
    const messageId = e.open_message_id ?? e.message_id ?? "";

    await this.options.onMessage({
      senderId,
      chatId,
      text,
      messageId,
    });
  }

  /** Parse message content based on type */
  private parseMessageContent(contentJson: string, msgType: string): LarkTextContent {
    if (msgType !== "text") {
      return { text: `[Unsupported message type: ${msgType}]` };
    }

    try {
      const content = JSON.parse(contentJson) as LarkTextContent;
      return content;
    } catch {
      return { text: "" };
    }
  }
}

/** Lark v1 legacy event structure */
interface LarkLegacyEvent {
  type: string;
  event: {
    text?: string;
    text_without_at_bot?: string;
    open_chat_id?: string;
    open_id?: string;
    user_open_id?: string;
    open_message_id?: string;
    message_id?: string;
    msg_type?: string;
    chat_type?: string;
  };
}
