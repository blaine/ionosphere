# Lens Specifications

Field mapping specs for cross-schema transforms. These JSON files define how source record fields map to ionosphere domain fields.

Published to the PDS as `org.relationaltext.lens` records by `publish.ts`. Used as fallback by pipeline scripts when PDS is unavailable.

When panproto's `pipeline()` combinator API ships (see panproto/panproto#15), these specs will be replaced by panproto protolens chains.

See `docs/superpowers/specs/2026-03-31-lens-layer-design.md` for the full design.
