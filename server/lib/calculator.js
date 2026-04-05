import { PLANS } from "./config.js";

/**
 * Calculate recommended plan using weighted RAM logic.
 * @param {{ players: number, type: string, plugins: number, activity: string, version: string }} input
 * @returns {{ recommended_plan: string, ram_required_gb: number, reasoning: string, fits_within_available: boolean }}
 */
export function calculatePlan({ players, type, plugins = 0, activity, version }) {
  // Step 1: base RAM from player count
  let ram = 1;
  if (players <= 5)       ram = 1.5;
  else if (players <= 10) ram = 2.5;
  else if (players <= 20) ram = 4;
  else if (players <= 40) ram = 6;
  else                    ram = 10;

  const reasons = [`${players} players → ${ram}GB base`];

  // Step 2: server type
  if (type === "plugins") {
    const add = plugins <= 10 ? 1 : plugins <= 20 ? 1.5 : 2.5;
    ram += add;
    reasons.push(`plugins (${plugins}) → +${add}GB`);
  } else if (type === "modpacks") {
    const add = plugins <= 10 ? 2 : plugins <= 20 ? 3 : 5;
    ram += add;
    reasons.push(`modpacks (${plugins} mods) → +${add}GB`);
  }

  // Step 3: activity
  if (activity === "moderate") { ram += 0.5; reasons.push("moderate activity → +0.5GB"); }
  if (activity === "high")     { ram += 1;   reasons.push("high activity → +1GB"); }

  // Step 4: version overhead
  if (version === "latest") { ram += 0.5; reasons.push("latest version → +0.5GB"); }

  // Step 5: 30% headroom buffer
  ram = Math.ceil(ram * 1.3 * 10) / 10;
  reasons.push(`30% headroom → ${ram}GB required`);

  // Step 6: safety floors
  if (players > 20 && ram < 6)  ram = 6;
  if (players > 40 && ram < 10) ram = 10;

  // Step 7: find lowest plan that fits
  const match = PLANS.find(p => p.ramGB >= ram);
  const plan  = match ?? PLANS[PLANS.length - 1]; // cap at highest if over max
  const fits  = !!match;

  if (!fits) reasons.push(`exceeds max plan — capped at ${plan.name}`);

  return {
    recommended_plan: plan.name,
    ram_required_gb: ram,
    reasoning: reasons.join(", "),
    fits_within_available: fits,
  };
}
