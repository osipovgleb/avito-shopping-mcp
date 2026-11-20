import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvitoBrowserSession, RATE_LIMIT_BACKOFF_MINUTES } from "../src/browser-session.js";
import type { RuntimeConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";
import type { PersistedSession } from "../src/session-store.js";
import { textFixture } from "./fixture.js";

const MS_PER_MINUTE = 60_000;
const PROBE_URL = "https://www.avito.ru/web/1/slocations?limit=1&q=x";

const avito = vi.hoisted(() => ({
  evaluate: vi.fn(),
  goto: vi.fn(async () => null),
  title: vi.fn(async () => "Авито"),
  verifiedVisible: vi.fn(async () => false),
  waitForFunction: vi.fn(async () => undefined),
  waitForLoadState: vi.fn(async () => undefined),
  launch: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock("playwright", () => {
  const page = {
    goto: avito.goto,
    waitForTimeout: async () => undefined,
    waitForLoadState: avito.waitForLoadState,
    waitForFunction: avito.waitForFunction,
    isClosed: () => false,
    title: avito.title,
    getByText: () => ({ first: () => ({ isVisible: avito.verifiedVisible }) }),
    waitForEvent: async () => { throw new Error("Timeout"); },
    evaluate: avito.evaluate,
  };
  const context = {
    newPage: async () => page,
    close: async () => undefined,
    storageState: async () => ({ cookies: [], origins: [] }),
  };
  const browser = {
    newContext: async () => context,
    close: avito.close,
    isConnected: () => true,
    on: () => browser,
  };
  avito.launch.mockResolvedValue(browser);
  return { chromium: { launch: avito.launch }, errors: { TimeoutError: Error } };
});

function storedSession(createdAt: Date): PersistedSession {
  return {
    schemaVersion: 1,
    createdAt: createdAt.toISOString(),
    browserChannel: "chrome",
    userAgent: "test",
    storageState: { cookies: [], origins: [] },
  };
}

describe("AvitoBrowserSession", () => {
  let stateDir: string;
  let store: SessionStore;
  let session: AvitoBrowserSession;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "avito-mcp-"));
    const config: RuntimeConfig = {
      browserChannel: "chrome",
      stateDir,
      stateFile: join(stateDir, "session.json"),
      requestTimeoutMs: 1_000,
      minimumRequestIntervalMs: 1,
      idleTimeoutMs: MS_PER_MINUTE,
      navigationTimeoutMs: 1_000,
    };
    store = new SessionStore(config.stateFile);
    await store.save(storedSession(new Date(Date.now() - MS_PER_MINUTE)));
    session = new AvitoBrowserSession(config);
    vi.spyOn(Math, "random").mockReturnValue(0);
    avito.evaluate.mockReset();
    avito.goto.mockClear();
    avito.title.mockClear();
    avito.verifiedVisible.mockClear();
    avito.waitForFunction.mockClear();
    avito.launch.mockClear();
    avito.close.mockClear();
    avito.waitForLoadState.mockClear();
    avito.evaluate.mockResolvedValueOnce({ status: 429, text: textFixture("block-403-too-many-requests.json"), url: PROBE_URL });
  });

  afterEach(async () => {
    await session.close();
    vi.restoreAllMocks();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("fails fast after a rate limit without contacting Avito", async () => {
    await expect(session.requestJson(PROBE_URL)).rejects.toMatchObject({ code: "AVITO_RATE_LIMITED" });

    await expect(session.requestJson(PROBE_URL)).rejects.toMatchObject({
      code: "AVITO_RATE_LIMITED",
      message: expect.stringContaining(`${RATE_LIMIT_BACKOFF_MINUTES} more minutes`),
    });
    expect(avito.evaluate).toHaveBeenCalledTimes(1);
  });

  it("reports a browser-side failure as a failed request with its reason", async () => {
    avito.evaluate.mockReset();
    avito.evaluate.mockRejectedValueOnce(new Error("page.evaluate: Target page, context or browser has been closed\nCall log: …"));

    await expect(session.requestJson(PROBE_URL)).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      message: "Avito request failed: page.evaluate: Target page, context or browser has been closed",
    });
  });

  it("retries once after the page navigates away mid-request", async () => {
    avito.evaluate.mockReset();
    avito.evaluate
      .mockRejectedValueOnce(new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation"))
      .mockResolvedValueOnce({ status: 200, text: "{}", url: PROBE_URL });

    await expect(session.requestJson(PROBE_URL)).resolves.toEqual({});
    expect(avito.evaluate).toHaveBeenCalledTimes(2);
    expect(avito.waitForLoadState).toHaveBeenCalledWith("load", expect.anything());
  });

  it("waits for the home page network to go idle before the first request", async () => {
    avito.evaluate.mockReset();
    avito.waitForLoadState.mockRejectedValueOnce(new Error("Timeout exceeded"));
    avito.evaluate.mockResolvedValueOnce({ status: 200, text: "{}", url: PROBE_URL });

    await expect(session.requestJson(PROBE_URL)).resolves.toEqual({});
    expect(avito.waitForLoadState).toHaveBeenCalledWith("networkidle", expect.anything());
  });

  it("counts response time toward the gap between consecutive request starts", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    avito.evaluate.mockReset().mockImplementation(async () => {
      now += 10;
      return { status: 200, text: "{}", url: PROBE_URL };
    });

    await Promise.all([session.requestJson(PROBE_URL), session.requestJson(PROBE_URL)]);

    expect(avito.evaluate).toHaveBeenCalledTimes(2);
    expect(timeout).not.toHaveBeenCalledWith(expect.any(Function), 1);
  });

  it("uses the requested base interval and keeps the random delay", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(Math.random).mockReturnValue(0.5);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    avito.evaluate.mockReset().mockImplementation(async () => {
      now += 12_985;
      return { status: 200, text: "{}", url: PROBE_URL };
    });

    await session.requestJson(PROBE_URL, 12);
    await session.requestJson(PROBE_URL, 12);

    expect(avito.evaluate).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 15);
  });

  it("resumes once a newer session is stored", async () => {
    await expect(session.requestJson(PROBE_URL)).rejects.toMatchObject({ code: "AVITO_RATE_LIMITED" });
    await store.save(storedSession(new Date(Date.now() + 1)));
    avito.evaluate.mockResolvedValueOnce({ status: 200, text: "{}", url: PROBE_URL });

    await expect(session.requestJson(PROBE_URL)).resolves.toEqual({});
  });

  it("reports pending verification and saves a single setup once the search API works", async () => {
    const existing = await store.load();
    const probe = Promise.withResolvers<{ status: number; text: string; url: string }>();
    avito.evaluate.mockReset().mockReturnValueOnce(probe.promise).mockResolvedValueOnce("new-test-agent");

    const setup = session.setup(1_000);
    expect(session.getSetupStatus()).toMatchObject({ status: "pending", message: expect.stringContaining("captcha") });
    expect(session.setup(1_000)).toBe(setup);
    await expect(session.requestJson(PROBE_URL)).rejects.toMatchObject({ code: "SESSION_SETUP_IN_PROGRESS" });
    expect(await store.load()).toEqual(existing);

    probe.resolve({ status: 200, text: '{"totalCount":0,"catalog":{"items":[]}}', url: PROBE_URL });
    const result = await setup;

    expect(avito.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ headless: false }));
    expect(avito.close).toHaveBeenCalledOnce();
    expect(session.getSetupStatus()).toEqual({ status: "ready", session: result });
    expect(await store.load()).toMatchObject({ createdAt: result.createdAt, userAgent: "new-test-agent" });
  });

  it("preserves the previous session if the search probe returns HTML with status 200", async () => {
    const existing = await store.load();
    avito.evaluate.mockReset().mockResolvedValueOnce({ status: 200, text: "<html></html>", url: PROBE_URL });

    await expect(session.setup(1_000)).rejects.toMatchObject({ code: "AVITO_BLOCKED" });
    expect(session.getSetupStatus()).toMatchObject({ status: "failed", error: { code: "AVITO_BLOCKED" } });
    expect(await store.load()).toEqual(existing);
    expect(avito.close).toHaveBeenCalledOnce();
  });

  it("reopens Avito once in the same window when a passed verification gets stuck redirecting", async () => {
    avito.title.mockResolvedValueOnce("Доступ ограничен: проблема с IP");
    avito.verifiedVisible.mockResolvedValueOnce(true);
    avito.waitForFunction.mockRejectedValueOnce(new Error("Timeout exceeded"));
    avito.evaluate.mockReset()
      .mockResolvedValueOnce({ status: 200, text: '{"totalCount":0,"catalog":{"items":[]}}', url: PROBE_URL })
      .mockResolvedValueOnce("verified-test-agent");

    const report = vi.fn();
    const result = await session.setup(1_000, report);

    expect(report).toHaveBeenCalledWith(expect.stringContaining("did not redirect"));
    expect(avito.goto).toHaveBeenCalledTimes(2);
    expect(avito.launch).toHaveBeenCalledOnce();
    expect(avito.close).toHaveBeenCalledOnce();
    expect(await store.load()).toMatchObject({ createdAt: result.createdAt, userAgent: "verified-test-agent" });
  });
});
