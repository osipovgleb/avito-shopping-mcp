import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

import { PROFILE_ITEMS_PAGE_SIZE, profileItemsApiUrl } from "./avito-api.js";
import { MAX_SEARCH_LIMIT, validSearchQuery } from "./avito-client.js";
import type { AvitoClient, SearchInput } from "./avito-client.js";
import { AvitoMcpError, safeError } from "./errors.js";
import type { ListingCondition, ListingConditionFilter, ProfileItem, SearchItem } from "./types.js";

type Listing = ProfileItem | SearchItem;
type ExportInput = (Omit<SearchInput, "page" | "limit" | "requestIntervalSeconds" | "condition"> | { profile: string }) & {
  startPage: number;
  limit: number;
  requestIntervalSeconds?: number | undefined;
  condition?: ListingConditionFilter | undefined;
};

interface ExportStatus {
  jobId: string;
  status: "running" | "completed" | "failed";
  requested: number;
  written: number;
  pagesRead: number;
  nextPage: number;
  csvPath: string | null;
  stopReason?: "limit_reached" | "results_exhausted" | "repeated_page";
  error?: ReturnType<typeof safeError>;
}

interface ExportJob {
  input: ExportInput;
  progress: ExportStatus;
  seen: Set<number>;
  pages: Set<string>;
  conditions: Map<number, ListingCondition | null>;
  lastPage?: number;
}

const CSV_HEADER =
  "id,title,price,price_text,url,location,published_at,image,seller_name,seller_url,seller_rating,description,has_vas,is_xl,condition\r\n";

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return "";
  if (typeof value !== "string") return String(value);
  // Keep marketplace text literal when the CSV is opened in a spreadsheet editor.
  const literal = /^[\t\r\n]|^\s*[=+\-@＝＋－＠]/u.test(value) ? "'" + value : value;
  return '"' + literal.replaceAll('"', '""') + '"';
}

function csvRow(item: Listing): string {
  const search = "publishedAt" in item ? item : undefined;
  return [
    item.id, item.title, item.price, item.priceText, item.url, item.location,
    search?.publishedAt ?? null, search?.image ?? null, search?.seller?.name ?? null,
    search?.seller?.url ?? null, search?.seller?.rating ?? null, item.description ?? null,
    item.hasVas ?? null, item.isXl ?? null, item.condition ?? null,
  ].map(csvCell).join(",") + "\r\n";
}

export class ListingsExport {
  private readonly jobs = new Map<string, ExportJob>();
  private active: ExportStatus | undefined;

  constructor(
    private readonly client: Pick<AvitoClient, "search" | "profileItems" | "listingCondition">,
    private readonly directory: string,
  ) {}

  start(input: ExportInput): ExportStatus {
    this.ensureIdle();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new AvitoMcpError("INVALID_INPUT", "Export limit must be a positive integer.");
    }
    if ("profile" in input) profileItemsApiUrl(input.profile, input.startPage);
    else validSearchQuery(input);

    const progress: ExportStatus = {
      jobId: randomUUID(),
      status: "running",
      requested: input.limit,
      written: 0,
      pagesRead: 0,
      nextPage: input.startPage,
      csvPath: null,
    };
    const job: ExportJob = { input, progress, seen: new Set(), pages: new Set(), conditions: new Map() };
    this.jobs.set(progress.jobId, job);
    return this.run(job);
  }

  status(jobId: string): ExportStatus {
    return { ...this.getJob(jobId).progress };
  }

  resume(jobId: string): ExportStatus {
    this.ensureIdle();
    const job = this.getJob(jobId);
    if (job.progress.status !== "failed") {
      throw new AvitoMcpError("INVALID_INPUT", "Only a failed export can be resumed.");
    }
    return this.run(job);
  }

  private getJob(jobId: string): ExportJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new AvitoMcpError("EXPORT_NOT_FOUND", "No export with this jobId in the current server process.");
    return job;
  }

  private ensureIdle(): void {
    if (this.active) {
      throw new AvitoMcpError("EXPORT_IN_PROGRESS", `An export is already running. Check job ${this.active.jobId}.`);
    }
  }

  private run(job: ExportJob): ExportStatus {
    const { progress } = job;
    progress.status = "running";
    delete progress.error;
    this.active = progress;
    void this.collect(job);
    return { ...progress };
  }

  private async collect(job: ExportJob): Promise<void> {
    const { input: { condition, ...input }, progress, seen, pages, conditions } = job;
    const pageSize = "profile" in input ? PROFILE_ITEMS_PAGE_SIZE : MAX_SEARCH_LIMIT;
    const fetchPage = (page: number) => "profile" in input
      ? this.client.profileItems(input.profile, pageSize, page, input.requestIntervalSeconds)
      : this.client.search({ ...input, limit: pageSize, page });
    let uninitializedPath: string | undefined;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const csvPath = join(this.directory, `avito-${progress.jobId}.csv`);
      const file = await open(csvPath, progress.csvPath ? constants.O_WRONLY | constants.O_APPEND : "ax", 0o600);
      try {
        if (!progress.csvPath) {
          uninitializedPath = csvPath;
          await file.writeFile(CSV_HEADER);
          progress.csvPath = csvPath;
          uninitializedPath = undefined;
        }
        let bytesWritten = (await file.stat()).size;
        while (!progress.stopReason) {
          const page = progress.nextPage;
          const { items, totalCount } = await fetchPage(page);
          job.lastPage ??= Math.ceil(totalCount / pageSize);
          const signature = items.map(({ id }) => id).sort((a, b) => a - b).join(",");
          const rows = new Map<number, string>();
          let lookupFailure: { error: unknown } | undefined;
          try {
            for (const item of items) {
              if (seen.has(item.id) || rows.has(item.id)) continue;
              let row: Listing = item;
              if (condition && condition !== "any") {
                if (!conditions.has(item.id)) {
                  conditions.set(item.id, await this.client.listingCondition(item.id, input.requestIntervalSeconds));
                }
                if (conditions.get(item.id) !== condition) continue;
                row = { ...item, condition };
              }
              rows.set(item.id, csvRow(row));
              if (progress.written + rows.size === input.limit) break;
            }
          } catch (error) {
            lookupFailure = { error };
          }
          if (rows.size > 0) {
            const batch = [...rows.values()].join("");
            try {
              await file.writeFile(batch);
            } catch (error) {
              await file.truncate(bytesWritten);
              throw error;
            }
            bytesWritten += Buffer.byteLength(batch);
            for (const id of rows.keys()) seen.add(id);
          }
          progress.written += rows.size;
          if (lookupFailure) throw lookupFailure.error;
          progress.pagesRead++;
          progress.nextPage++;
          if (progress.written === input.limit) progress.stopReason = "limit_reached";
          else if (pages.has(signature)) progress.stopReason = "repeated_page";
          else if (items.length === 0 || page >= job.lastPage) progress.stopReason = "results_exhausted";
          pages.add(signature);
        }
      } finally {
        await file.close();
      }
      progress.status = "completed";
      seen.clear();
      pages.clear();
      conditions.clear();
    } catch (error) {
      if (uninitializedPath) await unlink(uninitializedPath).catch(() => undefined);
      progress.status = "failed";
      progress.error = safeError(error);
    } finally {
      this.active = undefined;
    }
  }
}
