/*
 * The gate (public, ADR-0010). It holds no content. With the passphrase it
 * opens vault.json to get a token that can only read and write the private
 * sync repo, downloads the built app from that repo into Cache Storage, and
 * opens it; sw.js serves the cached app, offline too.
 *
 * Add ?stay to the URL to stay on this page (to log out or re-download).
 */
(function () {
  "use strict";

  const core = window.FBF.syncCore;
  const AUTH_KEY = "fbf-sync:auth";
  const FILES_KEY = "fbf-gate:files";
  const CACHE = "fbf-app-v1";
  const PARALLEL = 4;
  const base = new URL("./", window.location.href);
  const stay = new URLSearchParams(window.location.search).has("stay");
  const $ = (id) => document.getElementById(id);

  const TYPES = {
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json",
    mp3: "audio/mpeg",
    svg: "image/svg+xml",
    png: "image/png",
    txt: "text/plain; charset=utf-8",
  };

  function say(text, warn) {
    $("status").textContent = text;
    $("status").classList.toggle("warn", Boolean(warn));
  }

  function readJSON(key) {
    try {
      return JSON.parse(window.localStorage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
  }

  function writeJSON(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      // private mode: works for this visit only
    }
  }

  function auth() {
    const value = readJSON(AUTH_KEY);
    return value && value.token && value.owner && value.repo ? value : null;
  }

  function showForm(message, warn) {
    say(message || "第一次在這台裝置使用，請輸入密語。", warn);
    $("unlock").classList.remove("hidden");
    $("actions").classList.add("hidden");
    $("passphrase").focus();
  }

  function showActions(message) {
    say(message);
    $("unlock").classList.add("hidden");
    $("actions").classList.remove("hidden");
  }

  function progress(done, total) {
    $("progress").classList.toggle("hidden", total === 0 || done >= total);
    $("progress-bar").style.width = total ? Math.round((100 * done) / total) + "%" : "0";
  }

  function enter() {
    window.location.replace(new URL("app/index.html", base).href);
  }

  async function hasCachedApp() {
    const files = readJSON(FILES_KEY);
    if (!files || !files["app/index.html"] || !window.caches) return false;
    const cache = await caches.open(CACHE);
    return Boolean(await cache.match(new URL("app/index.html", base).href));
  }

  class AuthError extends Error {}

  async function github(a, path, accept) {
    const response = await fetch(core.API + "/repos/" + a.owner + "/" + a.repo + path, {
      headers: core.headers(a, accept ? { Accept: accept } : null),
      cache: "no-store",
    });
    if (response.status === 401) throw new AuthError("token 被拒絕");
    if (!response.ok) throw new Error("GitHub 回應 HTTP " + response.status);
    return response;
  }

  /** Bring the cached app in line with the private repo; returns how many files changed. */
  async function update(a, everything) {
    const tree = await (await github(a, "/git/trees/" + encodeURIComponent(a.branch || "main") + "?recursive=1")).json();
    const wanted = tree.tree.filter((e) => e.type === "blob" && e.path.startsWith("app/"));
    if (!wanted.length) throw new Error("私人 repo 裡還沒有練習頁：在家執行 uv run fbf web publish。");
    const cache = await caches.open(CACHE);
    const known = everything ? {} : readJSON(FILES_KEY) || {};
    const todo = [];
    for (const entry of wanted) {
      const url = new URL(entry.path, base).href;
      if (known[entry.path] !== entry.sha || !(await cache.match(url))) todo.push(entry);
    }
    let done = 0;
    progress(0, todo.length);
    const files = Object.assign({}, known);
    async function worker() {
      while (todo.length) {
        const entry = todo.shift();
        const response = await github(a, "/git/blobs/" + entry.sha, "application/vnd.github.raw+json");
        const body = await response.arrayBuffer();
        const ext = entry.path.split(".").pop().toLowerCase();
        await cache.put(
          new URL(entry.path, base).href,
          new Response(body, { headers: { "Content-Type": TYPES[ext] || "application/octet-stream" } })
        );
        files[entry.path] = entry.sha;
        done++;
        progress(done, done + todo.length);
        say("下載練習頁… " + done + " 個檔案");
      }
    }
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    // Forget files that are no longer in the app.
    const keep = new Set(wanted.map((e) => new URL(e.path, base).href));
    for (const request of await cache.keys()) {
      if (!keep.has(request.url)) await cache.delete(request);
    }
    for (const path of Object.keys(files)) {
      if (!wanted.some((e) => e.path === path)) delete files[path];
    }
    writeJSON(FILES_KEY, files);
    progress(0, 0);
    return done;
  }

  async function open(everything) {
    const a = auth();
    if (!a) return showForm();
    if (!navigator.onLine) {
      if (await hasCachedApp()) return stay ? showActions("離線中，可以用上次下載的版本。") : enter();
      return say("離線中，而且這台裝置還沒下載過練習頁。連上網路後再開一次。", true);
    }
    say("檢查新版本…");
    try {
      const changed = await update(a, everything);
      if (stay) showActions(changed ? "已更新 " + changed + " 個檔案。" : "已是最新版本。");
      else enter();
    } catch (error) {
      if (error instanceof AuthError) {
        writeJSON(AUTH_KEY, null);
        return showForm("GitHub 拒絕了這台裝置的 token（可能過期或被撤銷）。請在家執行 uv run fbf web token，再用同一組密語解鎖。", true);
      }
      if (await hasCachedApp()) {
        if (stay) return showActions("無法更新（" + error.message + "），可以用上次下載的版本。");
        return enter();
      }
      say("下載失敗：" + error.message, true);
    }
  }

  $("unlock").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button");
    button.disabled = true;
    say("解鎖中…（大約 1–2 秒）");
    try {
      const response = await fetch(new URL("vault.json", base).href, { cache: "no-store" });
      if (!response.ok) throw new Error("還沒設定：在家執行 uv run fbf web token。");
      const opened = await core.openVault(await response.json(), $("passphrase").value);
      writeJSON(AUTH_KEY, Object.assign(opened, { unlockedAt: Date.now() }));
      $("passphrase").value = "";
      await open(false);
    } catch (error) {
      showForm(error.wrongPassphrase ? "密語不對，再試一次（大小寫和空格不影響）。" : error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $("refresh").addEventListener("click", () => open(true));
  $("logout").addEventListener("click", async () => {
    if (!window.confirm("讓這台裝置登出並刪除下載的練習頁？這台裝置上還沒同步的進度會不見。")) return;
    writeJSON(AUTH_KEY, null);
    writeJSON(FILES_KEY, null);
    writeJSON("fbf-sync:status", null);
    if (window.caches) await caches.delete(CACHE);
    showForm("已登出。");
  });

  async function start() {
    if (!("serviceWorker" in navigator) || !window.caches || !window.crypto || !window.crypto.subtle) {
      say("這個瀏覽器不支援離線練習頁。請用最新版的 Safari、Chrome 或 Edge。", true);
      return;
    }
    try {
      await navigator.serviceWorker.register("sw.js", { scope: "./" });
      await navigator.serviceWorker.ready;
    } catch (error) {
      say("無法啟用離線功能：" + error.message, true);
      return;
    }
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    await open(false);
  }

  start();
})();
