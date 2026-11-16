/*
 * Sync helpers with no DOM (FBF.syncCore), shared by the app and the gate
 * page, and tested in app/tests/sync-core.test.js (ADR-0010):
 *
 * - the vault: a GitHub token encrypted with AES-256-GCM under a key
 *   derived from the passphrase with PBKDF2-HMAC-SHA256 (`fbf web token`
 *   writes it in Python; the browser decrypts it with Web Crypto);
 * - merging two progress documents ({format: "fbf-progress", data}) key by
 *   key: review state card by card, exam history as a union, anything else
 *   keeps the local value;
 * - small helpers for base64 and the GitHub contents API.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.FBF = root.FBF || {};
    root.FBF.syncCore = api;
  }
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  const VAULT_FORMAT = "fbf-vault";
  const PROGRESS_PATH = "progress/progress.json";
  const API = "https://api.github.com";

  // ---------- bytes ----------

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  function fromUtf8(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function toBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function fromBase64(text) {
    const binary = atob(String(text).replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ---------- the vault ----------

  /** Case and separators don't matter: "Ocean-river  Table" → "ocean river table". */
  function normalizePassphrase(text) {
    return String(text || "")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean)
      .join(" ");
  }

  function webCrypto() {
    const scope = typeof globalThis !== "undefined" ? globalThis : root;
    return scope && scope.crypto;
  }

  function subtleCrypto(subtle) {
    const found = subtle || (webCrypto() && webCrypto().subtle);
    if (!found) throw new Error("這個瀏覽器不支援 Web Crypto，無法解鎖。");
    return found;
  }

  async function deriveKey(passphrase, salt, iterations, subtle) {
    const s = subtleCrypto(subtle);
    const base = await s.importKey("raw", utf8(normalizePassphrase(passphrase)), "PBKDF2", false, ["deriveKey"]);
    return s.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: iterations },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function checkVault(vault) {
    if (!vault || vault.format !== VAULT_FORMAT || vault.version !== 1) throw new Error("vault.json 格式不對。");
    if (!vault.kdf || vault.kdf.name !== "PBKDF2" || vault.kdf.hash !== "SHA-256") throw new Error("vault.json 的金鑰設定不支援。");
    if (!vault.cipher || vault.cipher.name !== "AES-GCM") throw new Error("vault.json 的加密方式不支援。");
  }

  /**
   * Decrypt the vault with the passphrase. Resolves to {token, owner, repo,
   * branch}; rejects with {wrongPassphrase: true} if the passphrase is wrong.
   */
  async function openVault(vault, passphrase, subtle) {
    checkVault(vault);
    const key = await deriveKey(passphrase, fromBase64(vault.kdf.salt), vault.kdf.iterations, subtle);
    let plain;
    try {
      plain = await subtleCrypto(subtle).decrypt({ name: "AES-GCM", iv: fromBase64(vault.cipher.iv) }, key, fromBase64(vault.data));
    } catch (_) {
      const error = new Error("密語不對。");
      error.wrongPassphrase = true;
      throw error;
    }
    const payload = JSON.parse(fromUtf8(new Uint8Array(plain)));
    if (!payload || typeof payload.token !== "string" || !payload.owner || !payload.repo) {
      throw new Error("vault.json 內容不完整。");
    }
    return { token: payload.token, owner: payload.owner, repo: payload.repo, branch: payload.branch || "main" };
  }

  /** Encrypt a payload into a vault (the tests use it to check the Python side). */
  async function sealVault(payload, passphrase, options, subtle) {
    const opts = options || {};
    const s = subtleCrypto(subtle);
    const salt = opts.salt || webCrypto().getRandomValues(new Uint8Array(16));
    const iv = opts.iv || webCrypto().getRandomValues(new Uint8Array(12));
    const iterations = opts.iterations || 1000000;
    const key = await deriveKey(passphrase, salt, iterations, s);
    const data = await s.encrypt({ name: "AES-GCM", iv: iv }, key, utf8(JSON.stringify(payload)));
    return {
      format: VAULT_FORMAT,
      version: 1,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: iterations, salt: toBase64(salt) },
      cipher: { name: "AES-GCM", iv: toBase64(iv) },
      data: toBase64(new Uint8Array(data)),
    };
  }

  // ---------- progress documents ----------

  const REVIEW_KEY = "fbf:review:v1";
  const EXAM_KEY = "fbf:exam:v1";
  const PREFS_KEY = "fbf:prefs:v1";

  /** Merge functions by key, given the review and exam modules (either may be missing). */
  function mergers(review, exam) {
    const out = {};
    if (review) out[REVIEW_KEY] = (a, b) => review.mergeStates(review.cleanState(a), review.cleanState(b));
    if (exam) out[EXAM_KEY] = (a, b) => exam.mergeStates(exam.cleanState(a), exam.cleanState(b));
    return out;
  }

  function emptyDoc() {
    return { format: "fbf-progress", version: 1, data: {} };
  }

  function isDoc(doc) {
    return Boolean(doc && doc.format === "fbf-progress" && doc.data && typeof doc.data === "object");
  }

  /**
   * One document from the local and the remote one. Keys with a merge
   * function are merged; other keys keep the local value and take the
   * remote one only where the local document has none. A key with a merge
   * function whose module isn't loaded must not be lost, so it is kept from
   * whichever side has it (local first).
   */
  function mergeDocs(local, remote, merge) {
    const a = isDoc(local) ? local.data : {};
    const b = isDoc(remote) ? remote.data : {};
    const data = {};
    for (const key of new Set(Object.keys(b).concat(Object.keys(a)))) {
      if (!key.startsWith("fbf:") || key === PREFS_KEY) continue;
      const inA = Object.prototype.hasOwnProperty.call(a, key);
      const inB = Object.prototype.hasOwnProperty.call(b, key);
      if (inA && inB && merge && merge[key]) data[key] = merge[key](a[key], b[key]);
      else data[key] = inA ? a[key] : b[key];
    }
    return { format: "fbf-progress", version: 1, data: data };
  }

  /** JSON with sorted keys, so equal data compares equal. */
  function stable(value) {
    if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  function sameData(a, b) {
    return stable(a) === stable(b);
  }

  // ---------- GitHub ----------

  function contentsUrl(auth, path) {
    return API + "/repos/" + encodeURIComponent(auth.owner) + "/" + encodeURIComponent(auth.repo) + "/contents/" + path;
  }

  function headers(auth, extra) {
    return Object.assign(
      {
        Authorization: "Bearer " + auth.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      extra || {}
    );
  }

  /** "iPhone", "Windows", … for commit messages. */
  function deviceName(userAgent) {
    const ua = String(userAgent || "");
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return "Android";
    if (/Windows/.test(ua)) return "Windows";
    if (/Mac OS X/.test(ua)) return "Mac";
    if (/Linux/.test(ua)) return "Linux";
    return "browser";
  }

  return {
    VAULT_FORMAT: VAULT_FORMAT,
    PROGRESS_PATH: PROGRESS_PATH,
    API: API,
    REVIEW_KEY: REVIEW_KEY,
    EXAM_KEY: EXAM_KEY,
    utf8: utf8,
    fromUtf8: fromUtf8,
    toBase64: toBase64,
    fromBase64: fromBase64,
    normalizePassphrase: normalizePassphrase,
    openVault: openVault,
    sealVault: sealVault,
    mergers: mergers,
    emptyDoc: emptyDoc,
    isDoc: isDoc,
    mergeDocs: mergeDocs,
    stable: stable,
    sameData: sameData,
    contentsUrl: contentsUrl,
    headers: headers,
    deviceName: deviceName,
  };
});
