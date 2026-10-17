import { backupTick, restoreSnapshot, verifySnapshot } from "./lib/engine.js";
import { createRepo, openRepo } from "./lib/crypto.js";
import { createDriveCloud } from "./lib/drive.js";
import { cloudFiles, createWebdavCloud } from "./lib/webdav.js";
import { base64ToBytes, bytesToBase64, bytesToBase64Url, utf8 } from "./lib/bytes.js";

const ALARM = "cloud-backup-tick";
const status = { phase: "idle", detail: "", error: "" };
let running = false;

function api() {
  return browser.cloudBackup;
}

function report(patch) {
  Object.assign(status, patch);
}

async function loadConfig() {
  const stored = await browser.storage.local.get("config");
  return (
    stored.config || {
      backend: "nextcloud",
      nextcloud: { url: "", user: "", appPassword: "" },
      google: { clientId: "", refreshToken: "" },
    }
  );
}

async function saveConfig(config) {
  if (config.backend === "nextcloud" && config.nextcloud?.url) {
    const origin = new URL(config.nextcloud.url).origin;
    await browser.permissions.request({ origins: [`${origin}/*`] });
  }
  await browser.storage.local.set({ config });
  return { ok: true };
}

function profileIo() {
  const disk = api();
  return {
    async listFiles() {
      return JSON.parse(await disk.listFiles());
    },
    async readSlice(path, offset, length) {
      const b64 = await disk.readSlice(path, String(offset), length);
      return base64ToBytes(b64);
    },
    async readAll(path) {
      const b64 = await disk.readSmall(path);
      return b64 ? base64ToBytes(b64) : new Uint8Array();
    },
    async readBlob(name) {
      if (name.endsWith(".db")) {
        const result = JSON.parse(await disk.backupDatabase(name));
        if (result.missing) return null;
        if (result.locked || !result.b64) return null;
        return base64ToBytes(result.b64);
      }
      const b64 = await disk.readSmall(name);
      return b64 ? base64ToBytes(b64) : null;
    },
    async readState() {
      const text = await disk.readState();
      return text ? JSON.parse(text) : null;
    },
    async writeState(value) {
      await disk.writeState(JSON.stringify(value));
    },
    async accountPrefs() {
      return JSON.parse(await disk.accountPrefs());
    },
    async tbVersion() {
      return JSON.parse(await disk.profileInfo()).version;
    },
    async profileDir() {
      return JSON.parse(await disk.profileInfo()).profileDir;
    },
    async stageAddon() {
      await disk.stageAddon();
    },
    async beginFile(path) {
      await disk.beginFile(path);
    },
    async appendFile(path, bytes) {
      await disk.appendFile(path, bytesToBase64(bytes));
    },
    async beginStaging(name) {
      await disk.beginStaging(name);
    },
    async appendStaging(name, bytes) {
      await disk.appendStaging(name, bytesToBase64(bytes));
    },
    async armRestore(job) {
      await disk.armRestore(JSON.stringify(job));
    },
  };
}

async function googleToken(force = false) {
  const config = await loadConfig();
  const cached = googleToken.cache;
  if (!force && cached && cached.exp > Date.now() + 60_000) return cached.access;
  if (config.google.refreshToken) {
    const body = new URLSearchParams({
      client_id: config.google.clientId,
      grant_type: "refresh_token",
      refresh_token: config.google.refreshToken,
    });
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
    if (response.ok) {
      const json = await response.json();
      googleToken.cache = { access: json.access_token, exp: Date.now() + json.expires_in * 1000 };
      return json.access_token;
    }
  }
  const access = await interactiveGoogle(config.google.clientId);
  return access;
}

async function interactiveGoogle(clientId) {
  if (!clientId) throw new Error("Google client id is required");
  const redirect = browser.identity.getRedirectURL();
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = bytesToBase64Url(verifierBytes);
  const challenge = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(verifier))));
  const scope = "https://www.googleapis.com/auth/drive.file";
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("redirect_uri", redirect);
  auth.searchParams.set("scope", scope);
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");
  const returned = await browser.identity.launchWebAuthFlow({ url: auth.toString(), interactive: true });
  const code = new URL(returned).searchParams.get("code");
  if (!code) throw new Error("Google did not return a code");
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirect,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`Google token: ${tokenResponse.status}`);
  const json = await tokenResponse.json();
  const config = await loadConfig();
  if (json.refresh_token) config.google.refreshToken = json.refresh_token;
  await browser.storage.local.set({ config });
  googleToken.cache = { access: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

async function openCloud() {
  const config = await loadConfig();
  if (config.backend === "google") {
    const access = await googleToken(false);
    const token = {
      access,
      refresh: async () => googleToken(true),
    };
    return cloudFiles(createDriveCloud(token));
  }
  const { url, user, appPassword } = config.nextcloud;
  if (!url || !user || !appPassword) throw new Error("fill in the Nextcloud URL, user, and app password");
  return cloudFiles(createWebdavCloud({ url, user, password: appPassword }));
}

async function sessionKey() {
  const b64 = await api().getSessionKey();
  if (!b64) return null;
  return base64ToBytes(b64);
}

async function unlock(passphrase) {
  const cloud = await openCloud();
  let repo = await cloud.getRepo();
  let repoKey;
  if (!repo) {
    const created = await createRepo(passphrase);
    repo = created.repo;
    repoKey = created.repoKey;
    await cloud.putRepo(repo);
  } else {
    repoKey = await openRepo(repo, passphrase);
  }
  await api().setSessionKey(bytesToBase64(repoKey));
  await browser.alarms.create(ALARM, { periodInMinutes: 1 });
  report({ phase: "ready", detail: "passphrase accepted", error: "" });
  return { ok: true, fingerprint: repo.fingerprint };
}

async function withKey(work) {
  const repoKey = await sessionKey();
  if (!repoKey) throw new Error("enter the passphrase first");
  const cloud = await openCloud();
  return work(cloud, repoKey);
}

async function runBackup() {
  if (running) return { busy: true };
  running = true;
  report({ phase: "backup", detail: "reading mailboxes", error: "" });
  try {
    const result = await withKey((cloud, repoKey) =>
      backupTick({
        io: profileIo(),
        cloud,
        repoKey,
        onProgress: (event) => report({ phase: event.phase, detail: event.path || event.id || "" }),
      }),
    );
    if (result.empty) report({ phase: "empty", detail: "this profile has no mailboxes", error: "" });
    else report({ phase: "done", detail: result.snapshotId || "no new messages", error: "" });
    return result;
  } catch (error) {
    report({ phase: "error", error: String(error.message || error) });
    throw error;
  } finally {
    running = false;
  }
}

async function runRestore(snapshotId) {
  if (running) return { busy: true };
  running = true;
  report({ phase: "restore", detail: snapshotId, error: "" });
  try {
    const result = await withKey((cloud, repoKey) =>
      restoreSnapshot({
        io: profileIo(),
        cloud,
        repoKey,
        snapshotId,
        onProgress: (event) => report({ phase: "restore", detail: event.path || "" }),
      }),
    );
    const external = result.external?.length ? ` External paths: ${result.external.join(", ")}` : "";
    report({
      phase: "restore-armed",
      detail: `Mailboxes written.${external} Quit Thunderbird: passwords are swapped on quit, and the add-on reinstalls itself on the next launch.`,
      error: "",
    });
    return result;
  } catch (error) {
    report({ phase: "error", error: String(error.message || error) });
    throw error;
  } finally {
    running = false;
  }
}

async function runVerify(snapshotId) {
  report({ phase: "verify", detail: snapshotId, error: "" });
  const result = await withKey((cloud, repoKey) => verifySnapshot({ cloud, repoKey, snapshotId }));
  report({ phase: "done", detail: `snapshot ${result.id}: ${result.files} files, ${result.chunks} chunks`, error: "" });
  return result;
}

async function listSnapshots() {
  const cloud = await openCloud();
  const catalog = (await cloud.getCatalog()) || { snapshots: [] };
  return catalog.snapshots.slice().sort((a, b) => (a.created < b.created ? 1 : -1));
}

async function startup() {
  try {
    const reinstall = JSON.parse(await api().reinstallIfMarked());
    if (reinstall.started) report({ phase: "reinstall", detail: "add-on reinstalled", error: "" });
    else if (reinstall.error) report({ phase: "error", error: reinstall.error });
    await api().rearmIfPending();
  } catch (error) {
    report({ phase: "error", error: String(error.message || error) });
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "status") return Promise.resolve({ ...status });
  if (message.type === "config") return loadConfig();
  if (message.type === "saveConfig") return saveConfig(message.config);
  if (message.type === "redirectUri") return Promise.resolve(browser.identity.getRedirectURL());
  if (message.type === "profile") return api().profileInfo().then((text) => JSON.parse(text));
  if (message.type === "unlock") return unlock(message.passphrase);
  if (message.type === "googleAuth") return googleToken(true).then(() => ({ ok: true }));
  if (message.type === "backup") return runBackup();
  if (message.type === "snapshots") return listSnapshots();
  if (message.type === "restore") return runRestore(message.snapshotId);
  if (message.type === "verify") return runVerify(message.snapshotId);
  return Promise.resolve({ error: "unknown" });
});

browser.action.onClicked.addListener(() => browser.runtime.openOptionsPage());
browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const key = await api().getSessionKey();
  if (!key) return;
  runBackup().catch(() => {});
});
browser.runtime.onStartup.addListener(startup);
browser.runtime.onInstalled.addListener(startup);
startup();
