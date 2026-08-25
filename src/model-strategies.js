'use strict';

// Named model-strategy registry (chatdev's ThinkingRegistration pattern, adapted
// 2026-07-26) -- extends the existing LOCAL_AB_MODELS A/B mechanism (local-worker.ps1's
// Select-AbModel, in place well before this file existed) with per-model GENERATION
// PARAMETERS, not just a different model tag. Every pass today uses one fixed
// temperature/numPredict/think regardless of which model is actually running -- if a
// second model genuinely needs different settings to perform well, there was previously
// no way to express that without hardcoding an if/else at every Invoke-LocalClient call
// site.
//
// 2026-08-26, Grimmethy: "It should be a model that's available to us. Not a naming
// convention" -- the two entries this registry originally shipped with (an 'ornith-9b'
// key pointing at model tag 'ornith:9b', and a 'hermes3-8b' key pointing at
// 'hermes3:8b') referenced tags that were never real: confirmed live via `ollama list`,
// neither has ever been pulled on this box. The registry's whole point is to let
// LOCAL_AB_MODELS name a REAL second model to compare against -- pointing it at
// placeholder tags that don't exist defeated that. Replaced with the two real,
// currently-pulled quantizations of the actual default model (`ollama list`:
// qwen3.8:27b-q4_K_M, qwen3.8:27b-q8_0) as a genuine, immediately-usable A/B pair.
//
// Deliberately conservative on content: neither registered strategy below carries
// temperature/numPredict/think overrides yet -- there is no real benchmarking evidence
// yet for what the q8_0 quantization specifically needs differently, and inventing
// plausible-looking numbers here would be exactly the kind of fabricated data these
// strategies exist to eventually replace. The mechanism is real and tested; the override
// VALUES are meant to be filled in once actual comparative data exists, not guessed at
// build time.

const MODEL_STRATEGIES = {
  'qwen3-27b-q4': {
    model: 'qwen3.8:27b-q4_K_M',
    summary: 'Current default drafting model (LOCAL_MODEL). No parameter overrides -- baseline behavior.',
  },
  'qwen3-27b-q8': {
    model: 'qwen3.8:27b-q8_0',
    summary: 'Higher-precision quantization of the same model family, pulled for benchmarking against the default q4_K_M. No parameter overrides yet -- add them here once real comparative data suggests different generation settings help.',
  },
};

// Resolves a name from LOCAL_AB_MODELS (or any other candidate list) to
// {model, temperature, numPredict, think, summary}. A registered strategy NAME returns its
// full entry (temperature/numPredict/think present only if that strategy actually
// overrides them). Anything else is treated as a bare Ollama model tag -- the exact
// pre-existing LOCAL_AB_MODELS=<tag>,<tag> usage -- and resolves to
// {model: <the tag itself>, summary: null}, no overrides, byte-identical to today's
// behavior. This is the load-bearing backward-compatibility guarantee: an unset or
// bare-tag-only LOCAL_AB_MODELS must never change behavior.
function resolveStrategy(nameOrModelTag) {
  if (nameOrModelTag in MODEL_STRATEGIES) {
    return { ...MODEL_STRATEGIES[nameOrModelTag] };
  }
  return { model: nameOrModelTag, summary: null };
}

// CLI mode (`node model-strategies.js --resolve <name>`): prints the resolved strategy as
// JSON, so local-worker.ps1 can look one up without duplicating this registry in
// PowerShell -- same "compute it once in JS, consume it from PowerShell" split as
// task-sources.js's --priority-map/--pending-readiness.
if (require.main === module) {
  const idx = process.argv.indexOf('--resolve');
  if (idx === -1 || !process.argv[idx + 1]) {
    console.error('Usage: node model-strategies.js --resolve <name-or-model-tag>');
    process.exit(1);
  }
  console.log(JSON.stringify(resolveStrategy(process.argv[idx + 1])));
}

module.exports = { MODEL_STRATEGIES, resolveStrategy };
