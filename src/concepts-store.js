'use strict';

// Disk persistence for the concept registry. This is the only module in the concept
// subsystem that touches the filesystem. concepts.js holds the business logic and takes an
// optional store ({ load(), save(data) }); callers that pass nothing get createJsonStore().

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('./atomic-write.js');

function conceptsPath(pipelineDir) {
  return path.join(pipelineDir, 'concepts.json');
}

function brainDumpPath(pipelineDir) {
  return path.join(pipelineDir, 'brain-dump.json');
}

// JSON-file store for the registry. A missing file loads as an empty registry; a corrupt
// file logs via console.error and also loads as an empty registry (unchanged behavior).
function createJsonStore(pipelineDir) {
  const filePath = conceptsPath(pipelineDir);
  return {
    filePath,
    load() {
      try {
        return JSON.parse(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{"concepts":[]}');
      } catch (err) {
        console.error(`[loadConcepts] ${filePath}: ${err.message} -- returning empty store`);
        return { concepts: [] };
      }
    },
    save(data) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeJsonAtomicSync(filePath, data);
    },
  };
}

module.exports = { conceptsPath, brainDumpPath, createJsonStore };
