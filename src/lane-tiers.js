'use strict';

// Whether worker lanes are split by reasoning tier: worker-reasoning* claims and generates only
// 'high'-tier tasks, every other lane only the rest. The split existed to route high-tier work to
// a different (Claude) model. With Claude off and every lane on a local model, the only real
// difference between lanes is which GPU they run on, and the split just strands work: a hygiene
// task can wait while a reasoning lane idles, and priority stops meaning anything across lanes
// (2026-09-19, Grimmethy: "the worker and reasoning separation is largely moot... the only
// meaningful difference is which GPU it's running on").
//
// AGENT_MANAGER_LANE_TIERS=off -> every lane may claim and generate any task, purely by priority.
// Unset/anything else keeps the split, for deployments that still route high-tier work to Claude.
function laneTiersEnabled() {
  return String(process.env.AGENT_MANAGER_LANE_TIERS || 'on').trim().toLowerCase() !== 'off';
}

module.exports = { laneTiersEnabled };
