import { sendMessageTelegram } from "../telegram/send.js";

export type CliDeps = {
  sendMessageTelegram: typeof sendMessageTelegram;
};

export function createDefaultDeps(): CliDeps {
  return {
    sendMessageTelegram,
  };
}
