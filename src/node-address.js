'use strict';

// LAN-first address chooser (multi-node plan, piece 5e): machine-to-machine traffic goes over the wired LAN address, with the tailnet address as the fallback
// (plan decision 13). chooseAddress tries the LAN address first, then the tailnet one, with a TCP connect to the service port, and says which one answered.
//
//   chooseAddress({lan, tailnet, port, probe, timeoutMs}) -> {address, via}     via is 'lan', 'tailnet' or null (neither answered)
//   node src/node-address.js <lan> <tailnet> <port>      prints that JSON; exit 0 an address answered, 3 neither did, 2 usage
//
// connect (default net.connect) is injectable for tests. A missing or blank address is skipped. The default probe is tcpProbe: connect, then close; false on an error or after 1500 ms. Nothing is registered or
// changed by this: the caller decides what to do with the answer. See docs/agents/multi-node-runbook.md.

const net = require('net');

const DEFAULT_TIMEOUT_MS = 1500;

// true when a TCP connection to host:port opens within timeoutMs. Always destroys its socket.
function tcpProbe(host, port, timeoutMs = DEFAULT_TIMEOUT_MS, connect = net.connect) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host, port });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function chooseAddress({ lan, tailnet, port, probe, timeoutMs = DEFAULT_TIMEOUT_MS, connect } = {}) {
  const check = probe || ((host, p) => tcpProbe(host, p, timeoutMs, connect));
  for (const [via, address] of [['lan', lan], ['tailnet', tailnet]]) {
    const host = typeof address === 'string' ? address.trim() : '';
    if (!host) continue;
    let up = false;
    try { up = Boolean(await check(host, port)); } catch (e) { up = false; }
    if (up) return { address: host, via };
  }
  return { address: null, via: null };
}

async function main(argv, deps = {}, out = (s) => process.stdout.write(`${s}\n`)) {
  const [lan, tailnet, portText] = argv;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write('usage: node src/node-address.js <lan address> <tailnet address> <port> (use "" for an address you do not have)\n');
    return 2;
  }
  const r = await chooseAddress({ lan, tailnet, port, ...deps });
  out(JSON.stringify(r));
  return r.address ? 0 : 3;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { chooseAddress, tcpProbe, main, DEFAULT_TIMEOUT_MS };
