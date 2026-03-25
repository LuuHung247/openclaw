/**
 * Lark/Feishu Open Platform API Client
 *
 * Handles outbound messages via Lark Open API with tenant access token authentication.
 */

import type {
  LarkErrorResponse,
  LarkSendMessageRequest,
  LarkSendMessageResponse,
  LarkTokenResponse,
} from "./types.js";

const LARK_TOKEN_URL =
  "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal";
const LARK_SEND_URL = "https://open.larksuite.com/open-apis/im/v1/messages";
const TOKEN_REFRESH_BUFFER_SEC = 300; // Refresh 5min before expiry

/** Lark API client with token caching */
export class LarkClient {
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  /**
   * Get valid tenant access token, refreshing if needed.
   * Token is cached and automatically refreshed before expiry.
   */
  async getAccessToken(): Promise<string> {
    // Check cache
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.token;
    }

    // Fetch new token
    const response = await fetch(LARK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Lark token request failed ${response.status}: ${text}`);
    }

    const data: LarkTokenResponse = await response.json();

    if (data.code !== 0) {
      throw new Error(`Lark token error: ${data.msg}`);
    }

    const expireSec = data.expire ?? 7200;
    const expiresAt =
      Date.now() + (expireSec - TOKEN_REFRESH_BUFFER_SEC) * 1000;

    this.cachedToken = {
      token: data.tenant_access_token,
      expiresAt,
    };

    return this.cachedToken.token;
  }

  /**
   * Send text message to Lark user or chat.
   *
   * @param receiveId - User ID or chat ID
   * @param text - Plain text content
   * @param replyTo - Optional parent message ID for threading
   */
  async sendText(
    receiveId: string,
    text: string,
    replyTo?: string,
  ): Promise<string> {
    const _token = await this.getAccessToken();

    // Detect receive_id type from format
    // Lark user_id: ou_xxxxx, chat_id: oc_xxxxx
    const receiveIdType = receiveId.startsWith("ou_")
      ? "open_id"
      : receiveId.startsWith("oc_")
        ? "chat_id"
        : "user_id";

    const content = JSON.stringify({ text });

    const request: LarkSendMessageRequest = {
      msg_type: "text",
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      content,
      reply_in_message_id: replyTo,
    };

    return this.sendMessage(request);
  }

  /**
   * Send message via Lark API.
   */
  private async sendMessage(request: LarkSendMessageRequest): Promise<string> {
    const token = await this.getAccessToken();

    // receive_id_type must be passed as query param per Lark API spec
    const url = `${LARK_SEND_URL}?receive_id_type=${encodeURIComponent(request.receive_id_type)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Lark send failed ${response.status}: ${text}`);
    }

    const data: LarkSendMessageResponse | LarkErrorResponse =
      await response.json();

    if (data.code !== 0) {
      throw new Error(`Lark send error: ${data.msg}`);
    }

    return (data as LarkSendMessageResponse).data.message_id;
  }
}
