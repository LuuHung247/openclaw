/**
 * Lark/Feishu Open Platform Types
 *
 * Lark is the international version of Feishu (ByteDance's enterprise collaboration platform).
 * Uses webhook for inbound events and Open API for outbound messages.
 */

/** Lark webhook event envelope */
export interface LarkWebhookEvent {
  /** Event type */
  type: string;
  /** Timestamp (ms) */
  timestamp: number;
  /** Event token for verification */
  token?: string;
  /** Challenge for URL verification */
  challenge?: string;
}

/** Lark message received event */
export interface LarkMessageEvent {
  /** Event type header */
  header: LarkEventHeader;
  /** Event data */
  event: LarkMessageData;
}

/** Lark event header */
export interface LarkEventHeader {
  /** Event ID */
  event_id: string;
  /** Event type: im.message.receive_v1 */
  event_type: string;
  /** Timestamp (ms) */
  create_time: string;
  /** Tenant key */
  tenant_key: string;
  /** App ID */
  app_id: string;
}

/** Lark message data */
export interface LarkMessageData {
  /** Message sender */
  sender: LarkSender;
  /** Message content */
  message: LarkMessage;
  /** Chat ID */
  chat_id: string;
  /** Chat type */
  chat_type: string;
  /** Message type */
  msg_type: string;
  /** Parent message ID for threads */
  parent_id?: string;
  /** Mentioned users */
  mentions?: LarkMention[];
}

/** Lark sender info */
export interface LarkSender {
  /** Sender ID */
  sender_id: LarkUserId;
  /** Sender type */
  sender_type: string;
  /** Tenant key */
  tenant_key: string;
}

/** Lark user ID */
export interface LarkUserId {
  /** User ID */
  user_id: string;
  /** Union ID (for multi-tenant apps) */
  union_id?: string;
  /** Open ID (for cross-app identification) */
  open_id: string;
}

/** Lark message content */
export interface LarkMessage {
  /** Message ID */
  message_id: string;
  /** Root message ID for threads */
  root_id?: string;
  /** Message type: text, post, interactive, etc. */
  msg_type: string;
  /** Message content (JSON string) */
  content: string;
  /** Create time (ms) */
  create_time: string;
  /** Updated time (ms) */
  update_time?: string;
  /** Deleted flag */
  deleted?: boolean;
}

/** Lark mention */
export interface LarkMention {
  /** Mentioned user ID */
  id: string;
  /** Mention key */
  key: string;
  /** Mention name */
  name: string;
  /** Mention type */
  type: string;
}

/** Lark tenant access token response */
export interface LarkTokenResponse {
  /** Response code: 0 = success */
  code: number;
  /** Response message */
  msg: string;
  /** Tenant access token */
  tenant_access_token: string;
  /** Token expiry (seconds) */
  expire: number;
}

/** Lark send message request */
export interface LarkSendMessageRequest {
  /** Receive message type */
  msg_type: "text" | "post" | "interactive" | "card";
  /** Receive ID (user_id or chat_id) */
  receive_id: string;
  /** Receive ID type */
  receive_id_type: "user_id" | "chat_id" | "open_id" | "union_id";
  /** Message content (JSON string) */
  content: string;
  /** Reply message ID (for threading) */
  reply_in_message_id?: string;
}

/** Lark send message response */
export interface LarkSendMessageResponse {
  /** Response code: 0 = success */
  code: number;
  /** Response message */
  msg: string;
  /** Sent message data */
  data: {
    /** Message ID */
    message_id: string;
    /** Message ID (alt) */
    msg_id: string;
    /** Create time (ms) */
    create_time: string;
  };
}

/** Lark API error response */
export interface LarkErrorResponse {
  /** Error code */
  code: number;
  /** Error message */
  msg: string;
  /** Error details */
  error?: {
    /** Error field */
    field?: string;
    /** Error description */
    description?: string;
  };
}

/** Lark config */
export interface LarkConfig {
  /** Lark app ID */
  appId: string;
  /** Lark app secret */
  appSecret: string;
  /** Webhook port for inbound events */
  webhookPort: number;
  /** Optional verification token */
  verificationToken?: string;
  /** Optional encrypt key */
  encryptKey?: string;
}

/** Parsed text message from Lark */
export interface LarkTextContent {
  /** Text content */
  text: string;
  /** Mentioned user IDs */
  atUsers?: string[];
}

/** Message handler callback */
export type LarkMessageHandler = (data: {
  senderId: string;
  senderName?: string;
  chatId: string;
  text: string;
  messageId: string;
  parentMessageId?: string;
}) => void | Promise<void>;
