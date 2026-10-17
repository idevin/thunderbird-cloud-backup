const $ = (id) => document.getElementById(id);

function log(text) {
  $("log").textContent = text;
}

async function send(message) {
  return browser.runtime.sendMessage(message);
}

function selectedBackend() {
  return $("backend").value;
}

function showBackend() {
  const google = selectedBackend() === "google";
  $("google-fields").hidden = !google;
  $("nextcloud-fields").hidden = google;
}

function readForm(current) {
  return {
    backend: selectedBackend(),
    nextcloud: {
      url: $("nc-url").value.trim(),
      user: $("nc-user").value.trim(),
      appPassword: $("nc-pass").value || current?.nextcloud?.appPassword || "",
    },
    google: {
      clientId: $("google-client").value.trim(),
      refreshToken: current?.google?.refreshToken || "",
    },
  };
}

async function refreshSnapshots() {
  const select = $("snapshots");
  select.replaceChildren();
  try {
    const snaps = await send({ type: "snapshots" });
    for (const snap of snaps || []) {
      const option = document.createElement("option");
      option.value = snap.id;
      option.textContent = snap.created;
      select.append(option);
    }
    if (!snaps?.length) {
      const option = document.createElement("option");
      option.textContent = "no snapshots";
      option.value = "";
      select.append(option);
    }
  } catch (error) {
    log(String(error.message || error));
  }
}

async function refreshStatus() {
  const status = await send({ type: "status" });
  if (!status) return;
  const line = [status.phase, status.detail, status.error].filter(Boolean).join(" — ");
  if (line) log(line);
}

async function init() {
  const config = await send({ type: "config" });
  $("backend").value = config.backend || "nextcloud";
  $("nc-url").value = config.nextcloud?.url || "";
  $("nc-user").value = config.nextcloud?.user || "";
  $("google-client").value = config.google?.clientId || "";
  showBackend();
  $("redirect").textContent = await send({ type: "redirectUri" });
  const profile = await send({ type: "profile" });
  const mb = (profile.mailboxBytes / (1024 * 1024)).toFixed(1);
  $("profile").textContent = `${profile.profileDir} · Thunderbird ${profile.version} · mailboxes ${mb} MiB`;
  if (profile.mailboxBytes === 0) {
    log("This profile has no mail. Install the add-on in a profile that already contains Mail or ImapMail.");
  }
  await refreshSnapshots();
  await refreshStatus();
}

$("backend").addEventListener("change", showBackend);
$("save").addEventListener("click", async () => {
  const current = await send({ type: "config" });
  await send({ type: "saveConfig", config: readForm(current) });
  log("Connection saved.");
});
$("google-auth").addEventListener("click", async () => {
  const current = await send({ type: "config" });
  await send({ type: "saveConfig", config: readForm(current) });
  try {
    await send({ type: "googleAuth" });
    log("Signed in to Google.");
  } catch (error) {
    log(String(error.message || error));
  }
});
$("unlock").addEventListener("click", async () => {
  try {
    const result = await send({ type: "unlock", passphrase: $("passphrase").value });
    log(`Storage unlocked. Key fingerprint: ${result.fingerprint}`);
    await refreshSnapshots();
  } catch (error) {
    log(String(error.message || error));
  }
});
$("backup").addEventListener("click", async () => {
  try {
    const result = await send({ type: "backup" });
    log(result.empty ? "This profile has no mailboxes." : `Done. Snapshot: ${result.snapshotId || "unchanged"}`);
    await refreshSnapshots();
  } catch (error) {
    log(String(error.message || error));
  }
});
$("refresh").addEventListener("click", refreshSnapshots);
$("verify").addEventListener("click", async () => {
  const snapshotId = $("snapshots").value;
  if (!snapshotId) return;
  try {
    const result = await send({ type: "verify", snapshotId });
    log(`Snapshot ${result.created}: ${result.files} files, ${result.chunks} chunks.`);
  } catch (error) {
    log(String(error.message || error));
  }
});
$("restore").addEventListener("click", async () => {
  const snapshotId = $("snapshots").value;
  if (!snapshotId) return;
  if (!confirm("Write this snapshot's mailboxes into the current profile? Do this in an empty profile.")) return;
  try {
    const result = await send({ type: "restore", snapshotId });
    const extra = result.external?.length ? `\nPaths outside the old profile: ${result.external.join(", ")}` : "";
    log(`Mailboxes written.${extra}\nQuit Thunderbird. Passwords are swapped on quit, and the add-on reinstalls itself on the next launch.`);
  } catch (error) {
    log(String(error.message || error));
  }
});

init().catch((error) => log(String(error.message || error)));
setInterval(() => refreshStatus().catch(() => {}), 2000);
