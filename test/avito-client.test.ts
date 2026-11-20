import { describe, expect, it, vi } from "vitest";

import { AvitoClient, MAX_QUERY_LENGTH, parseItemId, validSearchQuery } from "../src/avito-client.js";
import type { RuntimeConfig } from "../src/config.js";
import { at, object } from "../src/json-fields.js";
import { itemPageHtml, jsonFixture } from "./fixture.js";

const session = vi.hoisted(() => ({ requestHtml: vi.fn(), requestJson: vi.fn() }));

vi.mock("../src/browser-session.js", () => ({
  AvitoBrowserSession: class {
    requestHtml = session.requestHtml;
    requestJson = session.requestJson;
  },
}));

const LISTING_URL = "https://www.avito.ru/moskva/bytovaya_tehnika/kofemashina_delonghi_magnifica_rapid_cappuccino_8457820574";

describe("parseItemId", () => {
  it("accepts listing ids and Avito listing URLs", () => {
    expect(parseItemId(" 8457820574 ")).toBe(8_457_820_574);
    expect(
      parseItemId("https://www.avito.ru/moskva/bytovaya_tehnika/kofemashina_delonghi_magnifica_rapid_cappuccino_8457820574?context=x"),
    ).toBe(8_457_820_574);
    expect(parseItemId("https://avito.ru/8457820574")).toBe(8_457_820_574);
    expect(parseItemId("https://m.avito.ru/kazan/telefony/iphone_15_123/")).toBe(123);
    expect(parseItemId("https://www.avito.ru/kazan/telefony/mobilnye_telefony/iphone_15_123")).toBe(123);
  });

  it.each([
    "https://example.com/moskva/telefony/iphone_123",
    "http://www.avito.ru/moskva/telefony/iphone_123",
    "https://www.avito.ru/moskva/telefony",
    "https://www.avito.ru/brands/03ce308a3e5989378d53c4f1b2f80718",
    "https://www.avito.ru/moskva/telefony/iphone",
    "iphone_123",
    "0",
    "99999999999999999999",
  ])("rejects %s", (input) => {
    expect(() => parseItemId(input)).toThrow(expect.objectContaining({ code: "INVALID_ITEM" }));
  });
});

describe("validSearchQuery", () => {
  it("trims the query", () => {
    expect(validSearchQuery({ query: "  iphone 15 " })).toBe("iphone 15");
  });

  it.each([
    { query: "phone", priceMin: 10, priceMax: 5 },
    { query: "x".repeat(MAX_QUERY_LENGTH + 1) },
    { query: "   " },
  ])("rejects invalid input %#", (input) => {
    expect(() => validSearchQuery(input)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});

describe("AvitoClient.sellerReviews", () => {
  it("returns no reviews without calling the ratings endpoint when the seller has none", async () => {
    const buyerItem = { ...object(at(jsonFixture("item-hydration-buyerItem.json"), "buyerItem")), rating: {} };
    session.requestHtml.mockResolvedValue({ url: LISTING_URL, html: itemPageHtml(buyerItem) });

    const result = await new AvitoClient({} as RuntimeConfig).sellerReviews("8457820574");

    expect(result).toMatchObject({ listing: { id: 8_457_820_574 }, rating: null, count: 0, reviews: [] });
    expect(session.requestJson).not.toHaveBeenCalled();
  });
});

describe("AvitoClient.profileItems", () => {
  const profile = "https://www.avito.ru/user/synthetic-key/profile?id=1234567890&page=2";

  it("requests one JSON page of active listings using the seller key from the profile URL", async () => {
    session.requestHtml.mockClear();
    session.requestJson.mockClear().mockResolvedValue({
      totalCount: 14,
      catalog: {
        items: [
          {
            id: 1_234_567_890,
            title: "Блок питания Bloody 850W Gold BD-PS850G-M",
            urlPath: "/moskva/kompyutery/komplektuyuschie/bloody_1234567890?context=test",
            priceDetailed: { value: 4_500, fullString: "4\u00a0500 ₽" },
            addressDetailed: { locationName: "Москва" },
          },
          { type: "banner" },
          {
            type: "item",
            id: 1_234_567_891,
            title: "Другая карточка",
            urlPath: "/1234567891",
            priceDetailed: { hasValue: false },
            location: { name: "Тверь" },
          },
        ],
      },
    });
    const client = new AvitoClient({} as RuntimeConfig);

    const result = await client.profileItems(`${profile}#listings`, 12, 2);

    expect(session.requestHtml).not.toHaveBeenCalled();
    expect(session.requestJson).toHaveBeenCalledExactlyOnceWith(
      "https://www.avito.ru/web/1/profile/items?categoryId=0&sellerId=synthetic-key&s=104&page=2&limit=12&noProfileCategoryTree=true&shortcut=active",
    );
    expect(result).toEqual({
      page: 2,
      totalCount: 14,
      count: 2,
      items: [
        {
          id: 1_234_567_890,
          title: "Блок питания Bloody 850W Gold BD-PS850G-M",
          price: 4_500,
          priceText: "4 500 ₽",
          url: "https://www.avito.ru/moskva/kompyutery/komplektuyuschie/bloody_1234567890",
          location: "Москва",
        },
        {
          id: 1_234_567_891,
          title: "Другая карточка",
          price: null,
          priceText: null,
          url: "https://www.avito.ru/1234567891",
          location: "Тверь",
        },
      ],
    });
    await expect(client.profileItems(profile, 1, 2)).resolves.toEqual({ ...result, count: 1, items: result.items.slice(0, 1) });
  });

  it.each([
    "https://example.com/user/key/profile",
    "https://www.avito.ru:444/user/key/profile",
    "https://www.avito.ru/1234567890",
  ])("rejects %s before requesting JSON", async (url) => {
    session.requestJson.mockClear();
    await expect(new AvitoClient({} as RuntimeConfig).profileItems(url)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(session.requestJson).not.toHaveBeenCalled();
  });

  it("reports an invalid payload separately from an empty catalog", async () => {
    session.requestJson.mockResolvedValueOnce({ totalCount: 0 }).mockResolvedValueOnce({ totalCount: 0, catalog: { items: [] } });
    const client = new AvitoClient({} as RuntimeConfig);
    await expect(client.profileItems(profile)).rejects.toMatchObject({ code: "AVITO_RESPONSE_INVALID" });
    await expect(client.profileItems(profile)).resolves.toEqual({ page: 1, totalCount: 0, count: 0, items: [] });
  });
});
