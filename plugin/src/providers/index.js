// Provider registry. To add a model service, write one adapter with the same shape as openai.js and list it here.

const openai = require("./openai");
const gemini = require("./gemini");

const PROVIDERS = [openai, gemini];

function getProvider(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

module.exports = { PROVIDERS, getProvider };
