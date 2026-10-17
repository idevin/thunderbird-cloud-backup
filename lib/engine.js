import { bytesToBase64, bytesToHex, equalBytes, base64ToBytes } from "./bytes.js";
import { createChunker } from "./fastcdc.js";
import { findSealEnd } from "./mbox.js";
import { createPackBuilder, decodePack, openSnapshotEnvelope, snapshotEnvelope } from "./pack.js";
import { decryptChunk, decryptJson, encryptChunk, encryptJson, sha256 } from "./crypto.js";
import { rewritePrefs } from "./accountprefs.js";

const SLICE = 8 * 1024 * 1024;
const QUIET_MS = 60_000;
const MARK = 64;
const KEEP_SNAPSHOTS = 3;
export const BLOB_NAMES = ["key4.db", "cert9.db", "logins.db", "logins.json", "logins-backup.json", "pkcs11.txt"];

function markerBytes(bytes, offset) {
  const start = Math.max(0, offset - MARK);
  return bytes.subarray(start, offset);
}

async function readMarker(io, path, offset) {
  if (offset <= 0) return new Uint8Array(0);
  const start = Math.max(0, offset - MARK);
  return io.readSlice(path, start, offset - start);
}

export async function backupTick({ io, cloud, repoKey, now = Date.now(), onProgress = () => {} }) {
  const listed = await io.listFiles();
  const mbox = listed.filter((file) => file.kind === "mbox" && file.size > 0);
  if (!mbox.length) return { empty: true, uploaded: 0, sealed: 0 };

  const state = (await io.readState()) || {};
  state.files ||= {};
  state.blobs ||= {};
  const index = (await cloud.getChunkIndex()) || {};
  const builder = createPackBuilder();
  const pending = [];
  const inflight = new Set();
  let uploaded = 0;
  let sealed = 0;
  let changed = false;

  async function pump(job) {
    const task = job.finally(() => inflight.delete(task));
    inflight.add(task);
    if (inflight.size >= 3) await Promise.race(inflight);
  }

  async function flush(force) {
    if (builder.empty()) return;
    if (!force && !builder.ready()) return;
    const batch = pending.splice(0, pending.length);
    const bytes = builder.build();
    const packId = bytesToHex(await sha256(bytes));
    await pump(
      cloud.putPack(packId, bytes).then(() => {
        uploaded += bytes.length;
        for (const item of batch) index[item] = packId;
      }),
    );
    onProgress({ phase: "upload", uploaded });
  }

  async function keepPlain(plain, rec, start) {
    const enc = await encryptChunk(plain, repoKey);
    const id = bytesToHex(enc.id);
    if (!index[id] && !pending.includes(id)) {
      pending.push(id);
      builder.add(enc);
    }
    rec.chunks.push({ id, start, length: plain.length });
    if (builder.ready()) await flush(false);
  }

  async function ingest(path, rec, from, to) {
    const chunker = createChunker();
    let emitted = 0;
    let pos = from;
    while (pos < to) {
      const slice = await io.readSlice(path, pos, Math.min(SLICE, to - pos));
      if (!slice.length) break;
      for (const part of chunker.push(slice)) {
        await keepPlain(part, rec, from + emitted);
        emitted += part.length;
      }
      pos += slice.length;
    }
    for (const part of chunker.finish()) {
      await keepPlain(part, rec, from + emitted);
      emitted += part.length;
    }
    rec.sealed = to;
    rec.marker = bytesToBase64(await readMarker(io, path, to));
    sealed += to - from;
  }

  for (const file of listed) {
    if (file.kind === "blob") {
      const bytes = await io.readAll(file.path);
      const hash = bytesToHex(await sha256(bytes));
      const rec = state.files[file.path] || { chunks: [] };
      if (rec.hash === hash) continue;
      rec.chunks = [];
      rec.hash = hash;
      rec.kind = "blob";
      await keepPlain(bytes, rec, 0);
      state.files[file.path] = rec;
      changed = true;
      continue;
    }
    if (file.kind !== "mbox" || file.size <= 0) continue;
    const rec = state.files[file.path] || { sealed: 0, chunks: [], sizeSeen: 0, changedAt: 0, marker: "" };
    rec.chunks ||= [];
    const sizeChanged = file.size !== rec.sizeSeen;
    if (sizeChanged) {
      rec.sizeSeen = file.size;
      rec.changedAt = now;
    }
    const stable = !sizeChanged && now - rec.changedAt >= QUIET_MS;
    if (rec.sealed > file.size) rec.dirty = true;
    if (rec.sealed > 0 && !rec.dirty) {
      const have = base64ToBytes(rec.marker || "");
      if (have.length) {
        const start = rec.sealed - have.length;
        const got = await io.readSlice(file.path, start, have.length);
        if (!equalBytes(got, have)) rec.dirty = true;
      }
    }
    if (rec.dirty) {
      if (!stable) {
        state.files[file.path] = rec;
        continue;
      }
      rec.sealed = 0;
      rec.chunks = [];
      rec.dirty = false;
      rec.marker = "";
    }
    if (file.size < rec.sealed) continue;
    const sealEnd = await findSealEnd((offset, length) => io.readSlice(file.path, offset, length), rec.sealed, file.size, stable);
    if (sealEnd <= rec.sealed) {
      state.files[file.path] = rec;
      continue;
    }
    await ingest(file.path, rec, rec.sealed, sealEnd);
    state.files[file.path] = rec;
    changed = true;
    onProgress({ phase: "seal", path: file.path, sealed: rec.sealed, size: file.size });
  }

  for (const name of BLOB_NAMES) {
    const bytes = await io.readBlob(name);
    if (!bytes) continue;
    const hash = bytesToHex(await sha256(bytes));
    if (state.blobs[name] === hash) continue;
    const enc = await encryptChunk(bytes, repoKey);
    const id = bytesToHex(enc.id);
    if (!index[id]) {
      pending.push(id);
      builder.add(enc);
    }
    state.blobs[name] = hash;
    state.files[name] = { kind: "password", chunks: [{ id, start: 0, length: bytes.length }], hash };
    changed = true;
  }

  await flush(true);
  await Promise.all([...inflight]);
  if (uploaded) await cloud.putChunkIndex(index);
  await io.writeState(state);

  if (!changed) return { empty: false, uploaded, sealed, snapshotId: null };

  const files = [];
  const blobs = [];
  const packs = new Set();
  for (const [path, rec] of Object.entries(state.files)) {
    const chunks = (rec.chunks || []).map((chunk) => ({ ...chunk, pack: index[chunk.id] || chunk.pack || null }));
    for (const chunk of chunks) if (chunk.pack) packs.add(chunk.pack);
    if (rec.kind === "password" || BLOB_NAMES.includes(path)) {
      blobs.push({ path, size: chunks.reduce((sum, chunk) => sum + chunk.length, 0), chunks });
    } else {
      files.push({ path, kind: rec.kind || "mbox", size: rec.sealed || 0, chunks });
    }
  }
  const snapshot = {
    v: 1,
    id: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    created: new Date(now).toISOString(),
    tbVersion: await io.tbVersion(),
    profilePrefix: await io.profileDir(),
    files,
    blobs,
    prefs: await io.accountPrefs(),
  };
  const packed = await encryptJson(snapshot, repoKey);
  await cloud.putSnapshot(snapshot.id, snapshotEnvelope(packed.nonce, packed.cipher));
  const catalog = (await cloud.getCatalog()) || { snapshots: [] };
  catalog.snapshots.push({ id: snapshot.id, created: snapshot.created, packs: [...packs] });
  await cloud.putCatalog(catalog);
  await gc(cloud, catalog, index);
  onProgress({ phase: "snapshot", id: snapshot.id });
  return { empty: false, uploaded, sealed, snapshotId: snapshot.id };
}

async function gc(cloud, catalog, index) {
  const snaps = [...catalog.snapshots].sort((a, b) => (a.created < b.created ? 1 : -1));
  const keep = new Set(snaps.slice(0, KEEP_SNAPSHOTS).flatMap((snap) => snap.packs || []));
  const drop = [];
  for (const snap of snaps.slice(KEEP_SNAPSHOTS)) {
    for (const pack of snap.packs || []) if (!keep.has(pack)) drop.push(pack);
  }
  const unique = [...new Set(drop)];
  for (const pack of unique) {
    await cloud.deletePack(pack);
    for (const [id, owner] of Object.entries(index)) if (owner === pack) delete index[id];
  }
  for (const snap of snaps.slice(KEEP_SNAPSHOTS)) {
    if (cloud.deleteSnapshot) await cloud.deleteSnapshot(snap.id);
  }
  if (unique.length) await cloud.putChunkIndex(index);
  catalog.snapshots = snaps.slice(0, KEEP_SNAPSHOTS);
  await cloud.putCatalog(catalog);
}

export async function loadSnapshot(cloud, repoKey, snapshotId) {
  const bytes = await cloud.getSnapshot(snapshotId);
  const env = openSnapshotEnvelope(bytes);
  return decryptJson(env.nonce, env.cipher, repoKey);
}

async function plainFromPack(cloud, repoKey, cache, packId, chunkId) {
  if (cache.id !== packId) {
    const parts = decodePack(await cloud.getPack(packId));
    const map = new Map();
    for (const part of parts) map.set(bytesToHex(part.id), await decryptChunk(part, repoKey));
    cache.id = packId;
    cache.map = map;
  }
  const plain = cache.map.get(chunkId);
  if (!plain) throw new Error(`pack is missing chunk ${chunkId}`);
  return plain;
}

export async function restoreSnapshot({ io, cloud, repoKey, snapshotId, onProgress = () => {} }) {
  const snap = await loadSnapshot(cloud, repoKey, snapshotId);
  const profileDir = await io.profileDir();
  const { prefs, external } = rewritePrefs(snap.prefs || {}, snap.profilePrefix, profileDir);
  await io.stageAddon();
  const cache = { id: null, map: null };
  const files = [...(snap.files || []), ...(snap.blobs || []).map((blob) => ({ ...blob, password: true }))];
  for (const file of files) {
    onProgress({ phase: "restore", path: file.path });
    if (file.password) await io.beginStaging(file.path);
    else await io.beginFile(file.path);
    for (const chunk of file.chunks || []) {
      const plain = await plainFromPack(cloud, repoKey, cache, chunk.pack, chunk.id);
      if (file.password) await io.appendStaging(file.path, plain);
      else await io.appendFile(file.path, plain);
    }
  }
  await io.armRestore({
    prefs,
    swaps: (snap.blobs || []).map((blob) => blob.path),
    snapshotId,
  });
  return { external, snapshotId: snap.id };
}

export async function verifySnapshot({ cloud, repoKey, snapshotId }) {
  const snap = await loadSnapshot(cloud, repoKey, snapshotId);
  const cache = { id: null, map: null };
  let chunks = 0;
  for (const file of [...(snap.files || []), ...(snap.blobs || [])]) {
    for (const chunk of file.chunks || []) {
      await plainFromPack(cloud, repoKey, cache, chunk.pack, chunk.id);
      chunks += 1;
    }
  }
  return { id: snap.id, created: snap.created, files: (snap.files || []).length, chunks };
}
