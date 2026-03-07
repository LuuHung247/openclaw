import { ProxyAgent } from "undici";

export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const base = init ? { ...init } : {};
    // `dispatcher` is an undici extension not in standard RequestInit
    return fetch(input, { ...base, dispatcher: agent } as RequestInit);
  };
}
