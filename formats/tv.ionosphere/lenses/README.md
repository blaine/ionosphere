# Lens Specifications

Field mapping specs for cross-schema transforms. These JSON files define how source record fields map to ionosphere domain fields.

Published to the PDS as `org.relationaltext.lens` records by `publish.ts`. Used as fallback by pipeline scripts when PDS is unavailable.

## Panproto Integration (@panproto/core@0.25.1)

As of v0.23.0, panproto ships the `PipelineBuilder` combinator API. Lens spec JSON files can be compiled into native protolens chains via `buildPipelineFromSpec()` in `ts/lenses.ts`, which translates rules into panproto combinators:

- Simple field renames -> `renameField()`
- Dotted paths (e.g. `additionalData.room`) -> `hoistField()` + optional `renameField()`
- Array element transforms -> `mapItems()` with inner steps

When WASM is not available, the JS-only `applyLens()` fallback handles the same lens spec files with equivalent field mapping behavior (without complement tracking or bidirectional semantics).

See `docs/superpowers/specs/2026-03-31-lens-layer-design.md` for the full design.
