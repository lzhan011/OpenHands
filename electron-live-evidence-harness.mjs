/**
 * Live Electron evidence for PR #17114.
 *
 * Wires electron/lib/navigation-policy.mjs onto a REAL BrowserWindow exactly
 * as electron/main.mjs does, then drives the three paths from issue #17112
 * against a real loopback server. Nothing here is a fake webContents: the
 * events are Electron's own.
 */
import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import {
  attachNavigationGuard,
  attachPopupPolicy,
  mainWindowOpenHandler,
} from "/scratch/c00590656/OpenHands/electron/lib/navigation-policy.mjs";
import {
  isExternalBrowsableUrl,
  isLoopbackAppUrl,
} from "/scratch/c00590656/OpenHands/electron/lib/window-url-policy.mjs";

// BEFORE=1 reproduces the wiring at this PR's merge base: a window-open
// handler on the main window, a `will-navigate`-only listener on the popup,
// and no guard at all on the main window itself.
const BEFORE = process.env.BEFORE === "1";

const PORT = 8000;
const opened = [];                       // records shell.openExternal calls
const openExternal = (url) => { opened.push(url); };

const log = (...a) => console.log("[evidence]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the local stack: serves the app page and a 302 off-host.
const server = createServer((req, res) => {
  if (req.url.startsWith("/redir")) {
    res.writeHead(302, { Location: "https://example.com/landed" });
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body>loopback app</body></html>");
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  log(`loopback server up on http://localhost:${PORT}`);

  const mainWin = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true },
  });

  // ---- wiring copied from electron/main.mjs (lines 403-440) ----
  await mainWin.loadURL(`http://localhost:${PORT}`);
  log(BEFORE ? "WIRING: merge-base (pre-fix)" : "WIRING: this PR");
  if (!BEFORE) attachNavigationGuard(mainWin.webContents, openExternal);
  // The policy's decision is used verbatim; the harness only adds
  // `offscreen` to whatever options it allows, because this box has no X
  // display and an on-screen child window crashes Chromium here. Rendering
  // mode only — `action`, allow/deny and openExternal are untouched.
  const headlessify = (result) => {
    if (result.action !== "allow") return result;
    const o = result.overrideBrowserWindowOptions ?? {};
    return {
      ...result,
      overrideBrowserWindowOptions: {
        ...o,
        show: false,
        webPreferences: { ...(o.webPreferences ?? {}), offscreen: true },
      },
    };
  };
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (BEFORE) {
      // merge-base handler, verbatim in behaviour
      if (url === "about:blank")
        return headlessify({ action: "allow", overrideBrowserWindowOptions: { width: 800, height: 700 } });
      if (isLoopbackAppUrl(url)) return headlessify({ action: "allow" });
      if (isExternalBrowsableUrl(url)) openExternal(url);
      return { action: "deny" };
    }
    return headlessify(mainWindowOpenHandler(url, openExternal));
  });
  mainWin.webContents.on("did-create-window", (popupWin) => {
    if (BEFORE) {
      popupWin.webContents.on("will-navigate", (event, url) => {
        if (url !== "about:blank" && !isLoopbackAppUrl(url)) {
          event.preventDefault();
          if (isExternalBrowsableUrl(url)) openExternal(url);
          popupWin.close();
        }
      });
      return;
    }
    attachPopupPolicy(popupWin, openExternal);
  });
  // -------------------------------------------------------------
  log("main window loaded:", mainWin.webContents.getURL());

  const fired = [];
  for (const ev of ["will-navigate", "will-redirect"]) {
    mainWin.webContents.on(ev, (_e, url) => fired.push(`${ev} -> ${url}`));
  }
  // Outcome events, so "the window stayed" is distinguishable from "the
  // navigation was attempted and failed".
  mainWin.webContents.on("did-navigate", (_e, url) => fired.push(`did-navigate -> ${url}`));
  mainWin.webContents.on("did-fail-load", (_e, code, desc, url) =>
    fired.push(`did-fail-load(${code} ${desc}) -> ${url}`));

  // PATH 1 — top-level navigation to a remote host
  log("--- path 1: location = 'https://example.com' from the renderer ---");
  await mainWin.webContents.executeJavaScript(
    `location = "https://example.com"; true;`, true,
  );
  await sleep(4000);
  log("events seen:", JSON.stringify(fired));
  log("main window URL after:", mainWin.webContents.getURL());
  log("openExternal received:", JSON.stringify(opened));

  // PATH 2 — a loopback URL that 302s off-host
  log("--- path 2: loopback /redir 302 -> https://example.com/landed ---");
  fired.length = 0; opened.length = 0;
  await mainWin.webContents.executeJavaScript(
    `location = "http://localhost:${PORT}/redir"; true;`, true,
  );
  await sleep(4000);
  log("events seen:", JSON.stringify(fired));
  log("main window URL after:", mainWin.webContents.getURL());
  log("openExternal received:", JSON.stringify(opened));

  // PATH 3 — window.open() from the main window, remote host
  log("--- path 3: window.open('https://evil.example') from the app ---");
  opened.length = 0;
  let popupCreated = 0;
  mainWin.webContents.on("did-create-window", () => { popupCreated += 1; });
  await mainWin.webContents.executeJavaScript(
    `window.open("https://evil.example"); true;`, true,
  );
  await sleep(1500);
  log("windows created by that call:", popupCreated);
  log("openExternal received:", JSON.stringify(opened));
  log("BrowserWindow count:", BrowserWindow.getAllWindows().length);

  // PATH 4 — the OAuth popup's own guard. `did-create-window` on the main
  // window is what attaches the policy (that it fires is established by the
  // popup existing at all), and attachPopupPolicy's will-navigate branch is
  // what keeps the popup off remote hosts.
  log("--- path 4: popup gets the policy and is kept off remote hosts ---");
  opened.length = 0;
  const popups = [];
  mainWin.webContents.once("did-create-window", (w) => popups.push(w));
  await mainWin.webContents.executeJavaScript(
    `window.__p = window.open("about:blank"); true;`, true,
  );
  await sleep(1200);
  log("did-create-window fired on the main window:", popups.length === 1);

  const popup = popups[0];
  const popupEvents = [];
  for (const ev of ["will-navigate", "will-redirect"]) {
    popup.webContents.on(ev, (_e, url) => popupEvents.push(`${ev} -> ${url}`));
  }
  log("popup URL before:", popup.webContents.getURL() || "about:blank");
  await popup.webContents.executeJavaScript(
    `location = "https://example.com/oauth"; true;`, true,
  );
  await sleep(2000);
  log("popup events:", JSON.stringify(popupEvents));
  log("popup destroyed by the policy:", popup.isDestroyed());
  if (!popup.isDestroyed()) log("popup URL after:", popup.webContents.getURL());
  log("openExternal received:", JSON.stringify(opened));

  log("DONE");
  server.close();
  app.exit(0);
});
