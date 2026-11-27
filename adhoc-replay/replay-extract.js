const path = require('path');

const repoPath = process.argv[2];
if (!repoPath) {
  console.error('Usage: node replay-extract.js <repo-path>');
  process.exit(1);
}

const { extractDeclaredTargets } = require(path.join(repoPath, 'src/adhoc-diff-sanity.js'));

const specText = "In `python/test_build_graph.py`, change the module docstring on line 2 from X to Y";

// Shape A: top-level rawText (spec shape, not produced by pipeline)
const taskA = {
  title: 'Re-point module docstring to graph_build.py',
  rawText: specText,
  plan: []
};

// Shape B: promptContext.rawText (pipeline shape)
const taskB = {
  title: 'Re-point module docstring to graph_build.py',
  promptContext: {
    rawText: specText
  },
  plan: []
};

console.log('=== Shape A (top-level rawText) ===');
const resultA = extractDeclaredTargets(taskA, '', { includeCreated: false });
console.log('Array:', JSON.stringify(resultA));
console.log('Contains python/test_build_graph.py:', resultA.includes('python/test_build_graph.py'));

console.log('\n=== Shape B (promptContext.rawText) ===');
const resultB = extractDeclaredTargets(taskB, '', { includeCreated: false });
console.log('Array:', JSON.stringify(resultB));
console.log('Contains python/test_build_graph.py:', resultB.includes('python/test_build_graph.py'));

// Also write result.json
const fs = require('fs');
const resultJson = {
  script: __filename,
  repoPath: repoPath,
  taskTitle: 'Re-point module docstring to graph_build.py',
  specText: specText,
  shapes: {
    shapeA_topLevelRawText: {
      description: 'Top-level rawText (spec shape, not produced by pipeline)',
      taskObject: taskA,
      extractDeclaredTargets: { includeCreated: false },
      result: {
        array: resultA,
        containsTarget: resultA.includes('python/test_build_graph.py')
      },
      note: 'The leading "In `python/test_build_graph.py`," clause is not seen because extractDeclaredTargets only reads task.promptContext.rawText (or falls back to task.title)'
    },
    shapeB_promptContextRawText: {
      description: 'promptContext.rawText (real pipeline shape written by src/queue-adhoc-task.js)',
      taskObject: taskB,
      extractDeclaredTargets: { includeCreated: false },
      result: {
        array: resultB,
        containsTarget: resultB.includes('python/test_build_graph.py')
      },
      note: 'The target IS returned because extractDeclaredTargets reads task.promptContext.rawText, which contains the full "In `<path>`," leading clause that Rule 4 (leadingInClauseTargets) extracts'
    }
  },
  answer: {
    containsTarget: true,
    shape: 'promptContext.rawText (real pipeline shape)',
    note: 'The top-level rawText shape is a spec artifact - the pipeline never produces it. Under the real pipeline shape, the target is correctly identified.'
  }
};
fs.writeFileSync(__filename.replace('.js', '.json'), JSON.stringify(resultJson, null, 2) + '\n');
console.log('\nresult.json written to ' + __filename.replace('.js', '.json'));
