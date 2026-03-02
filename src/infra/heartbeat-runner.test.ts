import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import * as replyModule from "../auto-reply/reply.js";
import type { ClawdisConfig } from "../config/config.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatPrompt,
  runHeartbeatOnce,
} from "./heartbeat-runner.js";

describe("resolveHeartbeatIntervalMs", () => {
  it("returns null when unset or invalid", () => {
    expect(resolveHeartbeatIntervalMs({})).toBeNull();
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "0m" } } }),
    ).toBeNull();
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "oops" } } }),
    ).toBeNull();
  });

  it("parses duration strings with minute defaults", () => {
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "5m" } } }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "5" } } }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "2h" } } }),
    ).toBe(2 * 60 * 60_000);
  });
});

describe("resolveHeartbeatPrompt", () => {
  it("uses the default prompt when unset", () => {
    expect(resolveHeartbeatPrompt({})).toBe(HEARTBEAT_PROMPT);
  });

  it("uses a trimmed override when configured", () => {
    const cfg: ClawdisConfig = {
      agent: { heartbeat: { prompt: "  ping  " } },
    };
    expect(resolveHeartbeatPrompt(cfg)).toBe("ping");
  });
});

describe("resolveHeartbeatDeliveryTarget", () => {
  const baseEntry = {
    sessionId: "sid",
    updatedAt: Date.now(),
  };

  it("respects target none", () => {
    const cfg: ClawdisConfig = {
      agent: { heartbeat: { target: "none" } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "none",
      reason: "target-none",
    });
  });

  it("uses last telegram route by default", () => {
    const cfg: ClawdisConfig = {};
    const entry = {
      ...baseEntry,
      lastChannel: "telegram" as const,
      lastTo: "123456",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "telegram",
      to: "123456",
    });
  });

  it("skips when last route is webchat", () => {
    const cfg: ClawdisConfig = {};
    const entry = {
      ...baseEntry,
      lastChannel: "webchat" as const,
      lastTo: "web",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "none",
      reason: "no-target",
    });
  });

  it("keeps explicit telegram targets", () => {
    const cfg: ClawdisConfig = {
      agent: { heartbeat: { target: "telegram", to: "123" } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "telegram",
      to: "123",
    });
  });
});

describe("runHeartbeatOnce", () => {
  it("uses the last non-empty payload for delivery", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            main: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "telegram",
              lastTo: "123456",
            },
          },
          null,
          2,
        ),
      );

      const cfg: ClawdisConfig = {
        agent: {
          heartbeat: { every: "5m", target: "telegram", to: "123456" },
        },
        session: { store: storePath },
      };

      replySpy.mockResolvedValue([
        { text: "Let me check..." },
        { text: "Final alert" },
      ]);
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "123456",
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          sendTelegram,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        "123456",
        "Final alert",
        expect.any(Object),
      );
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
