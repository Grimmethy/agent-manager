'use strict';

// Named model-strategy registry (chatdev's ThinkingRegistration pattern, adapted
// 2026-07-26) -- extends the existing LOCAL_AB_MODELS A/B mechanism (local-worker.ps1's
// Select-AbModel, in place well before this file existed) with per-model GENERATION
// PARAMETERS, not just a different model tag. Every pass today uses one fixed
// temperature/numPredict/think regardless of which model is actually running -- if a
// second model (Hermes3, benchmarked against ornith:9b per Grimmethy) genuinely needs
// different settings to perform well, there was previously no way to express that without
// hardcoding an if/else at every Invoke-LocalClient call site.
//
// Deliberately conservative on content: neither registered strategy below carries
// temperature/numPredict/think overrides yet -- there is no real benchmarking evidence yet
// for what Hermes3 specifically needs, and inventing plausible-looking numbers here would
// be exactly the kind of fabricated data these strategies exist to eventually replace.
// The mechanism is real and tested; the override VALUES are meant to be filled in once
// actual comparative data exists, not guessed at build time.

const MODEL_STRATEGIES = {
  'ornith-9b': {
    model: 'ornith:9b',
    summary: 'Current default drafting model. No parameter overrides -- baseline behavior.',
  },
  'hermes3-8b': {
    model: 'hermes3:8b',
    summary: 'Second contender model pulled for benchmarking against ornith:9b. No parameter overrides yet -- add them here once real comparative data suggests different generation settings help.',
  },
};

// Resolves a name from LOCAL_AB_MODELS (or any other candidate list) to
// {model, temperature, numPredict, think, summary}. A registered strategy NAME returns its
// full entry (temperature/numPredict/think present only if that strategy actually
// overrides them). Anything else is treated as a bare Ollama model tag -- the exact
// pre-existing LOCAL_AB_MODELS=ornith:9b,hermes3:8b usage -- and resolves to
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
