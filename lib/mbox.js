const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20];

function isFrom(bytes, i) {
  if (i < 0 || i + FROM.length > bytes.length) return false;
  for (let k = 0; k < FROM.length; k++) if (bytes[i + k] !== FROM[k]) return false;
  return true;
}

export function findLastFrom(bytes, absStart) {
  let found = -1;
  if (absStart === 0 && isFrom(bytes, 0)) found = 0;
  for (let i = 0; i + 6 <= bytes.length; i++) {
    if (bytes[i] === 0x0a && isFrom(bytes, i + 1)) found = absStart + i + 1;
  }
  return found;
}

export function sealLength(bytes, stable) {
  if (!bytes.length) return 0;
  if (stable && bytes[bytes.length - 1] === 0x0a) return bytes.length;
  const last = findLastFrom(bytes, 0);
  if (last > 0) return last;
  return 0;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function findSealEnd(readSlice, sealed, size, stable) {
  if (size <= sealed) return sealed;
  if (stable) {
    const last = await readSlice(size - 1, 1);
    if (last.length === 1 && last[0] === 0x0a) return size;
  }
  let cursor = size;
  let carry = new Uint8Array(0);
  while (cursor > sealed) {
    const win = Math.min(1024 * 1024, cursor - sealed);
    const start = cursor - win;
    const buf = await readSlice(start, win);
    const view = carry.length ? concat(buf, carry) : buf;
    const idx = findLastFrom(view, start);
    if (idx > sealed) return idx;
    carry = view.subarray(0, Math.min(5, view.length));
    cursor = start;
  }
  return sealed;
}
