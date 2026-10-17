import assert from "node:assert/strict";
import test from "node:test";
import { utf8 } from "../lib/bytes.js";
import { createRepo, decryptChunk, encryptChunk, openRepo } from "../lib/crypto.js";
import { backupTick, restoreSnapshot, verifySnapshot } from "../lib/engine.js";
import { findSealEnd, sealLength } from "../lib/mbox.js";
import { decodePack, encodePack } from "../lib/pack.js";
import { rewritePrefs } from "../lib/accountprefs.js";
import { webdavRoot } from "../lib/webdav.js";

function message(subject, body) {
  return utf8(`From a@b Mon Jan 1 00:00:00 2020\nSubject: ${subject}\n\n${body}\n`);
}

test("mbox seal keeps the unfinished tail", () => {
  const first = message("one", "Hello");
  const second = message("two", "World");
  const both = new Uint8Array(first.length + second.length);
  both.set(first, 0);
  both.set(second, first.length);
  assert.equal(sealLength(both, false), first.length);
  assert.equal(sealLength(both, true), both.length);
  assert.equal(sealLength(second, false), 0);
});

test("findSealEnd walks a buffer", async () => {
  const first = message("one", "Hello");
  const second = message("two", "World");
  const both = new Uint8Array(first.length + second.length);
  both.set(first, 0);
  both.set(second, first.length);
  const readSlice = async (offset, length) => both.slice(offset, offset + length);
  assert.equal(await findSealEnd(readSlice, 0, both.length, false), first.length);
  assert.equal(await findSealEnd(readSlice, 0, both.length, true), both.length);
});

test("pack roundtrip and stable ciphertext", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const plain = utf8("same-bytes");
  const a = await encryptChunk(plain, key);
  const b = await encryptChunk(plain, key);
  assert.deepEqual(a.cipher, b.cipher);
  const packed = encodePack([a]);
  const [decoded] = decodePack(packed);
  assert.deepEqual(await decryptChunk(decoded, key), plain);
});

test("wrong passphrase does not open the repo", async () => {
  const { repo } = await createRepo("correct horse");
  await assert.rejects(() => openRepo(repo, "other horse"), /wrong passphrase/);
  const key = await openRepo(repo, "correct horse");
  assert.equal(key.length, 32);
});

test("absolute profile paths are rewritten and imap uris stay", () => {
  const oldPrefix = "/home/id/.thunderbird/old.default";
  const prefs = {
    "mail.server.server2.directory": { type: "string", value: `${oldPrefix}/ImapMail/imap.gmail.com` },
    "mail.server.server2.directory-rel": { type: "string", value: "[ProfD]ImapMail/imap.gmail.com" },
    "mail.root.imap": { type: "string", value: `${oldPrefix}/ImapMail` },
    "mail.identity.id1.draft_folder": { type: "string", value: "imap://user@gmail.com/Drafts" },
    "mail.server.server9.directory": { type: "string", value: "/srv/mail/elsewhere" },
  };
  const { prefs: next, external } = rewritePrefs(prefs, oldPrefix, "/home/id/.thunderbird/new.default");
  assert.equal(next["mail.server.server2.directory"].value, "/home/id/.thunderbird/new.default/ImapMail/imap.gmail.com");
  assert.equal(next["mail.root.imap"].value, "/home/id/.thunderbird/new.default/ImapMail");
  assert.equal(next["mail.server.server2.directory-rel"].value, "[ProfD]ImapMail/imap.gmail.com");
  assert.equal(next["mail.identity.id1.draft_folder"].value, "imap://user@gmail.com/Drafts");
  assert.deepEqual(external, ["mail.server.server9.directory"]);
});

test("webdav root", () => {
  assert.equal(
    webdavRoot("https://cloud.example", "ada"),
    "https://cloud.example/remote.php/dav/files/ada/ThunderbirdBackup",
  );
  assert.equal(
    webdavRoot("https://cloud.example/remote.php/dav/files/ada", "ada"),
    "https://cloud.example/remote.php/dav/files/ada/ThunderbirdBackup",
  );
});

function memoryCloud() {
  const files = new Map();
  const store = {
    async getJSON(name) {
      const bytes = files.get(name);
      return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    },
    async putJSON(name, value) {
      files.set(name, new TextEncoder().encode(JSON.stringify(value)));
    },
    async getBytes(name) {
      return files.get(name) || null;
    },
    async putBytes(name, bytes) {
      files.set(name, bytes);
    },
    async remove(name) {
      files.delete(name);
    },
  };
  return store;
}

function memoryProfile(files) {
  const state = { value: null };
  const written = new Map();
  const staging = new Map();
  let armed = null;
  return {
    written,
    staging,
    armed: () => armed,
    io: {
      async listFiles() {
        return [...files.entries()].map(([path, bytes]) => ({
          path,
          size: bytes.length,
          mtimeMs: 0,
          kind: path.endsWith(".dat") ? "blob" : "mbox",
        }));
      },
      async readSlice(path, offset, length) {
        return files.get(path).slice(offset, offset + length);
      },
      async readAll(path) {
        return files.get(path).slice();
      },
      async readBlob() {
        return null;
      },
      async readState() {
        return state.value;
      },
      async writeState(value) {
        state.value = value;
      },
      async accountPrefs() {
        return {
          "mail.accountmanager.accounts": { type: "string", value: "account2" },
          "mail.server.server2.directory": { type: "string", value: "/old/ImapMail/imap.gmail.com" },
        };
      },
      async tbVersion() {
        return "157.0.1";
      },
      async profileDir() {
        return "/old";
      },
      async stageAddon() {},
      async beginFile(path) {
        written.set(path, new Uint8Array());
      },
      async appendFile(path, bytes) {
        const prev = written.get(path);
        const next = new Uint8Array(prev.length + bytes.length);
        next.set(prev, 0);
        next.set(bytes, prev.length);
        written.set(path, next);
      },
      async beginStaging(name) {
        staging.set(name, new Uint8Array());
      },
      async appendStaging(name, bytes) {
        const prev = staging.get(name) || new Uint8Array();
        const next = new Uint8Array(prev.length + bytes.length);
        next.set(prev, 0);
        next.set(bytes, prev.length);
        staging.set(name, next);
      },
      async armRestore(job) {
        armed = job;
      },
    },
  };
}

test("backup seals the finished message and restore writes it back", async () => {
  const { cloudFiles } = await import("../lib/webdav.js");
  const { createRepo: makeRepo } = await import("../lib/crypto.js");
  const { repoKey } = await makeRepo("phrase");
  const cloud = cloudFiles(memoryCloud());
  const first = message("one", "Hello");
  const second = message("two", "World");
  const both = new Uint8Array(first.length + second.length);
  both.set(first, 0);
  both.set(second, first.length);
  const box = new Map([["ImapMail/imap.gmail.com/INBOX", both]]);
  const profile = memoryProfile(box);
  const now = 1_000_000;
  const partial = await backupTick({ io: profile.io, cloud, repoKey, now });
  assert.ok(partial.snapshotId);
  assert.equal(profile.io && (await profile.io.readState()).files["ImapMail/imap.gmail.com/INBOX"].sealed, first.length);

  const full = await backupTick({ io: profile.io, cloud, repoKey, now: now + 61_000 });
  assert.ok(full.snapshotId);
  const snaps = (await cloud.getCatalog()).snapshots;
  const newest = snaps.slice().sort((a, b) => (a.created < b.created ? 1 : -1))[0];
  const restored = memoryProfile(new Map());
  restored.io.profileDir = async () => "/new";
  await restoreSnapshot({ io: restored.io, cloud, repoKey, snapshotId: newest.id });
  assert.deepEqual(restored.written.get("ImapMail/imap.gmail.com/INBOX"), both);
  assert.equal(restored.armed().prefs["mail.server.server2.directory"].value, "/new/ImapMail/imap.gmail.com");
  const check = await verifySnapshot({ cloud, repoKey, snapshotId: newest.id });
  assert.equal(check.chunks > 0, true);
});
