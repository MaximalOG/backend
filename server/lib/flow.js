import { calculatePlan } from "./calculator.js";
import { PLANS } from "./config.js";

// ── Flow triggers ─────────────────────────────────────────────────────────────
const FLOW_TRIGGERS = [
  "i need a server", "i want a server", "which plan", "what plan",
  "help me choose", "help me pick", "get started", "start a server",
  "new server", "buy a plan", "choose a plan", "recommend a plan",
  "what should i get", "what should i buy",
];

export function shouldTriggerFlow(message) {
  const lower = message.toLowerCase();
  return FLOW_TRIGGERS.some(t => lower.includes(t));
}

// Extract player count from any message (e.g. "for 10 players", "10 people", "about 20")
function extractPlayers(msg) {
  const m = msg.match(/(\d+)\s*(?:players?|people|persons?|users?)?/i);
  return m ? parseInt(m[1]) : null;
}

// Extract server type from any message
function extractType(msg) {
  const lower = msg.toLowerCase();
  if (lower.includes("mod")) return "modpacks";
  if (lower.includes("plugin") || lower.includes("paper") || lower.includes("spigot")) return "plugins";
  if (lower.includes("vanilla") || lower.includes("survival")) return "vanilla";
  return null;
}

/**
 * Start the flow — but pre-fill any info already present in the trigger message.
 * Returns the first question that still needs answering.
 */
export function startFlow(triggerMessage) {
  const players = extractPlayers(triggerMessage);
  const type    = extractType(triggerMessage);
  const msg     = triggerMessage.toLowerCase();

  // Extract activity from message
  const activity = msg.includes("very active") || msg.includes("high") || msg.includes("busy") || msg.includes("heavy")
    ? "high"
    : msg.includes("moderate") || msg.includes("medium")
    ? "moderate"
    : null;

  // Extract plugin count
  const pluginMatch = triggerMessage.match(/(\d+)\s*(?:plugins?|mods?)/i);
  const plugins = pluginMatch ? parseInt(pluginMatch[1]) : null;

  // If we have players + type, calculate immediately with defaults
  if (players && type) {
    const resolvedActivity = activity || "moderate";
    const resolvedPlugins  = plugins ?? (type === "modpacks" ? 20 : type === "plugins" ? 10 : 0);
    const result = calculatePlan({
      players,
      type,
      plugins: resolvedPlugins,
      activity: resolvedActivity,
      version: "latest",
    });
    const plan = PLANS.find(p => p.name === result.recommended_plan) ?? PLANS[PLANS.length - 1];
    const assumed = [];
    if (!activity) assumed.push("moderate activity");
    assumed.push("latest version");
    const assumedNote = assumed.length ? ` (assuming ${assumed.join(", ")})` : "";
    return {
      nextState: { step: "done" },
      message: `Based on what you've told me, the ${plan.name} plan (${plan.ram}, ${plan.price}) looks like a solid fit${assumedNote}. Want me to set it up for you? If you're on an older version or have different activity levels, let me know and I'll recalculate.`,
      showButtons: true,
      recommendedPlan: plan.name,
      ramRequired: plan.ram,
    };
  }

  // Have players but need type
  if (players) {
    return {
      nextState: { step: "ask_type", players, activity: activity || null, plugins: plugins || null },
      message: `Got it — ${players} players. Will it be vanilla, plugins, or modpacks?`,
      showButtons: false, recommendedPlan: null, ramRequired: null,
    };
  }

  // Nothing extracted — start from scratch
  return {
    nextState: { step: "ask_players" },
    message: "How many players are you planning for?",
    showButtons: false, recommendedPlan: null, ramRequired: null,
  };
}

// ── State machine ─────────────────────────────────────────────────────────────
export function runFlow(state, userMessage, _ctx) {
  const msg = userMessage.trim().toLowerCase();

  switch (state.step) {

    case "ask_players": {
      const players = extractPlayers(userMessage);
      if (!players) return reply(state, "Just a number works — how many players are you expecting?");
      const type = extractType(userMessage);
      if (type === "vanilla") {
        return reply({ ...state, step: "ask_activity", players, serverType: "vanilla", plugins: 0 },
          "How active will it be — casual, moderate, or high traffic?");
      }
      if (type) {
        return reply({ ...state, step: "ask_plugins", players, serverType: type },
          "Roughly how many plugins or mods? A guess is fine.");
      }
      return reply({ ...state, step: "ask_type", players },
        "Will it be vanilla, plugins, or modpacks?");
    }

    case "ask_type": {
      const type = msg.includes("mod") ? "modpacks" : msg.includes("plugin") ? "plugins" : "vanilla";
      if (type === "vanilla") {
        return reply({ ...state, step: "ask_activity", serverType: type, plugins: 0 },
          "How active will it be — casual, moderate, or high traffic?");
      }
      return reply({ ...state, step: "ask_plugins", serverType: type },
        "Roughly how many plugins or mods? A guess is fine.");
    }

    case "ask_plugins": {
      const num     = userMessage.match(/\d+/)?.[0];
      const plugins = num ? parseInt(num) : 10;
      return reply({ ...state, step: "ask_activity", plugins },
        "How active will the server be — casual, moderate, or high traffic?");
    }

    case "ask_activity": {
      const activity = msg.includes("high") || msg.includes("busy") || msg.includes("heavy")
        ? "high"
        : msg.includes("moderate") || msg.includes("medium")
        ? "moderate"
        : "casual";
      return reply({ ...state, step: "ask_version", activity },
        "Which Minecraft version — latest (1.21+) or an older one?");
    }

    case "ask_version": {
      const version = msg.includes("old") || msg.includes("1.8") || msg.includes("1.12") || msg.includes("1.16")
        ? "old" : "latest";

      const result = calculatePlan({
        players:  state.players,
        type:     state.serverType,
        plugins:  state.plugins ?? 0,
        activity: state.activity,
        version,
      });

      const plan = PLANS.find(p => p.name === result.recommended_plan) ?? PLANS[PLANS.length - 1];
      const actLabel = state.activity === "high" ? "high traffic" : state.activity === "moderate" ? "moderate activity" : "casual use";
      const typeLabel = state.serverType === "modpacks" ? "modpacks" : state.serverType === "plugins" ? "plugins" : "vanilla";

      return {
        nextState:       { ...state, step: "done", version },
        message:         `For ${state.players} players on ${typeLabel} with ${actLabel}, the ${plan.name} plan (${plan.ram}) will handle it smoothly. Want me to set it up for you?`,
        showButtons:     true,
        recommendedPlan: plan.name,
        ramRequired:     plan.ram,
      };
    }

    default:
      return null;
  }
}

function reply(nextState, message) {
  return { nextState, message, showButtons: false, recommendedPlan: null, ramRequired: null };
}
