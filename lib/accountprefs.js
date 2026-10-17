export const PREF_PREFIXES = ["mail.account.", "mail.server.", "mail.identity.", "mail.smtpserver."];

export const PREF_EXACT = [
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

export function wantedPref(name) {
  if (PREF_EXACT.includes(name)) return true;
  return PREF_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function rewritePrefs(prefs, oldPrefix, newPrefix) {
  const out = {};
  const external = [];
  for (const [name, entry] of Object.entries(prefs)) {
    const value = entry.value;
    if (typeof value === "string" && oldPrefix && value.includes(oldPrefix)) {
      out[name] = { ...entry, value: value.split(oldPrefix).join(newPrefix) };
      continue;
    }
    const uri = typeof value === "string" && (value.startsWith("imap://") || value.startsWith("mailbox://"));
    const absolute =
      typeof value === "string" &&
      value.startsWith("/") &&
      (name.endsWith(".directory") || name.startsWith("mail.root."));
    if (absolute && !uri && newPrefix && !value.startsWith(newPrefix)) external.push(name);
    out[name] = entry;
  }
  return { prefs: out, external };
}
