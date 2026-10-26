# P40 VM memory: getting RAM back to the host with virtio-mem

The P40 lane runs `llama-server` inside the libvirt VM `p40-passthrough` on wok, with the Tesla P40 passed through (VFIO). This note is the design and the
operator runbook for letting that VM's RAM go back to wok when the lane is idle. Code: `scripts/p40-vm-memory/`, tests: `scripts/p40-vm-memory.test.js`.

## Why the balloon is not enough

VFIO pins all guest RAM for the passthrough device's DMA and QEMU disables page discards for such a VM. The virtio balloon (and free-page reporting)
therefore only changes what the guest *sees*; the QEMU process stays at the full configured size. Measured 2026-10-21: QEMU RSS 6.05 GiB with the balloon
at 4 GiB and a 6 GiB maximum. The Python balloon controller (`/media/model-cache/github/p40-vm-balloon/`, `p40-balloon.service`) is correct for what it
does (it gave the guest the extra GiB that stopped the OOM kills) but costs wok the whole 6 GiB at all times. It is superseded by this, not edited.

## Design

* **4 GiB static base** (kernel, `llama-server`, CUDA's pinned host buffers: pinned pages cannot be unplugged) plus **one virtio-mem device of 2 GiB**
  (2 MiB blocks, node 0), requested size 0 at boot. QEMU's RamDiscardManager makes VFIO map only the *plugged* blocks, so unplugged blocks are returned to
  the host.
* The guest onlines the added blocks **movable** (`guest/99-virtio-mem-online-movable.rules`) so it can migrate pages away and unplug them.
* `controller.js` sets the device's requested size with `virsh update-memory-device --live --requested-size` from `policy.js`: grow a step when the guest's
  usable memory is under 1.5 GiB or it is swapping (never past the cap, never while wok would drop under a 2 GiB reserve), wait while plugged is still
  catching up to requested, accept the guest's real size when an unplug is stuck, shrink only after usable stayed over 2.5 GiB for 5 minutes, back off 60 s
  after a failed update.
* `measure.js` logs QEMU RSS, requested and plugged sizes, guest usable and wok MemAvailable together: the claim "the host gets memory back" is measured.

## Known failure modes this encodes

1. **Locked-memory limit** (oVirt bug 1272742): a VM with an assigned device crashed on hot-add because RLIMIT_MEMLOCK was sized for the boot RAM. After
   conversion read `/proc/<qemu pid>/limits` and confirm *Max locked memory* >= base + region before running the controller. `precheck.js` warns about it.
2. **Everything pinned at first boot** (a libvirt-users report of a GPU VM with a virtio-mem device immediately using 9+ GB): after the first boot with the
   device, check QEMU RSS with `measure.js` is near the base size, not base + region, before any grow.
3. **The P40 must survive the restart**: after conversion `nvidia-smi` in the guest must show the card and Ollama must answer with all models before the lane
   is called healthy.
4. **Leftover nbd attach** (2026-10-21 guest-disk edit): the first attempt aborted with the disk still attached and the VM was then started with the image
   open twice. `offline-apply-udev.sh` refuses to run while an attach, a mapper node or a `qemu-nbd` for the image exists and has `--cleanup`.

## Operator runbook (the pipeline never runs these)

1. `node scripts/p40-vm-memory/precheck.js` (read-only). Do not continue on NO-GO.
2. `virsh shutdown p40-passthrough`; wait for `shut off`.
3. `pkexec bash scripts/p40-vm-memory/offline-apply-udev.sh` (installs the movable-online rule into the shut-off VM; if it reports a leftover attach run it with `--cleanup` first).
4. `node scripts/p40-vm-memory/convert-xml.js --out-dir ~/p40-vm-memory-out` writes `p40-passthrough.virtio-mem.xml` and `p40-passthrough.rollback.xml`. Validate with `virt-xml-validate <file> domain`, then `virsh define <virtio-mem.xml>`.
5. `virsh start p40-passthrough`. Check: Ollama answers, `nvidia-smi` in the guest, `measure.js --once` (RSS near 4 GiB), memlock limit (failure mode 1).
6. Stop `p40-balloon.service` (`systemctl --user disable --now p40-balloon.service`), then run `node scripts/p40-vm-memory/controller.js --dry-run` and watch, then without `--dry-run` (a user unit like p40-balloon.service).
7. **Rollback, one command set:** `virsh shutdown p40-passthrough; virsh define ~/p40-vm-memory-out/p40-passthrough.rollback.xml; virsh start p40-passthrough`.

## Open questions (fill in from the first real run)

* Is a 2 GiB virtio-mem region worth it versus a static 5 GiB VM? Decide from the P40's measured peak under the cache cap (`LLAMA_ARG_CACHE_RAM=512`, `LLAMA_ARG_CTX_CHECKPOINTS=2`, applied 2026-10-21).
* Can the movable zone be unplugged while `llama-server`'s prompt cache sits in it?
* Does the P40 reset cleanly across the restart the conversion needs?

Results: _not run yet_ (add the `measure.js` before/after numbers here).
