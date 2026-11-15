(function () {
  "use strict";

  const STYLE_ID = "web-themes-style";
  const match = globalThis.webThemesMatch || {};
  const siteForHost = match.siteForHost;

  let lastKey = "";
  let lastRevision = "";
  let appliedCss = "";
  let paused = false;
  let stopped = false;
  let updateGen = 0;
  let pollTimer = 0;
  let observer = null;

  function runtimeAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (err) {
      return false;
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    paused = true;
    if (pollTimer) clearInterval(pollTimer);
    if (observer) observer.disconnect();
  }

  const SHADOW_STYLE_ID = "web-themes-shadow-style";

  function injectShadow(root, css) {
    if (!root || root.__wtShadow === css) return;
    let el = null;
    try {
      el = root.getElementById(SHADOW_STYLE_ID);
    } catch (err) {
      return;
    }
    if (!el) {
      el = document.createElement("style");
      el.id = SHADOW_STYLE_ID;
      try {
        root.appendChild(el);
      } catch (err) {
        return;
      }
    }
    el.textContent = css;
    root.__wtShadow = css;
    let nodes = [];
    try {
      nodes = root.querySelectorAll("*");
    } catch (err) {
      return;
    }
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) injectShadow(nodes[i].shadowRoot, css);
    }
  }

  function onLiveView() {
    return location.hostname === "admin.shopify.com" && location.pathname.indexOf("/analytics/live") !== -1;
  }

  function clearShadowStyles(root) {
    if (!root) return;
    try {
      const el = root.getElementById && root.getElementById(SHADOW_STYLE_ID);
      if (el) el.remove();
      root.__wtShadow = "";
      const nodes = root.querySelectorAll("*");
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].shadowRoot) clearShadowStyles(nodes[i].shadowRoot);
      }
    } catch (err) {
      /* ignore */
    }
  }

  function pierceShadows(css) {
    if (!css || location.hostname !== "admin.shopify.com") return;
    if (!onLiveView()) {
      clearShadowStyles(document);
      clearPaint(document);
      return;
    }
    const extra = ":host,:host *,*,*::before,*::after{--p-color-text:#fff !important;--p-color-text-secondary:#fff !important;--p-color-text-disabled:#fff !important;--p-color-text-inverse:#fff !important;--p-color-text-inverse-secondary:#fff !important;color:#fff !important;-webkit-text-fill-color:#fff !important;}";
    let nodes = [];
    try {
      nodes = document.querySelectorAll("*");
    } catch (err) {
      return;
    }
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) injectShadow(nodes[i].shadowRoot, extra);
    }
    schedulePaint();
  }

  let paintQueued = false;

  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (!onLiveView()) return;
      paintDarkText(document);
    });
  }

  function clearPaint(root) {
    let nodes = [];
    try {
      nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    } catch (err) {
      return;
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.shadowRoot) clearPaint(node.shadowRoot);
      if (!node.__wtPaint) continue;
      node.style.removeProperty("color");
      node.style.removeProperty("-webkit-text-fill-color");
      node.__wtPaint = 0;
    }
  }

  function darkFill(value) {
    const match = String(value || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return false;
    return (+match[1] + +match[2] + +match[3]) / 3 < 170;
  }

  function paintDarkText(root) {
    let nodes = [];
    try {
      nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    } catch (err) {
      return;
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.shadowRoot) paintDarkText(node.shadowRoot);
      if (node.__wtPaint) continue;
      node.__wtPaint = 1;
      let color = "";
      let fill = "";
      try {
        const cs = getComputedStyle(node);
        color = cs.color;
        fill = cs.webkitTextFillColor;
      } catch (err) {
        continue;
      }
      if (!darkFill(color) && !darkFill(fill)) continue;
      node.style.setProperty("color", "#fff", "important");
      node.style.setProperty("-webkit-text-fill-color", "#fff", "important");
    }
  }

  function injectCSS(css) {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
    }
    el.textContent = css;
    const parent = document.head || document.documentElement;
    parent.appendChild(el);
    try {
      pierceShadows(css);
    } catch (err) {
      /* the page sheet is already in place */
    }
  }

  function clearStyle() {
    appliedCss = "";
    lastKey = "";
    paused = true;
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
  }

  function removeCSS() {
    updateGen += 1;
    clearStyle();
  }

  function stylePresent() {
    return !!document.getElementById(STYLE_ID);
  }

  function ensureStyle() {
    if (paused || !appliedCss) return;
    if (!stylePresent()) injectCSS(appliedCss);
    else {
      try {
        pierceShadows(appliedCss);
      } catch (err) {
        /* ignore */
      }
    }
  }

  function applyPayload(css, key) {
    if (!css) {
      removeCSS();
      return;
    }
    if (key && key === lastKey && css === appliedCss && stylePresent()) return;
    paused = false;
    appliedCss = css;
    lastKey = key || "";
    injectCSS(css);
  }

  function fetchText(url) {
    if (!url) return Promise.reject(new Error("extension context invalidated"));
    return fetch(url, { cache: "reload" }).then((response) => {
      if (!response.ok) throw new Error(url + " " + response.status);
      return response.text();
    });
  }

  function extUrl(path, token) {
    if (!runtimeAlive()) {
      stop();
      return "";
    }
    try {
      return chrome.runtime.getURL(path) + "?v=" + encodeURIComponent(token);
    } catch (err) {
      stop();
      return "";
    }
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

  function loadOverlay() {
    if (!runtimeAlive()) return Promise.resolve({ siteEnabled: {} });
    try {
      if (!chrome.storage || !chrome.storage.local) {
        return Promise.resolve({ siteEnabled: {} });
      }
      return chrome.storage.local.get("enabledOverlay").then((data) => {
        const overlay = data && data.enabledOverlay;
        if (overlay && typeof overlay === "object") return overlay;
        return { siteEnabled: {} };
      }).catch(() => ({ siteEnabled: {} }));
    } catch (err) {
      stop();
      return Promise.resolve({ siteEnabled: {} });
    }
  }

  function checkForUpdate(force) {
    if (stopped || !runtimeAlive()) {
      stop();
      return;
    }
    const hostname = location.hostname;
    const token = String(Date.now());
    const gen = ++updateGen;

    Promise.all([
      fetchText(extUrl("catalog.json", token)),
      fetchText(extUrl("revision", token)).catch(() => token),
      loadOverlay(),
      fetchText(extUrl("enabled", token)).catch(() => ""),
    ])
      .then(([catalogText, revision, overlay, enabledText]) => {
        if (gen !== updateGen) return;
        lastRevision = revision;
        const catalog = applyEnabledFlag(applyOverlay(JSON.parse(catalogText), overlay), enabledText);
        if (catalog && catalog.enabled === false) {
          clearStyle();
          return;
        }
        const site = siteForHost ? siteForHost(catalog, hostname) : null;
        if (!site || !site.css) {
          clearStyle();
          return;
        }
        const key = revision + "\n" + site.id + "\n" + site.css + "\n" + String(site.enabled !== false);
        if (!force && key === lastKey && appliedCss && stylePresent()) return;
        return Promise.all([
          fetchText(extUrl("colors.css", revision || token)).catch(() => ""),
          fetchText(extUrl(site.css, revision || token)),
        ]).then(([colors, siteCss]) => {
          if (gen !== updateGen) return;
          applyPayload([colors, siteCss].filter(Boolean).join("\n"), key);
        });
      })
      .catch((err) => {
        const message = err && err.message ? err.message : String(err || "");
        if (/invalidated|context/i.test(message)) {
          stop();
          return;
        }
        console.warn("web themes:", message);
      });
  }

  function pollRevision() {
    if (stopped || window !== window.top) return;
    if (!runtimeAlive()) {
      stop();
      return;
    }
    if (document.visibilityState !== "visible") return;
    fetchText(extUrl("revision", Date.now()))
      .then((rev) => {
        if (rev === lastRevision) return;
        lastRevision = rev;
        checkForUpdate(true);
      })
      .catch(() => {});
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (stopped || !msg || msg.type !== "web-themes-reload") return;
      if (typeof msg.css === "string") {
        applyPayload(msg.css, msg.key || String(Date.now()));
        return;
      }
      checkForUpdate(true);
    });
  } catch (err) {
    stop();
  }

  try {
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (stopped) return;
        if (area === "local" && changes.enabledOverlay) checkForUpdate(true);
      });
    }
  } catch (err) {
    stop();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate(true);
  });

  ["astro:after-swap", "astro:page-load", "turbo:load", "turbo:render"].forEach((name) => {
    document.addEventListener(name, ensureStyle);
  });
  window.addEventListener("pageshow", ensureStyle);

  observer = new MutationObserver(() => {
    if (stopped) return;
    ensureStyle();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (window === window.top) {
    pollTimer = setInterval(pollRevision, 800);
    let lastPath = location.pathname;
    const onPath = () => {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      if (location.hostname !== "admin.shopify.com") return;
      if (!onLiveView()) clearShadowStyles(document);
      else if (appliedCss) pierceShadows(appliedCss);
    };
    const pushState = history.pushState;
    const replaceState = history.replaceState;
    history.pushState = function () {
      const result = pushState.apply(this, arguments);
      onPath();
      return result;
    };
    history.replaceState = function () {
      const result = replaceState.apply(this, arguments);
      onPath();
      return result;
    };
    window.addEventListener("popstate", onPath);
  }

  checkForUpdate(true);
})();
