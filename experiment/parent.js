"use strict";

const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
const { IOUtils } = ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs");
const { PathUtils } = ChromeUtils.importESModule("resource://gre/modules/PathUtils.sys.mjs");
const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
const { Services } = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs");
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { AsyncShutdown } = ChromeUtils.importESModule("resource://gre/modules/AsyncShutdown.sys.mjs");

const PREF_PREFIXES = ["mail.account.", "mail.server.", "mail.identity.", "mail.smtpserver."];
const PREF_EXACT = [
  "mail.accountmanager.accounts",
  "mail.accountmanager.defaultaccount",
  "mail.accountmanager.localfoldersserver",
  "mail.smtp.defaultserver",
  "mail.smtpservers",
  "mail.root.imap",
  "mail.root.imap-rel",
  "mail.root.none",
  "mail.root.none-rel",
];
const MAIL_ROOTS = ["Mail", "ImapMail", "News"];
const SQLITE_BLOBS = new Set(["key4.db", "cert9.db", "logins.db"]);

let sessionKey = "";
let blockerArmed = false;

function json(value) {
  return JSON.stringify(value);
}

function bytesToBase64(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const slice = bytes.subarray(i, Math.min(i + 8192, bytes.length));
    parts.push(String.fromCharCode.apply(null, slice));
  }
  return btoa(parts.join(""));
}

function base64ToBytes(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function profileDir() {
  return PathUtils.profileDir;
}

function safeJoin(rel) {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..")) {
    throw new Error(`bad path: ${rel}`);
  }
  return PathUtils.join(profileDir(), ...rel.split("/"));
}

function stagingDir() {
  return PathUtils.join(profileDir(), "cloud-backup-staging");
}

async function ensureStaging() {
  await IOUtils.makeDirectory(stagingDir(), { ignoreExisting: true, createAncestors: true });
}

function wantedPref(name) {
  return PREF_EXACT.includes(name) || PREF_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function readPref(name) {
  const type = Services.prefs.getPrefType(name);
  if (type === Services.prefs.PREF_STRING) return { type: "string", value: Services.prefs.getStringPref(name) };
  if (type === Services.prefs.PREF_INT) return { type: "int", value: Services.prefs.getIntPref(name) };
  if (type === Services.prefs.PREF_BOOL) return { type: "bool", value: Services.prefs.getBoolPref(name) };
  return null;
}

function setPref(name, entry) {
  if (entry.type === "string") Services.prefs.setStringPref(name, entry.value);
  else if (entry.type === "int") Services.prefs.setIntPref(name, entry.value | 0);
  else if (entry.type === "bool") Services.prefs.setBoolPref(name, !!entry.value);
}

async function walk(abs, rel, out) {
  let kids = [];
  try {
    kids = await IOUtils.getChildren(abs);
  } catch {
    return;
  }
  for (const kid of kids) {
    const child = typeof kid === "string" ? kid : kid.path;
    const name = PathUtils.filename(child);
    if (!name || name.startsWith(".")) continue;
    const st = await IOUtils.stat(child);
    const childRel = rel ? `${rel}/${name}` : name;
    if (st.type === "directory") {
      await walk(child, childRel, out);
      continue;
    }
    if (name.endsWith(".msf") || name.endsWith(".html")) continue;
    if (name.endsWith(".dat") && name !== "msgFilterRules.dat") continue;
    out.push({
      path: childRel,
      size: st.size,
      mtimeMs: st.lastModified,
      kind: name.endsWith(".dat") ? "blob" : "mbox",
    });
  }
}

async function listMailboxFiles() {
  const out = [];
  for (const root of MAIL_ROOTS) {
    const abs = PathUtils.join(profileDir(), root);
    if (await IOUtils.exists(abs)) await walk(abs, root, out);
  }
  const virtuals = PathUtils.join(profileDir(), "virtualFolders.dat");
  if (await IOUtils.exists(virtuals)) {
    const st = await IOUtils.stat(virtuals);
    out.push({ path: "virtualFolders.dat", size: st.size, mtimeMs: st.lastModified, kind: "blob" });
  }
  return out;
}

async function writeBytes(abs, bytes, append) {
  await IOUtils.makeDirectory(PathUtils.parent(abs), { ignoreExisting: true, createAncestors: true });
  if (append) await IOUtils.write(abs, bytes, { mode: "append" });
  else await IOUtils.write(abs, bytes, { mode: "overwrite" });
}

function fileFromSpec(spec) {
  let url = spec;
  if (url.startsWith("jar:")) url = url.slice(4).replace(/!\/?$/, "");
  const uri = Services.io.newURI(url);
  return uri.QueryInterface(Components.interfaces.nsIFileURL).file;
}

async function zipDirectory(dir, dest) {
  const zip = Components.classes["@mozilla.org/zipwriter;1"].createInstance(Components.interfaces.nsIZipWriter);
  zip.open(new FileUtils.File(dest), 0x04 | 0x08 | 0x20);
  const skip = new Set(["node_modules", ".git", "cloud-backup-staging", "releases", "test"]);
  function add(file, prefix) {
    const entries = file.directoryEntries;
    while (entries.hasMoreElements()) {
      const child = entries.getNext().QueryInterface(Components.interfaces.nsIFile);
      if (skip.has(child.leafName)) continue;
      const name = prefix ? `${prefix}/${child.leafName}` : child.leafName;
      if (child.isDirectory()) add(child, name);
      else zip.addEntryFile(name, Components.interfaces.nsIZipWriter.COMPRESSION_DEFAULT, child, false);
    }
  }
  try {
    add(dir, "");
  } finally {
    zip.close();
  }
}

async function readJob() {
  const path = PathUtils.join(stagingDir(), "restore-job.json");
  if (!(await IOUtils.exists(path))) return null;
  return JSON.parse(new TextDecoder().decode(await IOUtils.read(path)));
}

async function writeJob(job) {
  await ensureStaging();
  await IOUtils.write(PathUtils.join(stagingDir(), "restore-job.json"), new TextEncoder().encode(JSON.stringify(job)));
}

async function applyRestore() {
  const job = await readJob();
  if (!job || job.passwordsDone) return;
  for (const [name, entry] of Object.entries(job.prefs || {})) setPref(name, entry);
  let failed = false;
  for (const name of job.swaps || []) {
    const from = PathUtils.join(stagingDir(), name);
    const to = safeJoin(name);
    if (!(await IOUtils.exists(from))) continue;
    const backup = `${to}.replaced`;
    try {
      if (await IOUtils.exists(backup)) await IOUtils.remove(backup);
      if (await IOUtils.exists(to)) await IOUtils.move(to, backup);
      await IOUtils.move(from, to);
      if (await IOUtils.exists(backup)) await IOUtils.remove(backup);
    } catch {
      if (!(await IOUtils.exists(to)) && (await IOUtils.exists(backup))) await IOUtils.move(backup, to);
      failed = true;
    }
  }
  if (failed) {
    await writeJob(job);
    return;
  }
  job.passwordsDone = true;
  await writeJob(job);
  await IOUtils.write(
    PathUtils.join(stagingDir(), "reinstall.json"),
    new TextEncoder().encode(JSON.stringify({ at: Date.now() })),
  );
}

function armBlocker() {
  if (blockerArmed) return;
  blockerArmed = true;
  AsyncShutdown.profileBeforeChange.addBlocker("Cloud Backup restore", () => applyRestore());
}

async function installStaged() {
  const xpi = PathUtils.join(stagingDir(), "addon.xpi");
  const marker = PathUtils.join(stagingDir(), "reinstall.json");
  if (!(await IOUtils.exists(marker)) || !(await IOUtils.exists(xpi))) return json({ started: false });
  const install = await AddonManager.getInstallForFile(new FileUtils.File(xpi));
  await new Promise((resolve, reject) => {
    const listener = {
      onInstallEnded() {
        install.removeListener(listener);
        resolve();
      },
      onInstallFailed() {
        install.removeListener(listener);
        reject(new Error("reinstall failed"));
      },
      onDownloadFailed() {
        install.removeListener(listener);
        reject(new Error("reinstall failed"));
      },
    };
    install.addListener(listener);
    install.install();
  });
  await IOUtils.remove(marker);
  return json({ started: true });
}

this.cloudBackup = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      cloudBackup: {
        async profileInfo() {
          const files = await listMailboxFiles();
          const mailboxBytes = files.filter((file) => file.kind === "mbox").reduce((sum, file) => sum + file.size, 0);
          return json({
            profileDir: profileDir(),
            version: Services.appinfo.version,
            fileCount: files.length,
            mailboxBytes,
          });
        },
        async listFiles() {
          return json(await listMailboxFiles());
        },
        async readSlice(relPath, offset, length) {
          const bytes = await IOUtils.read(safeJoin(relPath), { offset: Number(offset), maxBytes: length });
          return bytesToBase64(bytes);
        },
        async readSmall(relPath) {
          const abs = safeJoin(relPath);
          if (!(await IOUtils.exists(abs))) return "";
          return bytesToBase64(await IOUtils.read(abs));
        },
        async backupDatabase(relPath) {
          const abs = safeJoin(relPath);
          if (!(await IOUtils.exists(abs))) return json({ missing: true });
          if (!SQLITE_BLOBS.has(relPath)) return json({ missing: true });
          await ensureStaging();
          const backupName = `${relPath}.bak`;
          const dest = PathUtils.join(stagingDir(), backupName);
          try {
            if (await IOUtils.exists(dest)) await IOUtils.remove(dest);
            Services.storage.backupDatabaseFile(new FileUtils.File(abs), backupName, new FileUtils.File(stagingDir()));
            const bytes = await IOUtils.read(dest);
            await IOUtils.remove(dest);
            return json({ b64: bytesToBase64(bytes) });
          } catch (error) {
            return json({ locked: true, error: String(error) });
          }
        },
        async readState() {
          const path = PathUtils.join(profileDir(), "cloud-backup-state.json");
          if (!(await IOUtils.exists(path))) return "";
          return new TextDecoder().decode(await IOUtils.read(path));
        },
        async writeState(text) {
          await IOUtils.write(PathUtils.join(profileDir(), "cloud-backup-state.json"), new TextEncoder().encode(text));
          return "ok";
        },
        async accountPrefs() {
          const prefs = {};
          const names = new Set(PREF_EXACT);
          for (const prefix of PREF_PREFIXES) {
            for (const name of Services.prefs.getChildList(prefix)) names.add(name);
          }
          for (const name of names) {
            if (!wantedPref(name)) continue;
            const entry = readPref(name);
            if (entry) prefs[name] = entry;
          }
          return json(prefs);
        },
        async stageAddon() {
          await ensureStaging();
          const dest = PathUtils.join(stagingDir(), "addon.xpi");
          const source = fileFromSpec(context.extension.rootURI.spec);
          if (source.isFile()) await IOUtils.copy(source.path, dest);
          else await zipDirectory(source, dest);
          return dest;
        },
        async beginFile(relPath) {
          await writeBytes(safeJoin(relPath), new Uint8Array(), false);
          return "ok";
        },
        async appendFile(relPath, b64) {
          await writeBytes(safeJoin(relPath), base64ToBytes(b64), true);
          return "ok";
        },
        async beginStaging(name) {
          await ensureStaging();
          await writeBytes(PathUtils.join(stagingDir(), name), new Uint8Array(), false);
          return "ok";
        },
        async appendStaging(name, b64) {
          await ensureStaging();
          await writeBytes(PathUtils.join(stagingDir(), name), base64ToBytes(b64), true);
          return "ok";
        },
        async armRestore(text) {
          const job = JSON.parse(text);
          job.passwordsDone = false;
          await writeJob(job);
          armBlocker();
          return "ok";
        },
        async rearmIfPending() {
          const job = await readJob();
          if (job && !job.passwordsDone) armBlocker();
          return json({ pending: !!(job && !job.passwordsDone) });
        },
        async reinstallIfMarked() {
          try {
            return await installStaged();
          } catch (error) {
            return json({ started: false, error: String(error) });
          }
        },
        setSessionKey(b64) {
          sessionKey = b64 || "";
          return Promise.resolve("ok");
        },
        getSessionKey() {
          return Promise.resolve(sessionKey || "");
        },
      },
    };
  }
};
