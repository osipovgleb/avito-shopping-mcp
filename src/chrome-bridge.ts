import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { profileItemsApiUrl } from "./avito-api.js";
import { AvitoMcpError, safeError } from "./errors.js";
import { parseProfileItems } from "./parsers.js";
import type { ProfileItemsResult } from "./types.js";

export const CHROME_HOST_NAME = "com.avito_shopping_mcp.profile";
const REQUEST_TTL_MS = 5 * 60_000;
const REQUEST_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const REQUEST_FILE = /^([0-9a-f-]+)\.request\.json$/;

interface ChromeRequest {
  endpoint: string;
  createdAt: number;
  page: number;
  limit: number;
}

type ChromeResult =
  | { status: "ready"; result: ProfileItemsResult }
  | { status: "failed"; error: ReturnType<typeof safeError> };

export function chromeBridgeDirectory(): string {
  const data = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : join(homedir(), ".config");
  return join(data, "avito-shopping-mcp", "chrome-bridge");
}

export class ChromeBridge {
  constructor(private readonly directory = chromeBridgeDirectory()) {}

  async enqueue(profile: string, page: number, limit: number) {
    const request: ChromeRequest = { endpoint: profileItemsApiUrl(profile, page), page, limit, createdAt: Date.now() };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.removeExpired();
    const requestId = randomUUID();
    await this.writeJson(this.path(requestId, "request"), request);
    return this.pending(requestId);
  }

  async read(requestId: string) {
    await this.liveRequest(requestId);
    const result = await readJson<ChromeResult>(this.path(requestId, "result"));
    return result ? { requestId, ...result } : this.pending(requestId);
  }

  async claim(profile: string) {
    const seller = new URL(profileItemsApiUrl(profile, 1)).searchParams.get("sellerId");
    for (const requestId of await this.requestIds()) {
      const request = await readJson<ChromeRequest>(this.path(requestId, "request"));
      if (!request || this.expired(request) || new URL(request.endpoint).searchParams.get("sellerId") !== seller) continue;

      try {
        await writeFile(this.path(requestId, "claim"), "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const { pathname, search } = new URL(request.endpoint);
      return { requestId, endpoint: pathname + search };
    }
    return null;
  }

  async complete(requestId: string, httpStatus: number, payload: unknown): Promise<ChromeResult> {
    const request = await this.liveRequest(requestId);
    await readFile(this.path(requestId, "claim"));
    const resultPath = this.path(requestId, "result");
    let value: ChromeResult;
    try {
      if (httpStatus === 429) throw new AvitoMcpError("AVITO_RATE_LIMITED", "Avito is limiting requests. Wait before trying again.");
      if (httpStatus === 401 || httpStatus === 403 || httpStatus === 439) {
        throw new AvitoMcpError("AVITO_BLOCKED", "Open the Avito profile in Chrome and complete any access check before requesting a new page.");
      }
      if (httpStatus !== 200) throw new AvitoMcpError("REQUEST_FAILED", "Chrome could not read the Avito listings.");
      const { items, totalCount } = parseProfileItems(payload);
      const selected = items.slice(0, request.limit);
      value = { status: "ready", result: { page: request.page, totalCount, count: selected.length, items: selected } };
    } catch (error) {
      value = { status: "failed", error: safeError(error) };
    }
    try {
      await this.writeJson(resultPath, value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = await readJson<ChromeResult>(resultPath);
      if (!previous) throw error;
      return previous;
    }
  }

  private pending(requestId: string) {
    return {
      status: "awaiting_chrome" as const,
      requestId,
      message: "Ask the user to click Avito for Codex in their open Chrome tab on this seller's profile. After they click, call this tool again with requestId only.",
    };
  }

  private async liveRequest(requestId: string): Promise<ChromeRequest> {
    if (!REQUEST_ID.test(requestId)) throw new AvitoMcpError("INVALID_INPUT", "Invalid Chrome request id.");
    const request = await readJson<ChromeRequest>(this.path(requestId, "request"));
    if (!request || this.expired(request)) {
      throw new AvitoMcpError("CHROME_REQUEST_EXPIRED", "Start a new Chrome profile request.");
    }
    return request;
  }

  private expired(request: ChromeRequest): boolean {
    return Date.now() - request.createdAt >= REQUEST_TTL_MS;
  }

  private path(requestId: string, kind: "request" | "result" | "claim"): string {
    return join(this.directory, kind === "claim" ? `${requestId}.claim` : `${requestId}.${kind}.json`);
  }

  private async requestIds(): Promise<string[]> {
    try {
      const files = await readdir(this.directory);
      return files.flatMap(name => {
        const id = name.match(REQUEST_FILE)?.[1];
        return id && REQUEST_ID.test(id) ? [id] : [];
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async removeExpired(): Promise<void> {
    for (const requestId of await this.requestIds()) {
      const request = await readJson<ChromeRequest>(this.path(requestId, "request"));
      if (request && !this.expired(request)) continue;
      await Promise.all((["request", "result", "claim"] as const).map(kind => rm(this.path(requestId, kind), { force: true })));
    }
  }

  private async writeJson(path: string, value: object): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      await link(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
