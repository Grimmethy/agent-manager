# Magicka-style spell crafting (brain dump)

## Status

Brain dump, not approved. Date: 2026-11-16.
Source: chat 1793171274-89846aff, recovered 2026-10-28 (user input only; the assistant replies were lost to the response-loss bug).
Brain-dump entry: bd-1793218739129-game-mechanics-forge-reference-magicka-s.

## Summary

Magicka's spell crafting is a real-time, queue-based combination mechanic. A player queues up to five elemental components, and they combine into one spell. The resulting spell's type and power are determined by:

- the specific elements used,
- their order of dominance,
- the casting method (Projectile, Shard, Beam, or Spray).

The user considers this one of their favourite spell mechanics and proposes it as an addition to the DnD-inspired system.

## Core mechanics

- **Elemental synergy:** combining elements creates new effects. Examples from the source: Fire + Water = Steam; Water + Cold = Ice.
- **Order of dominance:** when several elements are present, the spell takes the form of the highest-priority element in the queue. The source gives the order in two places, and they differ (see Open questions).
- **Opposite cancellation:** opposite elements in the same queue (for example Fire and Water) cancel out, producing no effect or a neutral blast.
- **Casting methods:** the player picks one of four attack types. Each changes the shape, range, and area of effect of the combined elements: Projectile, Shard, Beam, Spray.

## Proposed direction

Rather than tying the system to pre-existing spells, break existing spells into their component parts. Those parts become the building blocks of a flexible spell-crafting system.

This direction needs substantial balancing work and a dedicated UI. Neither is designed here.

## Open questions

1. **Dominance order is inconsistent in the source.** One statement gives Projectile > Shard > Beam > Spray. Another gives Shield > Projectile > Shard > Beam > Spray. Decide whether Shield is an element or a casting method, and then fix a single order.
2. **Queue limit:** does the five-slot queue limit fit the DnD system?
3. **Cancellation result:** when opposite elements cancel, is the result nothing, or a neutral blast? Which one?
4. **Cost mapping:** how does a DnD spell slot or resource cost map to queue length and to spell power?
5. **Real-time meaning:** does the real-time aspect have any meaning in a turn-based DnD system, or does it need a turn-based equivalent?
6. **Component decomposition:** which existing spells can be split into components cleanly, and which cannot?

## Out of scope for now

- Balancing numbers.
- UI design.
- Any implementation or code.

This document records the structure and open questions only.
