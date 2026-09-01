/**
 * Modrinth API service — V1 plugin/mod source.
 * Structured so CurseForge and Hangar can be added later
 * by implementing the same interface in separate files.
 */

const MODRINTH_BASE = "https://api.modrinth.com/v2";

// Loader → install directory mapping
export const LOADER_DIR = {
  paper:     "plugins",
  purpur:    "plugins",
  spigot:    "plugins",
  bukkit:    "plugins",
  fabric:    "mods",
  forge:     "mods",
  neoforge:  "mods",
  quilt:     "mods",
};

// Server software → Modrinth loader facets
export const SOFTWARE_LOADERS = {
  paper:     ["paper", "spigot", "bukkit"],
  purpur:    ["purpur", "paper", "spigot"],
  spigot:    ["spigot", "bukkit"],
  fabric:    ["fabric"],
  forge:     ["forge"],
  neoforge:  ["neoforge", "forge"],
};

async function mfetch(path) {
  const res = await fetch(`${MODRINTH_BASE}${path}`, {
    headers: { "User-Agent": "NetherNodes/1.0 (support@nethernodes.online)" },
  });
  if (!res.ok) throw new Error(`Modrinth error ${res.status} on ${path}`);
  return res.json();
}

/**
 * Search Modrinth for plugins or mods.
 * @param {object} opts
 * @param {string} opts.query
 * @param {"plugin"|"mod"|"all"} opts.type
 * @param {string} [opts.serverSoftware]   e.g. "paper"
 * @param {string} [opts.mcVersion]        e.g. "1.21.4"
 * @param {number} [opts.page]
 * @param {number} [opts.limit]
 */
export async function searchProjects({ query = "", type = "all", serverSoftware, mcVersion, page = 0, limit = 20 }) {
  const facets = [];

  if (type === "plugin") {
    facets.push(["project_type:plugin"]);
  } else if (type === "mod") {
    facets.push(["project_type:mod"]);
  } else {
    facets.push(["project_type:plugin", "project_type:mod"]);
  }

  if (mcVersion) {
    facets.push([`versions:${mcVersion}`]);
  }

  if (serverSoftware) {
    const loaders = SOFTWARE_LOADERS[serverSoftware.toLowerCase()] ?? [];
    if (loaders.length > 0) {
      facets.push(loaders.map(l => `categories:${l}`));
    }
  }

  const params = new URLSearchParams({
    query,
    limit:  String(limit),
    offset: String(page * limit),
    index:  "downloads",
    facets: JSON.stringify(facets),
  });

  const data = await mfetch(`/search?${params}`);

  return {
    hits:       data.hits.map(normalizeProject),
    totalHits:  data.total_hits,
    page,
    limit,
    pages:      Math.ceil(data.total_hits / limit),
  };
}

/** Get a single project by ID or slug. */
export async function getProject(projectId) {
  const [project, versions] = await Promise.all([
    mfetch(`/project/${projectId}`),
    mfetch(`/project/${projectId}/version?limit=5`).catch(() => []),
  ]);
  return { ...normalizeProject(project), versions: versions.slice(0, 5).map(normalizeVersion) };
}

/**
 * Get the best compatible version for a project.
 * Prefers exact MC version + server software loader match.
 */
export async function getBestVersion(projectId, { mcVersion, serverSoftware }) {
  const loaders = serverSoftware
    ? (SOFTWARE_LOADERS[serverSoftware.toLowerCase()] ?? [])
    : [];

  let url = `/project/${projectId}/version`;
  const params = [];
  if (mcVersion)       params.push(`game_versions=["${mcVersion}"]`);
  if (loaders.length)  params.push(`loaders=${JSON.stringify(loaders)}`);
  if (params.length)   url += `?${params.join("&")}`;

  const versions = await mfetch(url).catch(() => []);
  if (!versions.length) return null;

  // Sort: prefer exact MC version match, then most recent
  const sorted = versions.sort((a, b) => {
    const aMatch = mcVersion ? a.game_versions.includes(mcVersion) : true;
    const bMatch = mcVersion ? b.game_versions.includes(mcVersion) : true;
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;
    return new Date(b.date_published) - new Date(a.date_published);
  });

  return normalizeVersion(sorted[0]);
}

function normalizeProject(p) {
  return {
    id:           p.project_id ?? p.id,
    slug:         p.slug,
    title:        p.title,
    description:  p.description,
    author:       p.author,
    iconUrl:      p.icon_url ?? null,
    downloads:    p.downloads,
    follows:      p.follows ?? 0,
    categories:   p.categories ?? [],
    loaders:      p.loaders ?? [],
    versions:     p.versions ?? [],
    gameVersions: p.game_versions ?? [],
    projectType:  p.project_type,
    source:       "modrinth",
  };
}

function normalizeVersion(v) {
  if (!v) return null;
  const primaryFile = v.files?.find(f => f.primary) ?? v.files?.[0];
  return {
    id:           v.id,
    name:         v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions ?? [],
    loaders:      v.loaders ?? [],
    datePublished: v.date_published,
    downloads:    v.downloads,
    fileUrl:      primaryFile?.url ?? null,
    filename:     primaryFile?.filename ?? null,
    fileSizeBytes: primaryFile?.size ?? null,
  };
}
