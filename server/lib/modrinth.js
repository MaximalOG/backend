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
    // Include the exact version AND the major.minor fallback so plugins that
    // list "1.21" or "26" still appear on a "1.21.4" or "26.1" server.
    // For calendar versions (26.x) parts.length === 2, so we always try major too.
    const parts = mcVersion.split(".");
    const minor = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : null;  // "1.21" or "26.1"
    const major = parts[0];                                                 // "1"    or "26"

    const versionFacets = [`versions:${mcVersion}`];
    if (minor && minor !== mcVersion) versionFacets.push(`versions:${minor}`);
    if (major && major !== minor && major !== mcVersion) versionFacets.push(`versions:${major}`);

    facets.push(versionFacets);
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
 * Java version label → Minecraft snapshot version prefixes that require it.
 * Any version whose game_versions list includes one of these prefixes
 * was compiled for that Java version or higher.
 * We use this to filter out releases that won't run on the server's JVM.
 *
 * Java 25 shipped with MC snapshot 25w01a / calendar version 25.x / 26.x
 * Java 21 handles all 1.x MC releases up through 1.21.x
 */
const JAVA_REQUIRED_SNAPSHOTS = {
  // "Java 25" is the newest — nothing is too new for it
  "Java 25": [],
  // "Java 21" servers: block versions that ONLY list 26.x or 25.x game_versions
  // (these are compiled for Java 25+). We check whether ALL game_versions are blocked,
  // not just any, to avoid rejecting cross-version releases.
  "Java 21": ["26.", "25."],
  // Java 17 servers: also block 1.21.x which requires Java 21
  "Java 17": ["26.", "25.", "1.21"],
  // Java 16, 11, 8 — progressively more restrictive
  "Java 16": ["26.", "25.", "1.21", "1.20"],
  "Java 11": ["26.", "25.", "1.21", "1.20", "1.19", "1.18"],
  "Java 8":  ["26.", "25.", "1.21", "1.20", "1.19", "1.18", "1.17"],
};

/**
 * Returns true if a Modrinth version object is compatible with the given
 * Java version.
 *
 * A version is considered incompatible only when EVERY listed game_version
 * requires a newer Java than what the server has. This way cross-version
 * releases (e.g. supporting both "1.21.4" and "26.1") remain installable
 * on Java 21 servers because at least one game_version is within range.
 */
function isJavaCompatible(version, javaVersion) {
  if (!javaVersion) return true;
  const blockedPrefixes = JAVA_REQUIRED_SNAPSHOTS[javaVersion];
  if (!blockedPrefixes || blockedPrefixes.length === 0) return true; // Java 25 or unknown — allow all

  const gameVersions = version.game_versions;
  if (!gameVersions || gameVersions.length === 0) return true;

  // Block only if every single game_version is in the blocked range
  // (i.e. this build is exclusively for a newer Java)
  return !gameVersions.every(gv =>
    blockedPrefixes.some(prefix => gv.startsWith(prefix))
  );
}

/**
 * Get the best compatible version for a project.
 * Respects both MC version and Java version constraints.
 *
 * Fallback order (each tier first filters by Java compatibility):
 *  1. Exact MC version + loader  (e.g. "1.21.11", ["paper","spigot"])
 *  2. Minor MC version + loader  (e.g. "1.21",    ["paper","spigot"])
 *  3. Loader only                (no MC version filter)
 *  4. No filters                 (newest Java-compatible release)
 *
 * @param {string} projectId
 * @param {{ mcVersion?: string, serverSoftware?: string, javaVersion?: string }} opts
 */
export async function getBestVersion(projectId, { mcVersion, serverSoftware, javaVersion }) {
  const loaders = serverSoftware
    ? (SOFTWARE_LOADERS[serverSoftware.toLowerCase()] ?? [])
    : [];

  // Build the list of MC version strings to try in order
  const mcVersionsToTry = [];
  if (mcVersion) {
    mcVersionsToTry.push(mcVersion);                          // exact:  "1.21.4" or "26.1"
    const parts = mcVersion.split(".");
    // For 1.x.y  → try "1.21" (minor)
    // For 26.y   → try "26"   (major only — calendar versioning has no patch)
    // Both cases: parts[0].parts[1] if parts.length >= 2
    if (parts.length >= 2) {
      const majorMinor = `${parts[0]}.${parts[1]}`;
      if (majorMinor !== mcVersion) mcVersionsToTry.push(majorMinor); // "1.21" or already "26.1"
    }
    // For 1.x.y also try major-only "1" is not meaningful, but for calendar
    // versions try just the year number "26" since some mods tag with that
    if (parts.length === 2 && parts[0].length <= 2) {
      // Calendar version like "26.1" — also try just "26"
      mcVersionsToTry.push(parts[0]);
    }
  }
  mcVersionsToTry.push(null); // loader only, no MC filter

  for (const tryVersion of mcVersionsToTry) {
    const params = new URLSearchParams();
    if (tryVersion)     params.set("game_versions", JSON.stringify([tryVersion]));
    if (loaders.length) params.set("loaders", JSON.stringify(loaders));

    let url = `/project/${projectId}/version`;
    const qs = params.toString();
    if (qs) url += `?${qs}`;

    const versions = await mfetch(url).catch(() => []);
    if (!Array.isArray(versions) || versions.length === 0) continue;

    // Filter by Java version compatibility — removes builds requiring Java 25+
    // when the server runs Java 21, etc.
    const compatible = versions.filter(v => isJavaCompatible(v, javaVersion));
    if (compatible.length === 0) continue;

    // Sort: prefer exact MC version match, then minor version, then most recent
    const sorted = compatible.sort((a, b) => {
      const score = (v) => {
        if (mcVersion && v.game_versions.includes(mcVersion)) return 3;
        if (mcVersion) {
          const minor = mcVersion.split(".").slice(0, 2).join(".");
          if (v.game_versions.some(gv => gv.startsWith(minor))) return 2;
        }
        return 1;
      };
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      return new Date(b.date_published) - new Date(a.date_published);
    });

    return normalizeVersion(sorted[0]);
  }

  // Final fallback: no loader or version filter — but still enforce Java compat
  const allVersions = await mfetch(`/project/${projectId}/version`).catch(() => []);
  if (Array.isArray(allVersions) && allVersions.length > 0) {
    const compatible = allVersions.filter(v => isJavaCompatible(v, javaVersion));
    if (compatible.length > 0) return normalizeVersion(compatible[0]);
    // Absolute last resort — ignore Java filter (user will get an error at runtime,
    // but at least something installs rather than a silent 422)
    return normalizeVersion(allVersions[0]);
  }

  return null;
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
