import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { sendCommand } from "./send.js";

let testConfig: Record<string, unknown> = {};
vi.mock("../config/config.js", () => ({
  loadConfig: () => testConfig,
}));

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
  randomIdempotencyKey: () => "idem-1",
}));

const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "token-abc";
  testConfig = {};
});

afterAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
});

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const makeDeps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
  sendMessageTelegram: vi.fn(),
  ...overrides,
});

describe("sendCommand", () => {
  it("skips send on dry-run", async () => {
    const deps = makeDeps();
    await sendCommand(
      {
        to: "+1",
        message: "hi",
        dryRun: true,
      },
      deps,
      runtime,
    );
    expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
  });

  it("sends via telegram by default", async () => {
    const deps = makeDeps({
      sendMessageTelegram: vi.fn().mockResolvedValue({ messageId: "t1", chatId: "+1" }),
    });
    testConfig = { telegram: { botToken: "token-abc" } };
    await sendCommand(
      {
        to: "+1",
        message: "hi",
      },
      deps,
      runtime,
    );
    expect(deps.sendMessageTelegram).toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("t1"));
  });

  it("routes to telegram provider", async () => {
    const deps = makeDeps({
      sendMessageTelegram: vi
        .fn()
        .mockResolvedValue({ messageId: "t1", chatId: "123" }),
    });
    testConfig = { telegram: { botToken: "token-abc" } };
    await sendCommand(
      { to: "123", message: "hi", provider: "telegram" },
      deps,
      runtime,
    );
    expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({ token: "token-abc" }),
    );
  });

  it("uses config token for telegram when env is missing", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "";
    testConfig = { telegram: { botToken: "cfg-token" } };
    const deps = makeDeps({
      sendMessageTelegram: vi
        .fn()
        .mockResolvedValue({ messageId: "t1", chatId: "123" }),
    });
    await sendCommand(
      { to: "123", message: "hi", provider: "telegram" },
      deps,
      runtime,
    );
    expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({ token: "cfg-token" }),
    );
  });

  it("emits json output", async () => {
    const deps = makeDeps({
      sendMessageTelegram: vi.fn().mockResolvedValue({ messageId: "direct2", chatId: "+1" }),
    });
    testConfig = { telegram: { botToken: "token-abc" } };
    await sendCommand(
      {
        to: "+1",
        message: "hi",
        json: true,
      },
      deps,
      runtime,
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('"provider": "telegram"'),
    );
  });
});
