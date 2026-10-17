export function webdavRoot(url, user) {
  const base = url.replace(/\/+$/, "");
  if (base.includes("/remote.php/dav/files/")) {
    return base.endsWith("/ThunderbirdBackup") ? base : `${base}/ThunderbirdBackup`;
  }
  return `${base}/remote.php/dav/files/${encodeURIComponent(user)}/ThunderbirdBackup`;
}

function authHeader(user, password) {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

async function dav(root, user, password, path, options = {}, retry = 0) {
  const response = await fetch(`${root}/${path}`.replace(/([^:])\/{2,}/g, "$1/"), {
    ...options,
    headers: { Authorization: authHeader(user, password), ...(options.headers || {}) },
  });
  if ((response.status === 429 || response.status >= 500) && retry < 4) {
    await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** retry));
    return dav(root, user, password, path, options, retry + 1);
  }
  return response;
}

async function ensureCollection(root, user, password) {
  const response = await dav(root, user, password, "", { method: "MKCOL" });
  if (!response.ok && response.status !== 405 && response.status !== 301 && response.status !== 409) {
    const parent = root.slice(0, root.lastIndexOf("/"));
    const folder = root.slice(root.lastIndexOf("/") + 1);
    const made = await fetch(`${parent}/${folder}`, { method: "MKCOL", headers: { Authorization: authHeader(user, password) } });
    if (!made.ok && made.status !== 405) throw new Error(`Nextcloud MKCOL: ${made.status}`);
  }
}

export function createWebdavCloud({ url, user, password }) {
  const root = webdavRoot(url, user);
  let ready = false;
  async function prepare() {
    if (ready) return;
    await ensureCollection(root, user, password);
    ready = true;
  }
  return {
    async getJSON(name) {
      await prepare();
      const response = await dav(root, user, password, name);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Nextcloud GET ${name}: ${response.status}`);
      return response.json();
    },
    async putJSON(name, value) {
      await prepare();
      const response = await dav(root, user, password, name, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error(`Nextcloud PUT ${name}: ${response.status}`);
    },
    async getBytes(name) {
      await prepare();
      const response = await dav(root, user, password, name);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Nextcloud GET ${name}: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async putBytes(name, bytes) {
      await prepare();
      const response = await dav(root, user, password, name, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });
      if (!response.ok) throw new Error(`Nextcloud PUT ${name}: ${response.status}`);
    },
    async remove(name) {
      await prepare();
      const response = await dav(root, user, password, name, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(`Nextcloud DELETE ${name}: ${response.status}`);
    },
  };
}

export function cloudFiles(store) {
  return {
    async getRepo() {
      return store.getJSON("repo.json");
    },
    async putRepo(repo) {
      await store.putJSON("repo.json", repo);
    },
    async getChunkIndex() {
      return store.getJSON("chunk-index.json");
    },
    async putChunkIndex(index) {
      await store.putJSON("chunk-index.json", index);
    },
    async getCatalog() {
      return store.getJSON("catalog.json");
    },
    async putCatalog(catalog) {
      await store.putJSON("catalog.json", catalog);
    },
    async putPack(id, bytes) {
      await store.putBytes(`packs/${id}.bin`, bytes);
    },
    async getPack(id) {
      const bytes = await store.getBytes(`packs/${id}.bin`);
      if (!bytes) throw new Error(`missing pack ${id}`);
      return bytes;
    },
    async deletePack(id) {
      await store.remove(`packs/${id}.bin`);
    },
    async putSnapshot(id, bytes) {
      await store.putBytes(`snapshots/${id}.bin`, bytes);
    },
    async getSnapshot(id) {
      const bytes = await store.getBytes(`snapshots/${id}.bin`);
      if (!bytes) throw new Error(`missing snapshot ${id}`);
      return bytes;
    },
    async deleteSnapshot(id) {
      await store.remove(`snapshots/${id}.bin`);
    },
  };
}
