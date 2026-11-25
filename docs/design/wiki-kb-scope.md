# Wiki / knowledge-base repo: scope of the first step

## Premise correction

The brief says existing notes already use `[[wikilink]]` syntax, so no migration is needed. The code contradicts this. `python/build_note_graph.py:1-16` states that existing Second Brain notes contain zero `[[...]]` spans and that the wikilink edge convention is new. Link parsing must therefore work on notes that have no links, and no step may assume they exist.

## First step (this plan)

A storage adapter over plain markdown files, plus wikilink parsing ported from the Python module:

- `wiki-kb/src/secondbrain-fs.js`: `listPages(dir)` and `readPage(dir, relPath)`. The vault directory is a parameter. There is no config lookup, cache, watcher, or timer.
- `wiki-kb/src/wikilinks.js`: `extractWikilinkTargets` and `resolveWikilink`, ported from `_extract_wikilink_targets` and `resolve_wikilink` in `python/build_note_graph.py`. The two must be kept in step.
- Tests under `wiki-kb/test/` use `node:test` and temporary fixture directories that are removed afterward.

The index is rebuilt inside each call that needs it. No timers or polling are used.

## Deferred (each a separate later plan)

- Spaces (one isolated space per consuming project).
- Public read-only share-link API per page.
- Typed structured fields per page type.
- Journal/timeline default entry point.
- Block-level backlinks.
- Renderer.
- Concept-to-note links (`src/concepts.js` rows have no link field today).

## Borrowed design principles

- Docmost: multi-tenant Spaces, one service with isolated spaces per project.
- Wiki.js: a pluggable storage adapter, so the API layer does not know where content lives.
- Outline: a scoped, read-only share link per page, fetched by each consuming site's own frontend.
- XWiki: optional typed fields alongside the markdown body.
- Logseq: the journal as the entry point, with the graph organized from backlinks.
- SiYuan: block-level backlinks as a later refinement. Page-level `[[wikilinks]]` are enough to start.

## Open question

The repo location is unresolved. This step is built under the relative root `wiki-kb/` inside this checkout. Confirm with the owner before moving it into its own repo.
