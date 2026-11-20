const HOST = "com.avito_shopping_mcp.profile";
const activeTabs = new Set();

chrome.action.onClicked.addListener(tab => {
  if (tab.id === undefined || activeTabs.has(tab.id)) return;
  activeTabs.add(tab.id);
  void sendProfileListings(tab).catch(() => undefined).finally(() => activeTabs.delete(tab.id));
});

async function sendProfileListings(tab) {
  const showStatus = (text, title) => Promise.all([
    chrome.action.setBadgeText({ tabId: tab.id, text }),
    chrome.action.setTitle({ tabId: tab.id, title }),
  ]);

  let request;
  try {
    const url = new URL(tab.url);
    if (!["https://www.avito.ru", "https://avito.ru", "https://m.avito.ru"].includes(url.origin)
      || !/^\/user\/[\w-]+\/profile\/?$/.test(url.pathname)) {
      await showStatus("!", "Открой профиль продавца на Авито");
      return;
    }
    const claimed = await chrome.runtime.sendNativeMessage(HOST, { action: "claim", profile: url.origin + url.pathname });
    if (claimed.error) throw Error("Native host failed");
    request = claimed.request;
    if (!request) {
      await showStatus("?", "В Codex нет запроса для этого профиля");
      return;
    }
    await showStatus("…", "Получаю объявления для Codex");
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fetchListings,
      args: [request.endpoint],
    });
    const response = await chrome.runtime.sendNativeMessage(HOST, {
      action: "complete",
      requestId: request.requestId,
      ...(execution?.result ?? { httpStatus: 0 }),
    });
    if (response.error) throw Error("Native host failed");
    request = undefined;
    await showStatus(
      response.status === "ready" ? "OK" : "!",
      response.status === "ready" ? "Объявления переданы в Codex" : "Проверь результат запроса в Codex",
    );
  } catch {
    if (request) {
      await chrome.runtime.sendNativeMessage(HOST, {
        action: "complete",
        requestId: request.requestId,
        httpStatus: 0,
      }).catch(() => undefined);
    }
    await showStatus("!", "Ошибка связи с локальным MCP");
  }
}

async function fetchListings(endpoint) {
  const url = new URL(endpoint, location.origin);
  const sellerId = location.pathname.match(/^\/user\/([\w-]+)\/profile\/?$/)?.[1];
  if (!["https://www.avito.ru", "https://avito.ru", "https://m.avito.ru"].includes(location.origin)
    || url.origin !== location.origin || url.pathname !== "/web/1/profile/items"
    || !sellerId || url.searchParams.get("sellerId") !== sellerId) {
    return { httpStatus: 0 };
  }

  const response = await fetch(url, {
    method: "GET",
    credentials: "same-origin",
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    return { httpStatus: response.status };
  }

  const data = await response.json();
  const field = value => typeof value === "string" ? value.slice(0, 2048) : undefined;
  const items = Array.isArray(data?.catalog?.items) ? data.catalog.items.slice(0, 12).map(item => ({
    type: field(item?.type),
    id: typeof item?.id === "number" ? item.id : undefined,
    title: field(item?.title),
    urlPath: field(item?.urlPath),
    priceDetailed: {
      value: typeof item?.priceDetailed?.value === "number" ? item.priceDetailed.value : undefined,
      hasValue: typeof item?.priceDetailed?.hasValue === "boolean" ? item.priceDetailed.hasValue : undefined,
      fullString: field(item?.priceDetailed?.fullString),
    },
    addressDetailed: { locationName: field(item?.addressDetailed?.locationName) },
    geo: { formattedAddress: field(item?.geo?.formattedAddress) },
    location: { name: field(item?.location?.name) },
  })) : undefined;
  return { httpStatus: response.status, payload: { totalCount: data?.totalCount, catalog: { items } } };
}
