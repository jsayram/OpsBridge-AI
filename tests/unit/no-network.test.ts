import net from "node:net";
import { describe, expect, it } from "vitest";

// The guard from tests/setup/no-network.ts is loaded for every test file.
describe("test network guard", () => {
  it("refuses fetch to any outside host before a socket opens", async () => {
    await expect(fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      /may only connect/,
    );
    await expect(fetch("https://oauth2.googleapis.com/token")).rejects.toThrow(/may only connect/);
  });
  it("refuses raw sockets to outside hosts", () => {
    expect(() => net.connect(443, "example.com")).toThrow(/may only connect/);
    expect(() => net.connect({ host: "1.1.1.1", port: 53 })).toThrow(/may only connect/);
  });
  it("still allows this machine", async () => {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.end();
        resolve();
      });
      s.on("error", reject);
    });
    server.close();
  });
});
