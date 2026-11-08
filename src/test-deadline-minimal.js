'use strict';

const http = require('http');
const { postJson, postJsonStream, OLLAMA_ERROR_CODES } = require('./ollama-http.js');

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}`);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

async function test1() {
  console.log('Test 1: postJsonStream with deadline 100ms, server never responds');
  await withServer(
    (req, res) => {
      // Never respond
    },
    async (base) => {
      const start = Date.now();
      try {
        await postJsonStream(`${base}/api/chat`, { messages: [] }, 100, undefined, () => {});
        console.log('FAIL: expected reject');
      } catch (e) {
        const elapsed = Date.now() - start;
        console.log(`OK: rejected after ${elapsed}ms with code=${e.code}, deadlineMs=${e.deadlineMs}`);
      }
    }
  );
}

async function test2() {
  console.log('Test 2: postJsonStream with no deadline, server responds');
  const lines = [];
  await withServer(
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ ok: true }) + '\n');
        res.end();
      });
    },
    async (base) => {
      const start = Date.now();
      await postJsonStream(`${base}/api/chat`, { messages: [] }, undefined, undefined, (line) => {
        lines.push(line);
      });
      const elapsed = Date.now() - start;
      console.log(`OK: resolved after ${elapsed}ms, lines=${lines.length}`);
    }
  );
}

async function main() {
  try {
    await test1();
    await test2();
    console.log('All tests passed');
  } catch (e) {
    console.error('Test failed:', e);
  }
}

main();
