const fs = require('fs');
const path = require('path');
const os = require('os');
const { claimNext } = require('./src/node-claim.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-'));
const pipe = path.join(root, 'pipe');
const pending = path.join(pipe, 'queue', 'pending');
fs.mkdirSync(pending, { recursive: true });
const nodesDir = path.join(root, 'nodes');
fs.mkdirSync(nodesDir, { recursive: true });

const now = Date.now();
const file = path.join(pending, 'test-task.json');
fs.writeFileSync(file, JSON.stringify({ id: 'test-task', title: 'test', premiumPriority: true, source: 'manual', domain: 'adhoc' }));
const t = now / 1000 - 100;
fs.utimesSync(file, t, t);

const env = {
  AGENT_MANAGER_NODE_ID: 'node-test',
  AGENT_MANAGER_NODE_FILTERED_DIRS: pipe,
  AGENT_MANAGER_NODES_DIR: nodesDir
};

console.log('Pipeline dir:', pipe);
console.log('Pending dir:', pending);
console.log('Files in pending:', fs.readdirSync(pending));
console.log('Task file content:', fs.readFileSync(file, 'utf8'));

const { pickClaimableTasks } = require('./src/next-claimable-task.js');
console.log('Calling pickClaimableTasks...');
const names = pickClaimableTasks(pending, 'node-test', { nodeId: 'node-test' });
console.log('pickClaimableTasks returned:', names);

const skipped = [];
const result = claimNext({ claimant: 'node-test', pipelineDirs: [pipe], env, now, skipped, readRemote: () => '' });
console.log('Result:', result);
console.log('Skipped:', skipped);
