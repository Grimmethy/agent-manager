# ModelForge

ModelForge is the 3D model forge for the GameForge ecosystem. It defines, validates, and serializes 3D model definitions — their geometry, formats, and associated assets.

## Purpose

ModelForge provides:

- **Model schema** — a structured definition for every 3D model (name, format, source, mesh_reference, texture_map_reference).
- **Format support** — validation of model file formats: glTF, OBJ, and FBX.
- **Asset references** — typed references to mesh geometry and texture map assets produced by other forges.
- **Schema validation** — YAML/JSON validation so all downstream forges consume consistent model definitions.

## Connection to GameForge

ModelForge is a core child forge of **GameForge**. Together they form the game-asset layer of the ecosystem:

- **GameForge** owns the high-level game design document — genres, loops, progression systems, and cross-forge coordination.
- **ModelForge** owns the 3D model definitions and asset references — the visual geometry that brings game designs to life.

GameForge references ModelForge model definitions to ensure that the set of 3D assets supports the intended game art direction and technical constraints. ModelForge references resolve to assets produced by **SceneForge** (the scene and asset pipeline) for both mesh geometry and texture maps.

In short: GameForge defines *what the game needs to look like*; ModelForge defines *the 3D assets that provide it*.

## Connection to StageForge

ModelForge also serves **StageForge** (the stage and environment composition system):

- StageForge composes scenes from assets produced by other forges, including 3D models.
- A StageForge scene references ModelForge models via their `mesh_reference` to instantiate 3D geometry in a stage layout.
- Texture maps referenced by ModelForge models may be authored or refined in StageForge's texture pipeline.

In short: StageForge uses ModelForge models as *instantiable props and characters* within composed scenes.

## Files

| File | Description |
|------|-------------|
| `schema.yml` | Data schema for 3D models, formats, sources, and asset references. |

## Schema Overview

The schema (`schema.yml`) defines:

- `model` — top-level model object with `name`, `format` (glTF/OBJ/FBX), `source`, `mesh_reference`, and optional `texture_map_reference`.

## Status

Stub. Schema structure is defined; validation logic and CLI tooling are not yet implemented.
