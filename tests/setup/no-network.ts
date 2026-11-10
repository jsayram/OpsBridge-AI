// Every test process loads this first (vitest setupFiles). It refuses any socket that isn't to
// this machine, so no test can reach a real provider by mistake. P4 once sent one request to
// Google from a test (D-060); this makes that class of mistake fail loudly instead.
import net from "node:net";
import tls from "node:tls";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", ""]);

export class NetworkBlockedError extends Error {
  constructor(host: string) {
    super(`Test tried to reach ${host}. Tests may only connect to this machine.`);
    this.name = "NetworkBlockedError";
  }
}

// biome-ignore lint/suspicious/noExplicitAny: net.connect has many overloads
const hostOf = (args: any[]): string | null => {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    if (typeof first.path === "string") return null; // Unix socket
    return String(first.host ?? first.hostname ?? "localhost");
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return null; // path
  return typeof args[1] === "string" ? args[1] : "localhost";
};

const guard = (host: string | null) => {
  if (host !== null && !LOCAL.has(host.replace(/^\[|\]$/g, "")))
    throw new NetworkBlockedError(host);
};

const originalConnect = net.Socket.prototype.connect;
// biome-ignore lint/suspicious/noExplicitAny: wrapping an overloaded method
net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
  guard(hostOf(args));
  // biome-ignore lint/suspicious/noExplicitAny: forwarding the same overloaded arguments
  return (originalConnect as any).apply(this, args);
} as typeof net.Socket.prototype.connect;

const originalTls = tls.connect;
// biome-ignore lint/suspicious/noExplicitAny: wrapping an overloaded function
(tls as any).connect = (...args: any[]) => {
  guard(hostOf(args));
  // biome-ignore lint/suspicious/noExplicitAny: forwarding the same overloaded arguments
  return (originalTls as any)(...args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  guard(url.hostname);
  return originalFetch(input, init);
}) as typeof fetch;
