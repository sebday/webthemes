const cssCache = new Map();

function patternHost(pattern) {
  const match = String(pattern || "").match(/^[^:]+:\/\/([^/]+)/);
  return match ? match[1] : "";
}

function hostMatches(pattern, hostname) {
  const hostPat = patternHost(pattern);
  if (!hostPat) return false;
  if (hostPat === "*") return true;
  if (hostPat.startsWith("*.")) {
    const suffix = hostPat.slice(1);
    const bare = hostPat.slice(2);
    return hostname === bare || hostname.endsWith(suffix);
  }
  return hostname === hostPat;
}

function siteForHost(catalog, hostname) {
  const sites = catalog && Array.isArray(catalog.sites) ? catalog.sites : [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    if (!site || site.enabled === false) continue;
    const matches = Array.isArray(site.matches) ? site.matches : [];
    for (let j = 0; j < matches.length; j++) {
      if (hostMatches(matches[j], hostname)) return site;
    }
  }
  return null;
}

function applyBadge() {
  chrome.action.setBadgeText({ text: "" });
}

function extText(path, bust) {
  return fetch(chrome.runtime.getURL(path) + "?v=" + bust, { cache: "reload" }).then((response) => {
    if (!response.ok) throw new Error(path + " " + response.status);
    return response.text();
  });
}

const OVERLAY_KEY = "enabledOverlay";

async function loadOverlay() {
  try {
    const data = await chrome.storage.local.get(OVERLAY_KEY);
    const overlay = data[OVERLAY_KEY];
    if (overlay && typeof overlay === "object") return overlay;
  } catch {
    /* ignore */
  }
  return { siteEnabled: {} };
}

function applyOverlay(catalog, overlay) {
  if (!catalog || !overlay) return catalog;
  if (typeof overlay.enabled === "boolean") catalog.enabled = overlay.enabled;
  const map = overlay.siteEnabled && typeof overlay.siteEnabled === "object" ? overlay.siteEnabled : {};
  const sites = Array.isArray(catalog.sites) ? catalog.sites : [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    if (!site || !site.id || !Object.prototype.hasOwnProperty.call(map, site.id)) continue;
    site.enabled = map[site.id] !== false;
  }
  return catalog;
}

function applyEnabledFlag(catalog, flagText) {
  if (!catalog || typeof flagText !== "string") return catalog;
  const trimmed = flagText.trim();
  if (trimmed === "false") catalog.enabled = false;
  else if (trimmed === "true") catalog.enabled = true;
  return catalog;
}

async function readCatalog() {
  const bust = String(Date.now());
  const catalog = JSON.parse(await extText("catalog.json", bust));
  applyOverlay(catalog, await loadOverlay());
  const enabledText = await extText("enabled", bust).catch(() => "");
  applyEnabledFlag(catalog, enabledText);
  applyBadge(catalog);
  await resolveThemeJobs(catalog);
  return catalog;
}

async function cssReplyForHost(host) {
  const catalog = await readCatalog();
  const bust = String(Date.now());
  const colors = await extText("colors.css", bust).catch(() => "");
  const css = await cssForTab(catalog, colors, { url: "https://" + host + "/" }, bust);
  const site = siteForHost(catalog, host);
  const revision = await extText("revision", bust).catch(() => bust);
  return {
    ok: true,
    css: css || "",
    key: revision + "\n" + (site ? site.id + "\n" + site.css : ""),
  };
}

async function cssForTab(catalog, colors, tab, bust) {
  if (!catalog || catalog.enabled === false || !tab || !tab.url) return "";
  let hostname;
  try {
    if (!/^https?:/i.test(tab.url)) return "";
    hostname = new URL(tab.url).hostname;
  } catch {
    return "";
  }
  const site = siteForHost(catalog, hostname);
  if (!site || !site.css) return "";
  let siteCss = cssCache.get(site.css);
  if (!siteCss) {
    siteCss = await extText(site.css, bust).catch(() => "");
    cssCache.set(site.css, siteCss);
  }
  return [colors, siteCss].filter(Boolean).join("\n");
}

function refreshBadge() {
  chrome.action.setBadgeText({ text: "" });
}

function themeJobId(host) {
  return "webtheme-theme-" + host;
}

async function loadThemeJobs() {
  try {
    const data = await chrome.storage.session.get("themeJobs");
    if (Array.isArray(data.themeJobs)) return data.themeJobs;
  } catch {
    /* storage.session may be unavailable until the permission is granted */
  }
  return [];
}

async function saveThemeJobs(jobs) {
  try {
    await chrome.storage.session.set({ themeJobs: jobs });
  } catch {
    /* ignore */
  }
}

function notifyChrome(id, title, message) {
  if (!chrome.notifications || typeof chrome.notifications.create !== "function") return;
  chrome.notifications.create(
    id,
    {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title,
      message,
      priority: 1,
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

async function resolveThemeJobs(catalog) {
  const jobs = await loadThemeJobs();
  if (!jobs.length) return;
  const kept = [];
  const now = Date.now();
  for (const job of jobs) {
    if (siteForHost(catalog, job.host)) {
      notifyChrome(themeJobId(job.host), "Themed " + job.host, "The personal package is on.");
      continue;
    }
    if (now - (job.startedAt || 0) > 45 * 60 * 1000) continue;
    kept.push(job);
  }
  await saveThemeJobs(kept);
}

chrome.runtime.onConnect.addListener((port) => {
  port.onDisconnect.addListener(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") {
    sendResponse({ ok: false, error: "invalid message" });
    return false;
  }
  if (msg.type === "list") {
    readCatalog()
      .then((catalog) => sendResponse(Object.assign({ ok: true, type: "list" }, catalog)))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }
  if (msg.type === "css-for-host") {
    cssReplyForHost(String(msg.host || ""))
      .then((reply) => sendResponse(reply))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }
  if (msg.type === "theme-jobs") {
    readCatalog()
      .then(() => loadThemeJobs())
      .then((jobs) => sendResponse({ ok: true, jobs }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }
  sendResponse({ ok: false, error: "unsupported" });
  return false;
});

chrome.runtime.onStartup.addListener(() => refreshBadge());
chrome.runtime.onInstalled.addListener(() => refreshBadge());
refreshBadge();
