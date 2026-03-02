import { confirm, multiselect, note, text } from "@clack/prompts";
import chalk from "chalk";

import type { ClawdisConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { detectBinary, guardCancel } from "./onboard-helpers.js";
import type { ProviderChoice } from "./onboard-types.js";

function noteProviderPrimer(): void {
  note(
    [
      "Telegram: Bot API (token from @BotFather), replies via your bot.",
      "iMessage: local imsg CLI (JSON-RPC over stdio) reading Messages DB.",
    ].join("\n"),
    "How providers work",
  );
}

function noteTelegramTokenHelp(): void {
  note(
    [
      "1) Open Telegram and chat with @BotFather",
      "2) Run /newbot (or /mybots)",
      "3) Copy the token (looks like 123456:ABC...)",
      "Tip: you can also set TELEGRAM_BOT_TOKEN in your env.",
    ].join("\n"),
    "Telegram bot token",
  );
}

export async function setupProviders(
  cfg: ClawdisConfig,
  runtime: RuntimeEnv,
  options?: { allowDisable?: boolean },
): Promise<ClawdisConfig> {
  const telegramEnv = Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
  const telegramConfigured = Boolean(
    telegramEnv || cfg.telegram?.botToken || cfg.telegram?.tokenFile,
  );
  const imessageConfigured = Boolean(
    cfg.imessage?.cliPath || cfg.imessage?.dbPath || cfg.imessage?.allowFrom,
  );
  const imessageCliPath = cfg.imessage?.cliPath ?? "imsg";
  const imessageCliDetected = await detectBinary(imessageCliPath);

  note(
    [
      `Telegram: ${
        telegramConfigured
          ? chalk.green("configured")
          : chalk.yellow("needs token")
      }`,
      `iMessage: ${
        imessageConfigured
          ? chalk.green("configured")
          : chalk.yellow("needs setup")
      }`,
      `imsg: ${
        imessageCliDetected ? chalk.green("found") : chalk.red("missing")
      } (${imessageCliPath})`,
    ].join("\n"),
    "Provider status",
  );

  const shouldConfigure = guardCancel(
    await confirm({
      message: "Configure chat providers now?",
      initialValue: true,
    }),
    runtime,
  );
  if (!shouldConfigure) return cfg;

  noteProviderPrimer();

  const selection = guardCancel(
    await multiselect({
      message: "Select providers",
      options: [
        {
          value: "telegram",
          label: "Telegram (Bot API)",
          hint: telegramConfigured ? "configured" : "needs token",
        },
        {
          value: "imessage",
          label: "iMessage (imsg)",
          hint: imessageCliDetected ? "imsg found" : "imsg missing",
        },
      ],
    }),
    runtime,
  ) as ProviderChoice[];

  let next = cfg;

  if (selection.includes("telegram")) {
    let token: string | null = null;
    if (!telegramConfigured) {
      noteTelegramTokenHelp();
    }
    if (telegramEnv && !cfg.telegram?.botToken) {
      const keepEnv = guardCancel(
        await confirm({
          message: "TELEGRAM_BOT_TOKEN detected. Use env var?",
          initialValue: true,
        }),
        runtime,
      );
      if (keepEnv) {
        next = {
          ...next,
          telegram: {
            ...next.telegram,
            enabled: true,
          },
        };
      } else {
        token = String(
          guardCancel(
            await text({
              message: "Enter Telegram bot token",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
            runtime,
          ),
        ).trim();
      }
    } else if (cfg.telegram?.botToken) {
      const keep = guardCancel(
        await confirm({
          message: "Telegram token already configured. Keep it?",
          initialValue: true,
        }),
        runtime,
      );
      if (!keep) {
        token = String(
          guardCancel(
            await text({
              message: "Enter Telegram bot token",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
            runtime,
          ),
        ).trim();
      }
    } else {
      token = String(
        guardCancel(
          await text({
            message: "Enter Telegram bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
          runtime,
        ),
      ).trim();
    }

    if (token) {
      next = {
        ...next,
        telegram: {
          ...next.telegram,
          enabled: true,
          botToken: token,
        },
      };
    }
  }

  if (selection.includes("imessage")) {
    let resolvedCliPath = imessageCliPath;
    if (!imessageCliDetected) {
      const entered = guardCancel(
        await text({
          message: "imsg CLI path",
          initialValue: resolvedCliPath,
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
        runtime,
      );
      resolvedCliPath = String(entered).trim();
      if (!resolvedCliPath) {
        note("imsg CLI path required to enable iMessage.", "iMessage");
      }
    }

    if (resolvedCliPath) {
      next = {
        ...next,
        imessage: {
          ...next.imessage,
          enabled: true,
          cliPath: resolvedCliPath,
        },
      };
    }

    note(
      [
        "Ensure Clawdis has Full Disk Access to Messages DB.",
        "Grant Automation permission for Messages when prompted.",
        "List chats with: imsg chats --limit 20",
      ].join("\n"),
      "iMessage next steps",
    );
  }

  if (options?.allowDisable) {
    if (!selection.includes("telegram") && telegramConfigured) {
      const disable = guardCancel(
        await confirm({
          message: "Disable Telegram provider?",
          initialValue: false,
        }),
        runtime,
      );
      if (disable) {
        next = {
          ...next,
          telegram: { ...next.telegram, enabled: false },
        };
      }
    }

    if (!selection.includes("imessage") && imessageConfigured) {
      const disable = guardCancel(
        await confirm({
          message: "Disable iMessage provider?",
          initialValue: false,
        }),
        runtime,
      );
      if (disable) {
        next = {
          ...next,
          imessage: { ...next.imessage, enabled: false },
        };
      }
    }
  }

  return next;
}
