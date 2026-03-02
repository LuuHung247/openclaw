import chalk from "chalk";
import { type ClawdisConfig, loadConfig } from "../config/config.js";
import { resolveTelegramToken } from "../telegram/token.js";

export async function buildProviderSummary(
  cfg?: ClawdisConfig,
): Promise<string[]> {
  const effective = cfg ?? loadConfig();
  const lines: string[] = [];

  const telegramEnabled = effective.telegram?.enabled !== false;
  if (!telegramEnabled) {
    lines.push(chalk.cyan("Telegram: disabled"));
  } else {
    const { token: telegramToken } = resolveTelegramToken(effective);
    const telegramConfigured = Boolean(telegramToken?.trim());
    lines.push(
      telegramConfigured
        ? chalk.green("Telegram: configured")
        : chalk.cyan("Telegram: not configured"),
    );
  }

  const imessageEnabled = effective.imessage?.enabled !== false;
  if (!imessageEnabled) {
    lines.push(chalk.cyan("iMessage: disabled"));
  } else {
    const imessageConfigured = Boolean(effective.imessage);
    lines.push(
      imessageConfigured
        ? chalk.green("iMessage: configured")
        : chalk.cyan("iMessage: not configured"),
    );
  }

  return lines;
}

export function formatAge(ms: number): string {
  if (ms < 0) return "unknown";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
