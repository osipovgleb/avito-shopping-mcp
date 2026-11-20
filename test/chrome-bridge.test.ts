import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { ChromeBridge } from "../src/chrome-bridge.js";

const PROFILE = "https://www.avito.ru/user/synthetic-seller/profile";
const LISTINGS = {
  totalCount: 3,
  catalog: { items: [{
    type: "item",
    id: 123,
    title: "Тестовое объявление",
    urlPath: "/123?context=test",
    priceDetailed: { value: 700, fullString: "700 ₽" },
    location: { name: "Санкт-Петербург" },
    privateField: "should stay in the tab",
  }] },
};

describe("Chrome profile bridge", () => {
  it("hands off one request to the matching tab and returns listings to another MCP instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "avito-chrome-test-"));
    try {
      const mcp = new ChromeBridge(directory);
      const host = new ChromeBridge(directory);
      const { requestId } = await mcp.enqueue(PROFILE, 2, 1);
      expect(await host.claim("https://www.avito.ru/user/another-seller/profile")).toBeNull();
      expect(await mcp.read(requestId)).toMatchObject({ status: "awaiting_chrome" });

      const claims = await Promise.all([host.claim(PROFILE), host.claim(PROFILE)]);
      const [claimed] = claims.filter(value => value !== null);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claimed).toMatchObject({ requestId, endpoint: expect.stringContaining("sellerId=synthetic-seller") });
      const result = await host.complete(requestId, 200, LISTINGS);
      expect(result).toEqual({
        status: "ready",
        result: {
          page: 2,
          totalCount: 3,
          count: 1,
          items: [{ id: 123, title: "Тестовое объявление", price: 700, priceText: "700 ₽", location: "Санкт-Петербург", url: "https://www.avito.ru/123" }],
        },
      });
      expect(await host.complete(requestId, 439, undefined)).toEqual(result);
      expect(await new ChromeBridge(directory).read(requestId)).toEqual({ requestId, ...result });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the current page origin and sends selected listing fields from the extension", async () => {
    const script = await readFile(new URL("../chrome-extension/service-worker.js", import.meta.url), "utf8");
    const fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => LISTINGS,
    });
    const globals = { chrome: { action: { onClicked: { addListener: vi.fn() } } }, location: new URL(PROFILE), URL, AbortSignal, fetch };
    const result = await runInNewContext(
      script + '\nfetchListings("/web/1/profile/items?sellerId=synthetic-seller");',
      globals,
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      new URL("https://www.avito.ru/web/1/profile/items?sellerId=synthetic-seller"),
      expect.objectContaining({ credentials: "same-origin", redirect: "error" }),
    );
    expect(result.payload.catalog.items[0]).toMatchObject({ id: 123 });
    expect(result.payload.catalog.items[0]).not.toHaveProperty("privateField");

    await expect(runInNewContext(script + '\nfetchListings("/web/1/profile/items?sellerId=other-seller");', { ...globals }))
      .resolves.toEqual({ httpStatus: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
