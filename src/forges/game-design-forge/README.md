# GameDesignForge

GameDesignForge is the game-design-document (GDD) forge for the GameForge ecosystem. It produces structured GDDs that guide downstream GameForge processing — from implementation planning to asset generation and system design.

## Purpose

GameDesignForge provides:

- **GDD schema** — a structured definition for game design documents including `title`, `premise`, `target_audience`, `core_loop`, and `forge_selection`.
- **Schema validation** — YAML validation so all downstream forges consume consistent GDD structures.
- **Forge composition** — a `forge_selection` list that declares which child forges (e.g. MechanicsForge, WorldForge, ModelForge) should be consulted when assembling the final document.

## Connection to GameForge

GameDesignForge is a core child forge of **GameForge**. Together they form the game-design layer of the ecosystem:

- **GameForge** owns the high-level game design document — genres, loops, progression systems, and cross-forge coordination.
- **GameDesignForge** produces the structured GDD that GameForge consumes to coordinate downstream work across MechanicsForge, WorldForge, ModelForge, and other child forges.

GDDs produced by GameDesignForge are consumed by GameForge to inform implementation priorities, asset pipelines, and system-design decisions. In short: GameDesignForge defines *what the game should be on paper*; GameForge decides *how to build it*.

## Files

| File | Description |
|------|-------------|
| `schema.yml` | Data schema for GDDs — defines `title`, `premise`, `target_audience`, `core_loop`, and `forge_selection`. |

## Schema Overview

The schema (`schema.yml`) defines the following GDD fields:

- `title` (string, required) — the GDD title.
- `premise` (string, required) — one-paragraph elevator pitch for the game.
- `target_audience` (string, required) — description of the intended player audience.
- `core_loop` (string, required) — narrative description of the primary gameplay loop.
- `forge_selection` (array of strings, required) — list of forge names/paths to pull from when assembling the GDD.

## Usage

Treat `schema.yml` as the source of truth for the GDD document structure; all GDDs produced by this forge must conform to it.

## Status

Stub. Schema is defined; validation logic and CLI tooling are not yet implemented.
