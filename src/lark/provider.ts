/**
 * Lark Provider
 *
 * Main provider that combines webhook server and API client.
 * For now, just logs messages - gateway integration will be added separately.
 */

import type { ClawdisConfig } from "../config/config.js";
import { LarkClient } from "./client.js";
import type { LarkConfig, LarkMessageHandler } from "./types.js";
import { LarkWebhookServer } from "./server.js";

/** Lark provider */
export class LarkProvider {
  private webhook: LarkWebhookServer | null = null;
  private client: LarkClient | null = null;

  constructor(
    private readonly config: LarkConfig,
    private readonly messageHandler: LarkMessageHandler,
  ) {}

  /** Start Lark provider */
  async start(): Promise<void> {
    // Create API client
    this.client = new LarkClient(this.config.appId, this.config.appSecret);

    // Create webhook server
    this.webhook = new LarkWebhookServer({
      port: this.config.webhookPort,
      verificationToken: this.config.verificationToken,
      onMessage: async (data) => this.handleMessage(data),
    });

    await this.webhook.start();
    console.info(`[lark] provider started on port ${this.config.webhookPort}`);
  }

  /** Stop Lark provider */
  async stop(): Promise<void> {
    if (this.webhook) {
      await this.webhook.stop();
      this.webhook = null;
    }
    this.client = null;
    console.info("[lark] provider stopped");
  }

  /** Send message to Lark */
  async sendMessage(receiveId: string, text: string, replyTo?: string): Promise<string> {
    if (!this.client) {
      throw new Error("Lark client not initialized");
    }

    return this.client.sendText(receiveId, text, replyTo);
  }

  /** Handle incoming message from webhook */
  private async handleMessage(data: {
    senderId: string;
    senderName?: string;
    chatId: string;
    text: string;
    messageId: string;
    parentMessageId?: string;
  }): Promise<void> {
    // Delegate to external handler (will be connected to gateway)
    await this.messageHandler(data);
  }
}

/** Active Lark provider instance (singleton) */
let activeProvider: LarkProvider | null = null;

/** Get or create Lark provider from config */
export function getLarkProvider(config: LarkConfig, handler: LarkMessageHandler): LarkProvider {
  if (!activeProvider) {
    activeProvider = new LarkProvider(config, handler);
  }
  return activeProvider;
}

/** Get active Lark provider (if any) */
export function getActiveLarkProvider(): LarkProvider | null {
  return activeProvider;
}

/** Reset Lark provider (for testing/config reload) */
export function resetLarkProvider(): void {
  activeProvider = null;
}

/** Parse Lark config from ClawdisConfig */
export function parseLarkConfig(config: ClawdisConfig): LarkConfig | null {
  const larkConfig = config.lark;

  if (!larkConfig) {
    return null;
  }

  // Validate required fields
  if (!larkConfig.appId || !larkConfig.appSecret) {
    console.warn("[lark] missing required config: appId or appSecret");
    return null;
  }

  return {
    appId: larkConfig.appId,
    appSecret: larkConfig.appSecret,
    webhookPort: larkConfig.webhookPort ?? 18792,
    verificationToken: larkConfig.verificationToken,
    encryptKey: larkConfig.encryptKey,
  };
}
