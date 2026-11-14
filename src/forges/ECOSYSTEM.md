# Forge ecosystem

This document describes how the forges depend on each other. Each forge is currently a stub or in progress. This file does not assume that the sibling stub files exist yet.

## Flow

WorldForge → MechanicsForge → ModelForge → GameDesignForge → GameForge

1. WorldForge produces world geography, regions, and world-level constraints.
2. MechanicsForge takes world constraints and produces rule sets and simulation mechanics.
3. ModelForge produces model assets that the mechanics and content use.
4. GameDesignForge combines world, mechanics, and model outputs into design documents, content specs, and progression plans.
5. GameForge consumes outputs from all four upstream forges and holds the runtime game state and asset registry.

## Relationships and dependencies

- WorldForge: no upstream forge dependency. Feeds MechanicsForge, GameDesignForge, and GameForge.
- MechanicsForge: depends on WorldForge. Feeds ModelForge, GameDesignForge, and GameForge.
- ModelForge: depends on MechanicsForge. Feeds GameDesignForge and GameForge.
- GameDesignForge: depends on WorldForge, MechanicsForge, and ModelForge. Feeds GameForge.
- GameForge: depends on WorldForge, MechanicsForge, ModelForge, and GameDesignForge. Has no downstream forge.

The GameForge integration schema is in src/forges/game-forge/schema.yml. Its readme is in src/forges/game-forge/README.md.
