import { generateWithOpenAI } from "./providers/openai.js";
import { generateWithOllama } from "./providers/ollama.js";
import { calculatePlan } from "./calculator.js";
import { buildAIContext } from "./config.js";

export async function generateAIResponse(message, history = [], ctx = null, attachment = null) {
  const context = ctx ?? buildAIContext();
  const provider = process.env.AI_PROVIDER || "openai";

  const generate = provider === "ollama"
    ? (msg, hist, sysCtx) => generateWithOllama(msg, hist, sysCtx)
    : (msg, hist, sysCtx, att) => generateWithOpenAI(msg, hist, sysCtx, att);

  // First pass
  let raw = await generate(message, history, context, attachment);

  // Intercept CALCULATE_PLAN block
  const calcMatch = raw.match(/CALCULATE_PLAN\s*\n?\s*(\{[\s\S]*?\})/);
  if (calcMatch) {
    let planResult = null;
    try {
      const input = JSON.parse(calcMatch[1]);
      planResult = calculatePlan(input);

      // Get plan specs to inject into second pass
      const planName = planResult.recommended_plan;
      const specs = context.PLAN_SPECS[planName] ?? {};
      const price = context.PRICING[planName] ?? "";

      // Second pass: give AI the result + specs so it can present naturally
      const injected = `${message}

[SYSTEM: Calculator result]
Recommended plan: ${planName}
RAM: ${specs.ram}, CPU: ${specs.cpu}, SSD: ${specs.ssd}
Price: ${price}
Reasoning: ${planResult.reasoning}
Fits within available plans: ${planResult.fits_within_available}

Now present this recommendation naturally in 2-3 lines. Include the plan name, RAM, and price. Then ask if they want to set it up.
Then output on its own line:
PLAN: ${planName}
ACTION: SHOW_BUTTONS`;

      raw = await generate(injected, history, context);

      // Strip any leaked CALCULATE_PLAN blocks from the response
      raw = raw.replace(/CALCULATE_PLAN[\s\S]*?\}/g, "").trim();

    } catch (e) {
      // If parsing fails, strip the block and return what we have
      raw = raw.replace(/CALCULATE_PLAN[\s\S]*?\}/g, "").trim();
    }
    return { text: raw, planResult };
  }

  return { text: raw, planResult: null };
}
