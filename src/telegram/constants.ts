/**
 * Shared constants for the Telegram module.
 */

/** Matches Telegram's MarkdownV1 parse errors — used to trigger plain-text fallback. */
export const PARSE_ERR_RE =
  /can't parse entities|parse entities|find end of the entity/i;

/** Default text chunk limit for Telegram messages (Bot API max is 4096 chars). */
export const TEXT_CHUNK_LIMIT = 4096;
