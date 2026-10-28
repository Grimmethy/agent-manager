# WorldForge

WorldForge is the world-building forge for the GameForge ecosystem. It defines and validates the structure of worlds, biomes, environments, themes, and areas.

## Purpose

WorldForge provides:

- **Schema validation** for world data (YAML/JSON) so all downstream forges consume consistent structures.
- **World definitions** — top-level world metadata (name, biome_type, environment_theme).
- **Biome registry** — classifications for terrain, climate, and ecological zones.
- **Area definitions** — discrete locations within a world, each with its own biome and theme.
- **Environment themes** — aesthetic and atmospheric descriptors that guide art and narrative decisions.

## Connection to SceneForge

WorldForge areas carry a `background_reference` field that points to assets produced by **SceneForge** (the layered scene builder for backdrops and cut-out sprites). When an area is authored in WorldForge, its `background_reference` should resolve to a SceneForge scene ID or file path so that the visual background can be generated or loaded by the SceneForge pipeline.

In short: WorldForge defines *what* the world contains; SceneForge produces *what it looks like*.

## Files

| File | Description |
|------|-------------|
| `schema.yml` | Data schema for worlds, biomes, areas, and environments. |

## Schema Overview

The schema (`schema.yml`) defines:

- `world` — top-level world object with `name`, `biome_type`, `environment_theme`, and `areas`.
- `biome` — biome classification with its own theme and nested areas.
- `area` — a single location with `id`, `name`, `biome_type`, `environment_theme`, optional `background_reference`, and `connections` to other areas.

## Status

Stub. Schema structure is defined; validation logic and CLI tooling are not yet implemented.
