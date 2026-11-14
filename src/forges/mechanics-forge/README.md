# MechanicsForge

MechanicsForge is the game-mechanics forge for the GameForge ecosystem. It defines, validates, and composes the rules, abilities, and interactions that drive gameplay.

## Purpose

MechanicsForge provides:

- **Mechanic schema** — a structured definition for every game mechanic (name, type, parameters, balance_weight).
- **Parameter system** — free-form key-value pairs for mechanic-specific configuration, enabling rapid iteration without schema churn.
- **Balance weights** — a numeric `balance_weight` per mechanic used by balance systems to compare and tune mechanic power/cost.
- **Composition rules** — a declarative structure for how mechanics combine, trigger, synergize, or conflict with one another in a composition.
- **Schema validation** — YAML/JSON validation so all downstream forges consume consistent mechanic definitions.

## Connection to GameForge

MechanicsForge is a core child forge of **GameForge**. Together they form the game-design layer of the ecosystem:

- **GameForge** owns the high-level game design document — genres, loops, progression systems, and cross-forge coordination.
- **MechanicsForge** owns the granular mechanic definitions and their composition rules — the "verbs" of the game.

GameForge references MechanicsForge compositions to ensure that the set of mechanics supports the intended gameplay loop, pacing, and balance targets. MechanicsForge compositions are validated against GameForge's design constraints before being consumed by downstream systems (e.g. simulation, UI, balancing tools).

In short: GameForge defines *what the game is*; MechanicsForge defines *what the game does*.

## Files

| File | Description |
|------|-------------|
| `schema.yml` | Data schema for mechanics, composition rules, conditions, and modifiers. |

## Schema Overview

The schema (`schema.yml`) defines:

- `mechanic` — top-level mechanic object with `name`, `type`, `parameters` (key-value pairs), `balance_weight`, optional `description`, `tags`, and a `composition` rule block.
- `composition_rule` — how the mechanic combines with others: `mode` (stack/chain/replace/conditional/exclusive), `triggers`, `conditions`, `modifiers`, `synergy_with`, `conflicts_with`.
- `condition` — a field/operator/value check used in composition eligibility.
- `modifier` — a delta applied to a target mechanic or attribute, optionally with a duration.

## Status

Stub. Schema structure and composition rules are defined; validation logic and CLI tooling are not yet implemented.
