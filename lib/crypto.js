import { argon2idAsync } from "./vendor/hashes/argon2.js";
import { bytesToBase64, base64ToBytes, bytesToHex, utf8 } from "./bytes.js";

const KDF = { t: 3, m: 19456, p: 1, dkLen: 32 };

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function importAes(key) {
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function deriveKek(passphrase, salt) {
  return new Uint8Array(await argon2idAsync(utf8(passphrase), salt, KDF));
}

export async function createRepo(passphrase) {
  const repoKey = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await deriveKek(passphrase, salt);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aes = await importAes(kek);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, repoKey));
  const fingerprint = bytesToHex((await sha256(repoKey)).slice(0, 8));
  return {
    repoKey,
    repo: {
      v: 1,
      kdf: "argon2id",
      t: KDF.t,
      m: KDF.m,
      p: KDF.p,
      salt: bytesToBase64(salt),
      nonce: bytesToBase64(nonce),
      wrappedKey: bytesToBase64(wrapped),
      fingerprint,
    },
  };
}

export async function openRepo(repo, passphrase) {
  const kek = await deriveKek(passphrase, base64ToBytes(repo.salt));
  const aes = await importAes(kek);
  let repoKey;
  try {
    repoKey = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(repo.nonce) }, aes, base64ToBytes(repo.wrappedKey)),
    );
  } catch {
    throw new Error("wrong passphrase");
  }
  const fingerprint = bytesToHex((await sha256(repoKey)).slice(0, 8));
  if (fingerprint !== repo.fingerprint) throw new Error("wrong passphrase");
  return repoKey;
}

export async function encryptChunk(plain, repoKey) {
  const id = await sha256(plain);
  const nonce = id.slice(0, 12);
  const aes = await importAes(repoKey);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
  return { id, nonce, cipher };
}

export async function decryptChunk(chunk, repoKey) {
  const aes = await importAes(repoKey);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: chunk.nonce }, aes, chunk.cipher));
  const id = await sha256(plain);
    for (let i = 0; i < 32; i++) if (id[i] !== chunk.id[i]) throw new Error("chunk does not match");
  return plain;
}

export async function encryptJson(value, repoKey) {
  const plain = utf8(JSON.stringify(value));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aes = await importAes(repoKey);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
  return { nonce, cipher };
}

export async function decryptJson(nonce, cipher, repoKey) {
  const aes = await importAes(repoKey);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, cipher);
  return JSON.parse(new TextDecoder().decode(plain));
}
