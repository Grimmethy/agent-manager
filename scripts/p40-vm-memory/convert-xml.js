#!/usr/bin/env node
'use strict';

// Builds the virtio-mem version of the P40 VM's domain XML and a rollback copy of the original, as FILES. It never runs `virsh define`, never
// restarts anything: applying it is the operator's step (docs/agents/p40-vm-memory.md). Refuses XML it does not understand.
//   node scripts/p40-vm-memory/convert-xml.js --in current.xml --out-dir ./out [--base-gib 4] [--region-gib 2]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ALIAS = 'ua-virtiomem0';

function convert(xml, { baseKiB = 4 * 1024 * 1024, regionKiB = 2 * 1024 * 1024, blockKiB = 2048 } = {}) {
  if (!/<domain[\s>]/.test(xml)) throw new Error('not a libvirt domain XML');
  if (/model=['"]virtio-mem['"]/.test(xml)) throw new Error('the XML already has a virtio-mem device');
  if (/<maxMemory/.test(xml) || /<numa>/.test(xml)) throw new Error('the XML already has maxMemory or a NUMA cell: refusing to guess how to merge');
  const mem = xml.match(/<memory unit=['"]KiB['"]>(\d+)<\/memory>/);
  const cur = xml.match(/<currentMemory unit=['"]KiB['"]>(\d+)<\/currentMemory>/);
  const vcpu = xml.match(/<vcpu[^>]*>(\d+)<\/vcpu>/);
  const cpu = xml.match(/<cpu\b([^>]*?)\/>/);
  if (!mem || !cur || !vcpu || !cpu || !/<devices>/.test(xml)) throw new Error('unexpected XML shape (need <memory>, <currentMemory>, <vcpu>, a self-closing <cpu .../> and <devices>)');
  if (regionKiB % blockKiB !== 0) throw new Error('region must be a multiple of the block size');
  const lastCpu = Number(vcpu[1]) - 1;
  let out = xml;
  out = out.replace(mem[0], `<maxMemory slots='1' unit='KiB'>${baseKiB + regionKiB}</maxMemory>\n  <memory unit='KiB'>${baseKiB}</memory>`);
  out = out.replace(cur[0], `<currentMemory unit='KiB'>${baseKiB}</currentMemory>`);
  out = out.replace(cpu[0], `<cpu${cpu[1]}>\n    <numa>\n      <cell id='0' cpus='0-${lastCpu}' memory='${baseKiB}' unit='KiB'/>\n    </numa>\n  </cpu>`);
  out = out.replace('<devices>', `<devices>\n    <memory model='virtio-mem'>\n      <target>\n        <size unit='KiB'>${regionKiB}</size>\n        <node>0</node>\n        <block unit='KiB'>${blockKiB}</block>\n        <requested unit='KiB'>0</requested>\n      </target>\n      <alias name='${ALIAS}'/>\n    </memory>`);
  return out;
}

function operatorCommands(dom, outDir) {
  return [
    `virsh shutdown ${dom}                 # wait for 'shut off'`,
    `virsh define ${path.join(outDir, `${dom}.virtio-mem.xml`)}`,
    `virsh start ${dom}`,
    `# rollback: virsh shutdown ${dom}; virsh define ${path.join(outDir, `${dom}.rollback.xml`)}; virsh start ${dom}`,
  ];
}

if (require.main === module) {
  const a = process.argv.slice(2), get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const dom = get('--domain', 'p40-passthrough'), outDir = path.resolve(get('--out-dir', './p40-vm-memory-out'));
  const input = get('--in', null);
  const xml = input ? fs.readFileSync(input, 'utf8') : spawnSync('virsh', ['-c', 'qemu:///system', 'dumpxml', '--inactive', dom], { encoding: 'utf8' }).stdout;
  const result = convert(xml, { baseKiB: Number(get('--base-gib', '4')) * 1024 * 1024, regionKiB: Number(get('--region-gib', '2')) * 1024 * 1024 });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${dom}.rollback.xml`), xml);
  fs.writeFileSync(path.join(outDir, `${dom}.virtio-mem.xml`), result);
  console.log(`wrote ${outDir}/${dom}.virtio-mem.xml and ${dom}.rollback.xml; nothing was defined or restarted.\nOperator steps:\n  ${operatorCommands(dom, outDir).join('\n  ')}`);
}
module.exports = { convert, operatorCommands, ALIAS };
