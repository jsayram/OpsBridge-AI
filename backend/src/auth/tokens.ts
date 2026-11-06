import type { Bindings } from "../env";

export const DEMO_COOKIE = "__Host-obs_demo";
const TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export const newDemoToken = () => toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));

// Rejecting bad shapes here means a forged cookie can't wake the database.
export const isDemoTokenShape = (token: string) => TOKEN_SHAPE.test(token);

export const hashToken = async (token: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));

const hmac = async (secret: string, value: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
};

// Keyed, so the quota table holds no address and can't be reversed by hashing all of IPv4.
export const ipBucket = (secret: string, ip: string) => hmac(secret, ip);

export const ipBucketKey = async (env: Bindings, ip: string) =>
  env.IP_HASH_KEY ? toBase64Url(await hmac(env.IP_HASH_KEY, ip)) : "unkeyed";

export const hashHex = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
