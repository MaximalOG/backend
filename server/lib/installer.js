/**
 * Plugin/Mod installer — Pterodactyl Client API upload service.
 * Downloads .jar from Modrinth and uploads to the server via Pterodactyl.
 * Logs every install/uninstall to data/installer_history.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { LOADER_DIR } from "./modrinth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HIST_PATH = resolve(__dirname, "../../data/installer_history.json");

// ── History store ─────────────────────────────────────────────────────────────
function loadHistory() {
  if (!existsSync(HIST_PATH)) return [];
  try { return JSON.parse(readFileSync(HIST_PATH, "utf-8")); } catch { return []; }
}
function saveHistory(h) {
  mkdirSync(dirname(HIST_PATH), { recursive: true });
  writeFileSync(HIST_PATH, JSON.stringify(h, null, 2), "utf-8");
}

export function logInstall({ serverId, userId, projectId, projectName, version, loader, installedFile }) {
  const h = loadHistory();
  h.push({
    id:            `inst_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    serverId, userId, projectId, projectName, version, loader,
    installedFile,
    action:        "install",
    installedAt:   new Date().toISOString(),
  });
  saveHistory(h);
}

export function logUninstall({ serverId, userId, projectId, projectName, filename }) {
  const h = loadHistory();
  h.push({
    id:            `uninst_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    serverId, userId, projectId: projectId ?? null,
    projectName:   projectName ?? filename,
    filename,
    action:        "uninstall",
    removedAt:     new Date().toISOString(),
  });
  saveHistory(h);
}

export function getInstallerHistory(serverId) {
  return loadHistory().filter(h => h.serverId === serverId);
}

// ── Pterodactyl upload ────────────────────────────────────────────────────────

/**
 * Download a .jar from Modrinth and upload it to the Pterodactyl server.
 * Returns the uploaded filename.
 */
export async function installFile({ identifier, fileUrl, filename, targetDir }) {
  const panelUrl  = process.env.PTERODACTYL_URL?.replace(/\/$/, "");
  const clientKey = process.env.PTERODACTYL_CLIENT_KEY;
  if (!panelUrl || !clientKey) throw new Error("Pterodactyl Client API not configured.");

  // Validate URL is a Modrinth CDN URL — prevent SSRF
  const url = new URL(fileUrl);
  if (!["cdn.modrinth.com", "cdn-raw.modrinth.com"].includes(url.hostname)) {
    throw new Error("Invalid file source — only Modrinth CDN is allowed.");
  }
  if (!filename.endsWith(".jar")) {
    throw new Error("Only .jar files can be installed.");
  }
  // Prevent path traversal
  if (filename.includes("/") || filename.includes("..")) {
    throw new Error("Invalid filename.");
  }

  // 1. Download the .jar into memory
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error(`Failed to download file: ${fileRes.status}`);
  const fileBuffer = Buffer.from(await fileRes.arrayBuffer());

  // 2. Get Pterodactyl upload URL
  const uploadUrlRes = await fetch(
    `${panelUrl}/api/client/servers/${identifier}/files/upload`,
    { headers: { Authorization: `Bearer ${clientKey}`, Accept: "application/json" } }
  );
  if (!uploadUrlRes.ok) throw new Error(`Pterodactyl upload URL fetch failed: ${uploadUrlRes.status}`);
  const { attributes: { url: uploadUrl } } = await uploadUrlRes.json();

  // 3. Upload via multipart form to the target directory
  const form = new FormData();
  const blob = new Blob([fileBuffer], { type: "application/java-archive" });
  form.append("files", blob, filename);

  const uploadRes = await fetch(
    `${uploadUrl}&directory=/${targetDir}`,
    { method: "POST", body: form }
  );
  if (!uploadRes.ok) throw new Error(`File upload failed: ${uploadRes.status}`);

  return filename;
}

/**
 * Delete a file from the Pterodactyl server.
 */
export async function deleteFile({ identifier, targetDir, filename }) {
  const panelUrl  = process.env.PTERODACTYL_URL?.replace(/\/$/, "");
  const clientKey = process.env.PTERODACTYL_CLIENT_KEY;
  if (!panelUrl || !clientKey) throw new Error("Pterodactyl Client API not configured.");

  if (filename.includes("..") || filename.includes("/")) throw new Error("Invalid filename.");

  const path = `/${targetDir}/${filename}`;
  const res = await fetch(`${panelUrl}/api/client/servers/${identifier}/files/delete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${clientKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ root: "/", files: [path] }),
  });
  if (!res.ok && res.status !== 204) throw new Error(`Delete failed: ${res.status}`);
}

/**
 * List files in a directory on the Pterodactyl server.
 */
export async function listFiles({ identifier, dir }) {
  const panelUrl  = process.env.PTERODACTYL_URL?.replace(/\/$/, "");
  const clientKey = process.env.PTERODACTYL_CLIENT_KEY;
  if (!panelUrl || !clientKey) return [];

  const res = await fetch(
    `${panelUrl}/api/client/servers/${identifier}/files/list?directory=/${dir}`,
    { headers: { Authorization: `Bearer ${clientKey}`, Accept: "application/json" } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.data ?? [])
    .filter(f => f.attributes?.is_file && f.attributes?.name?.endsWith(".jar"))
    .map(f => f.attributes.name);
}
