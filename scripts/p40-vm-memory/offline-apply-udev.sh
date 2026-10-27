#!/bin/bash
# Installs guest/99-virtio-mem-online-movable.rules into the P40 VM's root filesystem WITHOUT booting it or needing a guest password, by attaching
# the VM's disk through qemu-nbd. Run as root while the VM is SHUT OFF:   pkexec bash scripts/p40-vm-memory/offline-apply-udev.sh
#   --cleanup   only detach a leftover nbd attach (and its device-mapper node) from an earlier run, then exit
#
# Lessons from the 2026-10-21 nbd edit that this script encodes: (1) the first attempt aborted with the disk still attached and its LVM volume
# auto-activated, and the VM was then started with the image open twice (a stale nbd view later failed to mount): so this script REFUSES to run
# while an attach, a mapper node or a qemu-nbd process for the image exists, and tells the operator to run --cleanup first; (2) the host's LVM tools
# may not see the guest's volume group (devices filter), so it works on the device-mapper node and checks that the node is backed by the nbd device;
# (3) every exit path unmounts, removes the node and disconnects.
# Every command is overridable through the environment so the tests run it against fakes (no real disk is touched).
set -euo pipefail
VIRSH="${VIRSH:-virsh}"; QEMU_NBD="${QEMU_NBD:-qemu-nbd}"; DMSETUP="${DMSETUP:-dmsetup}"; MODPROBE="${MODPROBE:-modprobe}"; PARTPROBE="${PARTPROBE:-partprobe}"
LVM="${LVM:-lvm}"; MOUNT="${MOUNT:-mount}"; UMOUNT="${UMOUNT:-umount}"; PGREP="${PGREP:-pgrep}"
DOM="${DOM:-p40-passthrough}"; IMG="${IMG:-/var/lib/libvirt/images/p40-passthrough.qcow2}"
NBD="${NBD:-/dev/nbd0}"; NBD_SYS="${NBD_SYS:-/sys/block/nbd0}"
DM="${DM:-ubuntu--vg-ubuntu--lv}"; NODE="${NODE:-/dev/mapper/$DM}"; MNT="${MNT:-/mnt/p40vm-edit}"
RULE_SRC="${RULE_SRC:-$(cd "$(dirname "$0")" && pwd)/guest/99-virtio-mem-online-movable.rules}"
RULE_DST="${RULE_DST:-etc/udev/rules.d/99-virtio-mem-online-movable.rules}"
[ "${P40_ALLOW_NONROOT:-}" = 1 ] || [ "$(id -u)" = 0 ] || { echo "ABORT: run as root (pkexec bash $0)"; exit 1; }

attached() { [ -s "$NBD_SYS/pid" ]; }
node_exists() { [ -e "$NODE" ]; }
holds_image() { "$PGREP" -f "qemu-nbd.*$IMG" >/dev/null 2>&1; }

detach_everything() {
  mountpoint -q "$MNT" 2>/dev/null && "$UMOUNT" "$MNT" || true
  if node_exists; then
    if "$DMSETUP" deps -o devname "$DM" 2>/dev/null | grep -q "nbd"; then "$DMSETUP" remove "$DM" || echo "WARN: could not remove $DM"; else echo "WARN: $NODE exists but is not backed by an nbd device: leaving it alone"; fi
  fi
  "$QEMU_NBD" --disconnect "$NBD" >/dev/null 2>&1 || true
  rmdir "$MNT" 2>/dev/null || true
}

if [ "${1:-}" = "--cleanup" ]; then
  detach_everything
  echo "cleanup done: nbd pid file '$(cat "$NBD_SYS/pid" 2>/dev/null || true)' (empty = detached); mapper node present: $(node_exists && echo yes || echo no)"
  exit 0
fi

[ "$("$VIRSH" -c qemu:///system domstate "$DOM")" = "shut off" ] || { echo "ABORT: $DOM is not shut off (virsh shutdown $DOM first)"; exit 1; }
if attached || node_exists || holds_image; then
  echo "ABORT: a leftover attach exists (nbd pid file '$(cat "$NBD_SYS/pid" 2>/dev/null || true)', mapper node: $(node_exists && echo yes || echo no)). Run: $0 --cleanup"
  exit 1
fi

trap 'detach_everything; echo "exit cleanup: nbd pid file now: $(cat "$NBD_SYS/pid" 2>/dev/null || true)"' EXIT
"$MODPROBE" nbd max_part=8
"$QEMU_NBD" --connect="$NBD" --format=qcow2 "$IMG"
sleep "${NBD_SETTLE:-2}"
"$PARTPROBE" "$NBD" 2>/dev/null || true
sleep "${NBD_SETTLE:-1}"
node_exists || { "$LVM" vgchange -ay --devices "${NBD}p3" ubuntu-vg || true; sleep "${NBD_SETTLE:-1}"; }
node_exists || { echo "ABORT: $NODE does not exist after attaching (is the guest root still LVM ubuntu-vg/ubuntu-lv?)"; exit 1; }
"$DMSETUP" deps -o devname "$DM" | grep -q "nbd" || { echo "ABORT: $DM is not backed by the nbd device: $("$DMSETUP" deps -o devname "$DM")"; exit 1; }
mkdir -p "$MNT"
"$MOUNT" -o rw "$NODE" "$MNT"
mkdir -p "$MNT/$(dirname "$RULE_DST")"
if [ -f "$MNT/$RULE_DST" ] && cmp -s "$RULE_SRC" "$MNT/$RULE_DST"; then echo "rule already installed: nothing to do"; else
  [ -f "$MNT/$RULE_DST" ] && cp "$MNT/$RULE_DST" "$MNT/$RULE_DST.bak-$(date +%Y%m%d)"
  cp "$RULE_SRC" "$MNT/$RULE_DST"
  echo "installed /$RULE_DST"
fi
cat "$MNT/$RULE_DST"
sync
