async function driveFetch(url, token, options = {}, retry = 0) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token.access}`);
  const response = await fetch(url, { ...options, headers });
  if ((response.status === 401 || response.status === 429 || response.status >= 500) && retry < 4) {
    if (response.status === 401 && token.refresh) token.access = await token.refresh();
    const wait = response.status === 429 ? 1000 * 2 ** retry : 400 * 2 ** retry;
    await new Promise((resolve) => setTimeout(resolve, wait));
    return driveFetch(url, token, options, retry + 1);
  }
  return response;
}

async function ensureFolder(token) {
  const q = "name = 'ThunderbirdBackup' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  const found = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
    token,
  );
  if (!found.ok) throw new Error(`Google Drive: ${found.status}`);
  const body = await found.json();
  if (body.files?.length) return body.files[0].id;
  const created = await driveFetch("https://www.googleapis.com/drive/v3/files", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ThunderbirdBackup", mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!created.ok) throw new Error(`Google Drive folder: ${created.status}`);
  return (await created.json()).id;
}

async function findFile(token, folderId, name) {
  const q = `name = '${name.replaceAll("'", "\\'")}' and '${folderId}' in parents and trashed = false`;
  const response = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
    token,
  );
  if (!response.ok) throw new Error(`Google Drive list: ${response.status}`);
  const body = await response.json();
  return body.files?.[0]?.id || null;
}

async function upload(token, folderId, name, bytes, mime) {
  const existing = await findFile(token, folderId, name);
  const meta = { name, parents: existing ? undefined : [folderId] };
  const startUrl = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=resumable`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
  const start = await driveFetch(startUrl, token, {
    method: existing ? "PATCH" : "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mime,
      "X-Upload-Content-Length": String(bytes.length),
    },
    body: JSON.stringify(meta),
  });
  if (!start.ok) throw new Error(`Google Drive session: ${start.status}`);
  const session = start.headers.get("Location");
  const put = await fetch(session, {
    method: "PUT",
    headers: { "Content-Type": mime, "Content-Length": String(bytes.length) },
    body: bytes,
  });
  if (!put.ok) throw new Error(`Google Drive upload: ${put.status}`);
}

async function download(token, folderId, name) {
  const id = await findFile(token, folderId, name);
  if (!id) return null;
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, token);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Google Drive download: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export function createDriveCloud(token) {
  let folderId = null;
  async function folder() {
    if (!folderId) folderId = await ensureFolder(token);
    return folderId;
  }
  return {
    async getJSON(name) {
      const bytes = await download(token, await folder(), name);
      if (!bytes) return null;
      return JSON.parse(new TextDecoder().decode(bytes));
    },
    async putJSON(name, value) {
      await upload(token, await folder(), name, new TextEncoder().encode(JSON.stringify(value)), "application/json");
    },
    async getBytes(name) {
      return download(token, await folder(), name);
    },
    async putBytes(name, bytes) {
      await upload(token, await folder(), name, bytes, "application/octet-stream");
    },
    async remove(name) {
      const parent = await folder();
      const id = await findFile(token, parent, name);
      if (!id) return;
      const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}`, token, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(`Google Drive delete: ${response.status}`);
    },
  };
}
