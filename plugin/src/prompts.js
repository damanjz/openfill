// What each mode asks the model to do. Providers wrap this with their own mask instructions.

const MODES = ["fill", "remove", "expand"];

function taskFor(mode, userPrompt) {
  const p = (userPrompt || "").trim();
  if (mode === "remove") {
    return "Remove everything inside the area to change and rebuild the background behind it so the image looks untouched. Do not add new objects, people, text or logos.";
  }
  if (mode === "expand") {
    const base = "The area to change is new canvas around the original picture. Continue the existing scene into it seamlessly: same perspective, horizon, lighting, colour, grain and level of detail.";
    return p ? `${base} In the new area: ${p}.` : base;
  }
  if (mode === "fill") {
    return p
      ? `In the area to change, paint: ${p}. Match the surrounding lighting, perspective, colour, grain and focus so it blends in naturally.`
      : "Fill the area to change so it blends naturally with its surroundings, as if nothing had been selected.";
  }
  throw new Error(`Unknown mode: ${mode}`);
}

module.exports = { MODES, taskFor };
