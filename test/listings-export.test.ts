import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MOSCOW } from "../src/avito-api.js";
import type { SearchInput } from "../src/avito-client.js";
import { AvitoMcpError } from "../src/errors.js";
import { ListingsExport } from "../src/listings-export.js";
import type { SearchItem } from "../src/types.js";

function listing(id: number, title = `Видеокарта ${id}`): SearchItem {
  return {
    id, title, price: 900, priceText: "900 ₽", url: `https://www.avito.ru/${id}`,
    location: "Москва", publishedAt: null, image: null, seller: null,
  };
}

function result(items: SearchItem[], totalCount: number, page: number) {
  return { query: "видеокарта", location: MOSCOW, sort: "default" as const, page, totalCount, count: items.length, items };
}

describe("ListingsExport", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "avito-export-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("collects 1,000 listings in one job and reports only progress metadata", async () => {
    const search = vi.fn(async ({ page = 1 }: SearchInput) => {
      const items = Array.from({ length: 50 }, (_, index) => listing((page - 1) * 50 + index + 1));
      return result(items, 1_250, page);
    });
    const exports = new ListingsExport({ search, profileItems: vi.fn() }, directory);
    const { jobId } = exports.start({ query: "видеокарта", priceMax: 1_000, startPage: 1, limit: 1_000 });
    expect(exports.status(jobId)).toMatchObject({ status: "running", written: 0 });
    await vi.waitFor(() => expect(exports.status(jobId)).toMatchObject({
      status: "completed", written: 1_000, pagesRead: 20, stopReason: "limit_reached",
    }));
    expect(search).toHaveBeenCalledTimes(20);
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ page: 20, priceMax: 1_000, limit: 50 }));
    const csv = await readFile(exports.status(jobId).csvPath!, "utf8");
    expect(csv.trimEnd().split("\r\n")).toHaveLength(1_001);
    expect(csv).toContain('1000,"Видеокарта 1000",900');
  });

  it("keeps the CSV when access fails and resumes the same page and file without duplicates", async () => {
    const search = vi.fn()
      .mockResolvedValueOnce(result([listing(1, 'Карта, "новая"\n900 ₽'), listing(2, '=1+1')], 60, 1))
      .mockRejectedValueOnce(new AvitoMcpError("SESSION_EXPIRED", "Restore the session."))
      .mockResolvedValueOnce(result([listing(2), listing(3)], 60, 2));
    const exports = new ListingsExport({ search, profileItems: vi.fn() }, directory);
    const { jobId } = exports.start({ query: "видеокарта", startPage: 1, limit: 4 });
    expect(() => exports.start({ query: "другой запрос", startPage: 1, limit: 1 }))
      .toThrow(expect.objectContaining({ code: "EXPORT_IN_PROGRESS" }));
    await vi.waitFor(() => expect(exports.status(jobId)).toMatchObject({
      status: "failed", written: 2, nextPage: 2, error: { code: "SESSION_EXPIRED" },
    }));
    const { csvPath } = exports.status(jobId);
    const partial = await readFile(csvPath!, "utf8");
    expect(partial).toContain('1,"Карта, ""новая""\n900 ₽",900');
    expect(partial).toContain(`2,"'=1+1",900`);

    expect(exports.resume(jobId)).toMatchObject({ status: "running", csvPath, written: 2 });
    await vi.waitFor(() => expect(exports.status(jobId)).toMatchObject({
      status: "completed", csvPath, written: 3, pagesRead: 2, stopReason: "results_exhausted",
    }));
    expect(search.mock.calls.map(([input]) => input.page)).toEqual([1, 2, 2]);
    const completed = await readFile(csvPath!, "utf8");
    expect(completed.startsWith(partial)).toBe(true);
    expect(completed.slice(partial.length)).toMatch(/^3,"Видеокарта 3",900[^\r]*\r\n$/);
  });
});
