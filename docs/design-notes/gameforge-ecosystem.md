# GameForge ecosystem (design note)

Status: design only. No forge stubs or code exist yet. Stub creation is tracked separately by the queued task `adhoc-create-stubs-for-gameforge-ecosystem-worldforge-mechanicsforge-modelforge-gameforge-gamedesignforge-1793165384854`.

## Premise

An umbrella GameForge pulls assets from child forges to build videos, ads, and games. Scenes and character information from the existing forges are turned into reusable assets. Each child forge owns one kind of asset, and GameForge composes them. Forges are grouped into subcategories as the set grows.

## Child forges

- **WorldForge:** scenes, characters, and area/theme plans. It supplies the detailed environment plans used by videos, ads, and games. Built first.
- **MechanicsForge:** a standalone forge for game mechanics. The set of mechanics is expected to grow large enough to need its own forge.
- **ModelForge:** 3D models. It also feeds StageForge.
- **GameDesignForge:** docs that define what GameForge pulls from each other forge.
- **StageForge:** named here only because the brief treats it as a consumer of ModelForge. Its scope is not yet defined.

## Build order

1. World building (WorldForge).
2. Game and mechanics (MechanicsForge, then GameForge and GameDesignForge).
3. ModelForge for 3D models, which also feeds StageForge.

## Subcategories

Forges are to be grouped into subcategories. The grouping principle is that forges that serve the same output type or the same stage of production sit together. The actual taxonomy is not decided.

## Open decisions

These are unresolved. Do not treat any of them as settled.

1. Whether each forge is a directory or a JSON registry.
2. Whether StageForge is its own forge.
3. The subcategory taxonomy.
4. Whether the video, ad, and game outputs share one WorldForge or each get their own.

## Related work

- Queued task `adhoc-create-stubs-for-gameforge-ecosystem-worldforge-mechanicsforge-modelforge-gameforge-gamedesignforge-1793165384854` covers creating the forge stubs.
