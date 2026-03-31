# Panproto Wishlist for Ionosphere

What we need from panproto to make the ionosphere lens layer fully declarative — no mechanical shims, all transforms expressed as protolens chains stored as AT Protocol records.

Filed upstream: panproto/panproto#15

---

## 1. Pipeline combinator API in the TypeScript SDK

**Priority: critical**

The tutorial (Chapter 6) shows:
```typescript
const lens = pipeline([
  renameField('displayName', 'name'),
  addField('bio', 'string', ''),
  removeField('legacyField'),
  hoistField('additionalData.room'),
]);
```

This is exactly what we need for cross-schema transforms (calendar event → talk, VOD → talk). The Rust engine has these combinators, but they're not exported from `@panproto/core`. The WASM exposes `apply_protolens_step` with elementary steps (`rename_sort`, `drop_sort`, `add_sort`, `rename_op`, `drop_op`, `add_op`), but:

- `rename_sort` renames the vertex, not the prop edge `name` (which controls the JSON key)
- `rename_op` renames the edge kind, not the edge name
- There's no hoist step (move nested field to top level)

**What we need:** `renameField(oldPropName, newPropName)` that renames the JSON property key — which means renaming the prop edge's `name` attribute, not just the vertex.

**Our workaround:** Existing `applyLens` field mapper with JSON lens specs.

## 2. Prop edge name rename step

**Priority: critical**

The elementary step vocabulary has 6 types: `{add,drop,rename}_{sort,op}`. None of these rename a prop edge's `name` attribute. In ATProto lexicons, the JSON property name comes from the prop edge name (e.g., `edge('body', 'body.name', 'prop', { name: 'name' })`). To rename a JSON key from `name` to `title`, we need to rename this edge attribute.

Either:
- A new step type: `rename_prop_name` (or `rename_edge_name`)
- Or make `rename_op` also handle the edge `name` attribute when the edge kind is `prop`

## 3. Hoist / restructure steps

**Priority: high**

ATmosphereConf calendar events store metadata in `additionalData.room`, `additionalData.category`, etc. Ionosphere talks have these as top-level fields: `room`, `category`, `talkType`. This is a hoist: move a property from a nested object to the parent.

The auto-lens generation (Chapter 17) has a "Restructuring Pass" that handles this, but it requires finding a morphism first — which fails when the schemas are too different.

We need either:
- A `hoist_field` elementary step
- Or the ability to express this as a composed rename_sort + edge rearrangement

## 4. Morphism hints for cross-namespace schemas

**Priority: high**

`pp.lens(calendarSchema, talkSchema)` fails with "no morphism found" because the schemas have completely different NSID namespaces. The morphism search uses name similarity (edit distance) for scoring, but `community.lexicon.calendar.event:body.name` has no name similarity to `tv.ionosphere.talk:body.title`.

The overlap discovery (`discover_overlap`) also fails because `find_best_morphism` returns empty.

We need a way to provide explicit vertex correspondence hints:
```typescript
const lens = pp.lens(calendarSchema, talkSchema, {
  hints: {
    'community.lexicon.calendar.event:body.name': 'tv.ionosphere.talk:body.title',
    'community.lexicon.calendar.event:body.description': 'tv.ionosphere.talk:body.description',
  }
});
```

Or equivalently, the ability to seed the morphism search with known correspondences.

## 5. `lift_json` exposed in the TypeScript SDK

**Priority: medium**

The WASM has `lift_json(migration, json_bytes, root_vertex)` which takes JSON in and returns JSON out. The SDK's `CompiledMigration.lift()` requires an `Instance` object (from `pp.parseJson()`), which is less ergonomic for the common case of transforming plain JSON records.

Exposing `lift_json` in the SDK would eliminate the `parseJson` → `lift` → `toJson` round-trip.

## 6. `parseLexicon` metadata format fix

**Priority: medium**

`schema_metadata` WASM function returns positional arrays `[protocol, vertices[], edges[]]` but the SDK's `parseLexicon` method expects named object keys (`meta.vertices.map(...)`). We work around this with a direct WASM call that handles both formats.

## 7. WASM binary in npm package

**Priority: medium**

`@panproto/core@0.22.0` ships the TypeScript SDK shell but not the WASM binary (`panproto_wasm.js` + `panproto_wasm_bg.wasm`). We build from source with `wasm-pack build crates/panproto-wasm --target web --release` and copy the output into `node_modules`.

Additionally, the web-target glue module uses `fetch()` to load the `.wasm` file, which doesn't work with `file://` URLs in Node.js. We work around this by pre-loading the binary with `readFileSync` and using `initSync({ module: wasmBytes })` via a wrapped glue module.

Options:
- Ship the WASM in the npm tarball (adds ~6MB)
- Publish a separate `@panproto/wasm` package
- Ship a Node.js-target build alongside the web-target build

## 8. Migration builder for partial cross-schema transforms

**Priority: low (covered by items 1-4)**

`pp.migration(src, tgt).map(...)` works for structurally similar schemas but fails with "root node was pruned during restriction" when the source schema has many unmapped vertices. This is the expected behavior for a morphism-based migration, but it means the migration builder can't be used for cross-schema transforms where most source fields are dropped.

If items 1-4 land, this becomes unnecessary — the pipeline combinator API is the right tool for cross-schema transforms.

---

## What works great today

- `parseLexicon()` — parses any ATProto lexicon into a schema graph
- `diff()` / `diffFull()` — accurate structural diffs between schema versions
- `validateSchema()` — validates schemas against protocol rules
- `pp.lens(v1, v2)` — auto-generates lenses between structurally similar schemas
- `migration().map().compile()` — explicit vertex mapping for version migration
- `protolensChain().toJson()` / `fromJson()` — serialization for storage as AT Protocol records
- `protocol('atproto')` + `SchemaBuilder` — manual schema construction
- Schema diffing with 20+ change categories

The algebraic foundations are excellent. These SDK gaps are the last mile to making cross-schema transforms fully declarative.
