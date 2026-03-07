/**
 * Gateway-layer constants shared across server, CLI, and client modules.
 */

/** Default WebSocket port for the gateway server. */
export const GATEWAY_DEFAULT_PORT = 18789;

/** Default local WebSocket URL used by clients. */
export const GATEWAY_DEFAULT_WS_URL = `ws://127.0.0.1:${GATEWAY_DEFAULT_PORT}`;

/** Default local HTTP base URL used by hook clients. */
export const GATEWAY_DEFAULT_HTTP_URL = `http://127.0.0.1:${GATEWAY_DEFAULT_PORT}`;
