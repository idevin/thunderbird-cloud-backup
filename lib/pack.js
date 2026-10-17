const MAGIC = [0x54, 0x42, 0x50, 0x4b];
export const PACK_TARGET = 32 * 1024 * 1024;

export function encodePack(chunks) {
  let payload = 0;
  for (const c of chunks) payload += 32 + 12 + 4 + c.cipher.length;
  const out = new Uint8Array(12 + payload);
  out.set(MAGIC, 0);
  out[4] = 1;
  const view = new DataView(out.buffer);
  view.setUint32(8, chunks.length, true);
  let o = 12;
  for (const c of chunks) {
    out.set(c.id, o);
    o += 32;
    out.set(c.nonce, o);
    o += 12;
    view.setUint32(o, c.cipher.length, true);
    o += 4;
    out.set(c.cipher, o);
    o += c.cipher.length;
  }
  return out;
}

export function decodePack(bytes) {
  if (
    bytes.length < 12 ||
    bytes[0] !== MAGIC[0] ||
    bytes[1] !== MAGIC[1] ||
    bytes[2] !== MAGIC[2] ||
    bytes[3] !== MAGIC[3] ||
    bytes[4] !== 1
  ) {
    throw new Error("corrupt pack");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  const chunks = [];
  let o = 12;
  for (let i = 0; i < count; i++) {
    if (o + 48 > bytes.length) throw new Error("corrupt pack");
    const id = bytes.slice(o, o + 32);
    o += 32;
    const nonce = bytes.slice(o, o + 12);
    o += 12;
    const len = view.getUint32(o, true);
    o += 4;
    if (o + len > bytes.length) throw new Error("corrupt pack");
    const cipher = bytes.slice(o, o + len);
    o += len;
    chunks.push({ id, nonce, cipher });
  }
  if (o !== bytes.length) throw new Error("extra bytes in pack");
  return chunks;
}

export function createPackBuilder() {
  const chunks = [];
  let size = 12;
  return {
    add(chunk) {
      chunks.push(chunk);
      size += 32 + 12 + 4 + chunk.cipher.length;
    },
    ready() {
      return size >= PACK_TARGET;
    },
    empty() {
      return chunks.length === 0;
    },
    build() {
      const bytes = encodePack(chunks.splice(0, chunks.length));
      size = 12;
      return bytes;
    },
  };
}

export function snapshotEnvelope(nonce, cipher) {
  const out = new Uint8Array(4 + nonce.length + cipher.length);
  out.set([0x54, 0x42, 0x53, 0x4e], 0);
  out.set(nonce, 4);
  out.set(cipher, 16);
  return out;
}

export function openSnapshotEnvelope(bytes) {
  if (bytes.length < 16 || bytes[0] !== 0x54 || bytes[1] !== 0x42 || bytes[2] !== 0x53 || bytes[3] !== 0x4e) {
    throw new Error("corrupt snapshot");
  }
  return { nonce: bytes.slice(4, 16), cipher: bytes.slice(16) };
}
