import {
  apiUrl,
  itemPageUrl,
  locationsApiUrl,
  MOSCOW,
  parseItemId,
  profileItemsApiUrl,
  PROFILE_ITEMS_PAGE_SIZE,
  searchApiUrl,
  sellerRatingsUrl,
} from "./avito-api.js";
import { AvitoBrowserSession } from "./browser-session.js";

export { RATE_LIMIT_BACKOFF_MINUTES } from "./browser-session.js";
import type { RuntimeConfig } from "./config.js";
import { AvitoMcpError } from "./errors.js";
import { parseItem, parseSellerUserKey, readBuyerItem } from "./item-page.js";
import { parseLocations, parseProfileItems, parseRatingsPage, parseSearchPage } from "./parsers.js";
import type {
  ItemDetails,
  Location,
  ProfileItemsResult,
  SearchResult,
  SearchSort,
  SellerReview,
  SellerReviewsResult,
} from "./types.js";

export { MAX_ITEM_INPUT_LENGTH, parseItemId } from "./avito-api.js";

export interface SearchInput {
  query: string;
  location?: string | undefined;
  sort?: SearchSort | undefined;
  priceMin?: number | undefined;
  priceMax?: number | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

type SellerReviews = Pick<SellerReviewsResult, "rating" | "reviews">;

export const MAX_QUERY_LENGTH = 200;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_REVIEWS_LIMIT = 10;
export const MAX_REVIEWS_LIMIT = 50;
export const MIN_SETUP_TIMEOUT_SECONDS = 30;
export const DEFAULT_SETUP_TIMEOUT_SECONDS = 120;
export const MAX_SETUP_TIMEOUT_SECONDS = 300;
const MS_PER_SECOND = 1_000;
const NO_REVIEWS: SellerReviews = { rating: null, reviews: [] };
const CYRILLIC = /\p{Script=Cyrillic}/u;

export function validSearchQuery(input: SearchInput): string {
  const query = input.query.trim();
  if (!query) throw new AvitoMcpError("INVALID_INPUT", "Search query cannot be empty.");
  if (query.length > MAX_QUERY_LENGTH) throw new AvitoMcpError("INVALID_INPUT", "Search query is too long.");
  if (input.priceMin !== undefined && input.priceMax !== undefined && input.priceMin > input.priceMax) {
    throw new AvitoMcpError("INVALID_INPUT", "priceMin cannot be greater than priceMax.");
  }
  return query;
}

export class AvitoClient {
  private readonly session: AvitoBrowserSession;
  private readonly locations = new Map<string, Location>([[locationKey(MOSCOW.name), MOSCOW]]);

  constructor(private readonly config: RuntimeConfig) {
    this.session = new AvitoBrowserSession(config);
  }

  setup(timeoutSeconds = DEFAULT_SETUP_TIMEOUT_SECONDS, report?: (message: string) => void) {
    return this.session.setup(timeoutSeconds * MS_PER_SECOND, report);
  }

  startSessionSetup(timeoutSeconds = DEFAULT_SETUP_TIMEOUT_SECONDS) {
    void this.setup(timeoutSeconds).catch(() => undefined);
    return this.session.getSetupStatus();
  }

  async search(input: SearchInput): Promise<SearchResult> {
    const query = validSearchQuery(input);
    const location = await this.resolveLocation(input.location ?? MOSCOW.name);
    const sort = input.sort ?? "default";
    const page = input.page ?? 1;
    const result = parseSearchPage(
      await this.session.requestJson(
        searchApiUrl({ query, locationId: location.id, sort, page, priceMin: input.priceMin, priceMax: input.priceMax }),
      ),
      location,
    );
    const items = result.items.slice(0, input.limit ?? DEFAULT_SEARCH_LIMIT);
    return { query, location, sort, page, totalCount: result.totalCount, count: items.length, items };
  }

  async item(item: string): Promise<ItemDetails> {
    const { buyerItem, url } = await this.loadBuyerItem(parseItemId(item));
    return parseItem(buyerItem, url);
  }

  async profileItems(profile: string, limit = PROFILE_ITEMS_PAGE_SIZE, page = 1): Promise<ProfileItemsResult> {
    const result = parseProfileItems(await this.session.requestJson(profileItemsApiUrl(profile, page)));
    const items = result.items.slice(0, limit);
    return { page, totalCount: result.totalCount, count: items.length, items };
  }

  async sellerReviews(item: string, limit = DEFAULT_REVIEWS_LIMIT): Promise<SellerReviewsResult> {
    const { buyerItem, url } = await this.loadBuyerItem(parseItemId(item));
    const listing = parseItem(buyerItem, url);
    const userKey = parseSellerUserKey(buyerItem);
    const { rating, reviews } = userKey === null ? NO_REVIEWS : await this.loadReviews(userKey, limit);
    return {
      listing: { id: listing.id, title: listing.title, url: listing.url },
      seller: listing.seller,
      rating,
      count: reviews.length,
      reviews,
    };
  }

  async health(live = false) {
    const [stored, permissions] = await Promise.all([this.session.sessionInfo(), this.session.sessionMode()]);
    const liveResult = live ? await this.session.checkLive() : undefined;
    return {
      ok: stored.exists && (!liveResult || liveResult.ok),
      session: {
        exists: stored.exists,
        ...(stored.createdAt ? { createdAt: stored.createdAt } : {}),
        ...(stored.ageSeconds !== undefined ? { ageSeconds: stored.ageSeconds } : {}),
        permissions: permissions === null ? null : `0${permissions.toString(8)}`,
      },
      browserChannel: this.config.browserChannel,
      setup: this.session.getSetupStatus(),
      ...(liveResult ? { live: liveResult } : {}),
    };
  }

  shutdown() {
    return this.session.shutdown();
  }

  private async resolveLocation(name: string): Promise<Location> {
    const key = locationKey(name);
    const cached = this.locations.get(key);
    if (cached) return cached;
    if (!CYRILLIC.test(key)) {
      throw new AvitoMcpError("LOCATION_NOT_FOUND", "Location must be a Russian city or region name, e.g. Казань.");
    }

    const candidates = parseLocations(await this.session.requestJson(locationsApiUrl(name.trim())));
    const location = candidates.find((candidate) => locationKey(candidate.name) === key) ?? candidates[0];
    if (!location) throw new AvitoMcpError("LOCATION_NOT_FOUND", `Avito knows no location named "${name.trim()}".`);
    this.locations.set(key, location);
    return location;
  }

  private async loadReviews(userKey: string, limit: number): Promise<SellerReviews> {
    let page = parseRatingsPage(await this.session.requestJson(sellerRatingsUrl(userKey)));
    const rating = page.summary;
    const reviews: SellerReview[] = [...page.reviews];
    while (reviews.length < limit && page.nextPage !== null && page.reviews.length > 0) {
      page = parseRatingsPage(await this.session.requestJson(apiUrl(page.nextPage)));
      reviews.push(...page.reviews);
    }
    return { rating, reviews: reviews.slice(0, limit) };
  }

  private async loadBuyerItem(id: number) {
    const page = await this.session.requestHtml(itemPageUrl(id));
    if (!page) throw new AvitoMcpError("ITEM_NOT_FOUND", `Avito has no listing with id ${id}.`);
    return { buyerItem: readBuyerItem(page.html), url: page.url };
  }
}

function locationKey(name: string): string {
  return name.trim().toLocaleLowerCase("ru-RU");
}
