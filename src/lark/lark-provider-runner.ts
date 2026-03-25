/**
 * Lark Provider Runner
 *
 * Starts the Lark webhook server and routes inbound messages to the agent
 * via getReplyFromConfig — mirrors the Telegram bot.ts pattern.
 */

import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { loadConfig } from "../config/config.js";
import type { LarkProvider } from "./provider.js";
import {
  getLarkProvider,
  parseLarkConfig,
  resetLarkProvider,
} from "./provider.js";

/** Start Lark provider and route messages to agent */
export async function startLarkProvider(): Promise<LarkProvider> {
  const cfg = loadConfig();
  const larkCfg = parseLarkConfig(cfg);

  if (!larkCfg) {
    throw new Error(
      "Lark config missing or invalid (appId + appSecret required)",
    );
  }

  const provider = getLarkProvider(larkCfg, async (data) => {
    const { senderId, senderName, chatId, text, messageId } = data;

    // Skip events without a valid chat/sender or text
    if (!chatId || !senderId || !text) {
      console.info(`[lark] skipping event: chat=${chatId} from=${senderId}`);
      return;
    }

    console.info(
      `[lark] inbound: from=${senderId} chat=${chatId} text="${text.slice(0, 80)}"`,
    );

    const ctx = {
      Body: text,
      From: `lark:${senderId}`,
      To: chatId,
      SenderName: senderName,
      MessageSid: messageId,
      Surface: "lark",
      SessionKey: "lark",
    };

    const sendReply = async (replyText: string) => {
      try {
        await provider.sendMessage(chatId, replyText, messageId);
      } catch (err) {
        console.error("[lark] send reply error:", err);
      }
    };

    const sendBlockReply = (payload: ReplyPayload) => {
      if (!payload?.text) return;
      void sendReply(payload.text);
    };

    let replyResult: ReplyPayload | ReplyPayload[] | undefined;
    try {
      replyResult = await getReplyFromConfig(ctx, {
        onBlockReply: sendBlockReply,
      });
    } catch (err) {
      console.error("[lark] getReplyFromConfig error:", err);
      return;
    }

    if (!replyResult) return;

    const replies = Array.isArray(replyResult) ? replyResult : [replyResult];
    for (const reply of replies) {
      if (!reply?.text) continue;
      await sendReply(reply.text);
    }
  });

  await provider.start();
  return provider;
}

/** Stop Lark provider */
export async function stopLarkProvider(): Promise<void> {
  const { getActiveLarkProvider } = await import("./provider.js");
  const provider = getActiveLarkProvider();
  if (provider) {
    await provider.stop();
    resetLarkProvider();
  }
}
