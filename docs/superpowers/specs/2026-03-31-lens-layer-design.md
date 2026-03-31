# Lens Layer: Panproto-Powered Schema Boundaries for Ionosphere

## Overview

The lens layer makes ionosphere forwards-compatible with both source schema changes (new conference platforms, different calendar lexicons, alternative transcription providers) and output schema evolution (versioning `tv.ionosphere.*` lexicons). It uses panproto as the runtime, which provides algebraically correct bidirectional lenses with native AT Protocol support.

## Architecture

Lenses sit at every boundary where an external schema meets an ionosphere schema. Internal transforms (compact encoding, annotation overlay) stay as TypeScript but are shaped for future lens graduation.

```
Source lexicons (calendar, VOD, Whisper, ...)
    ↓ panproto lens (auto-generated from lexicon pairs)
Domain lexicons (tv.ionosphere.talk, transcript, ...)
    ↓ version migration lens (when lexicons evolve)
Domain lexicons vN
    ↓ internal TypeScript (decodeToDocument, overlay)
Rendered output
```

Lenses are AT Protocol records, discoverable via standard XRPC, indexed by the appview.

## Runtime: @panproto/core

Dependency: `@panproto/core` (v0.22.0+, MIT, WASM-backed, ~860KB).

### Schema Loading

`panproto.parseLexicon()` ingests any ATProto lexicon JSON and returns a `BuiltSchema`. We store the source lexicons we don't own alongside our own in the `lexicons/` directory:

```
lexicons/
  tv/ionosphere/          # our lexicons
    talk.json
    speaker.json
    concept.json
    event.json
    transcript.json
    annotation.json
  community/lexicon/      # source: ATmosphereConf schedule
    calendar/
      event.json
  place/stream/           # source: Streamplace VOD
    video.json
  openai/whisper/         # source: OpenAI Whisper output
    verbose_json.json
```

### Lens Generation

For most schema boundaries, panproto auto-generates the lens:

```typescript
const panproto = await Panproto.init();
const calendarSchema = panproto.parseLexicon(calendarEventLexicon);
const talkSchema = panproto.parseLexicon(talkLexicon);
const lens = panproto.lens(calendarSchema, talkSchema);
```

For boundaries where auto-generation needs overrides (ambiguous mappings, custom defaults), we serialize protolens chains via `chain.toJson()` and store them as AT Protocol records.

### Data Conversion

`panproto.convert()` takes plain JS objects and returns plain JS objects:

```typescript
const talk = await panproto.convert(scheduleRecord, {
  from: calendarSchema,
  to: talkSchema,
  defaults: { room: '', category: '' },
});
```

No msgpack serialization on our side.

### Version Migration

When `tv.ionosphere.talk` evolves from v1 to v2:

```typescript
const talkV1 = panproto.parseLexicon(talkV1Lexicon);
const talkV2 = panproto.parseLexicon(talkV2Lexicon);
const migrated = await panproto.convert(oldRecord, { from: talkV1, to: talkV2 });
```

Panproto auto-generates the migration lens from the lexicon diff. The complement preserves any data removed between versions for round-tripping.

## Lenses as AT Protocol Records

Serialized protolens chains are stored as records in the `org.relationaltext.lens` collection on the PDS. This makes lenses discoverable via standard XRPC mechanisms, same as any other AT Protocol record.

### Publishing

`publish.ts` publishes lens records before all other records. Each lens record contains the serialized protolens chain JSON, source/target identifiers, and version metadata.

### Resolution

Pipeline scripts resolve lenses through:

1. **Appview index** — materialized from backfill/Jetstream (fast, local SQLite lookup)
2. **PDS fetch** — direct XRPC `listRecords` on `org.relationaltext.lens` from our PDS (always available after publish)
3. **Error** — no lens found

No disk file fallback. The PDS is the single source of truth.

### Indexing

The appview indexes `org.relationaltext.lens` as a new collection. The indexer table stores: `uri, did, rkey, source_nsid, target_nsid, version, chain_json`.

## Pipeline Integration

### publish.ts

Gains step 0: publish lens records from lexicon pairs to the PDS. For auto-generated lenses, this means loading both lexicons, generating the chain, serializing it, and writing the record. Idempotent via `putRecord`.

### ingest.ts

Already uses a lens for schedule-to-talk. Changes:
- Resolve lens from appview index / PDS instead of `loadLens("filename")`
- Wire up the VOD-to-talk lens (currently bypassed in `parseVodRecord`)
- Provenance: record which lens produced each talk record

### transcribe.ts / providers

The transcription provider returns raw output in its native format. A lens transforms it to `tv.ionosphere.transcript` format. Swapping to Deepgram or AssemblyAI means:
1. Add the new provider's output lexicon to `lexicons/`
2. Publish the new lens (auto-generated from lexicon pair)
3. The pipeline resolves the right lens by source type

### enrich.ts

No change. LLM enrichment is bespoke extraction logic, not a schema boundary.

### indexer.ts

Gains `org.relationaltext.lens` as a new indexed collection, processed by `processEvent`.

### routes.ts

No change. `decodeToDocument` and `overlayAnnotations` are internal lens-shaped transforms. They stay as TypeScript, candidates for graduation when the pattern proves out (following pannacotta's lead on internal lens usage).

## Format Package Changes

`@ionosphere/format` changes:

### lenses.ts (rewrite)

Becomes a thin panproto wrapper (~40 lines):

```typescript
import { Panproto, LensHandle, BuiltSchema } from '@panproto/core';

let _panproto: Panproto | null = null;

export async function init(): Promise<Panproto> {
  if (!_panproto) _panproto = await Panproto.init();
  return _panproto;
}

export async function loadSchema(lexiconJson: object | string): Promise<BuiltSchema> {
  const pp = await init();
  return pp.parseLexicon(lexiconJson);
}

export async function createLens(from: BuiltSchema, to: BuiltSchema): Promise<LensHandle> {
  const pp = await init();
  return pp.lens(from, to);
}

export async function convert(
  data: object,
  from: BuiltSchema,
  to: BuiltSchema,
  defaults?: Record<string, unknown>,
): Promise<unknown> {
  const pp = await init();
  return pp.convert(data, { from, to, defaults });
}
```

Exports `init`, `loadSchema`, `createLens`, `convert`. Pipeline scripts consume these.

### Deleted

- `LensSpec`, `LensRule` interfaces
- `applyLens` function
- `loadLens` function
- `getNestedValue` helper

### Kept

- `lenses/` directory on disk becomes an authoring workspace only (edit JSON there, publish pushes to PDS)
- Existing lens JSON files remain as reference but are no longer loaded at runtime

## What Gets Deleted

- `formats/tv.ionosphere/ts/lenses.ts` — current implementation (replaced by panproto wrapper)
- `formats/tv.ionosphere/ts/lenses.test.ts` — current tests (replaced by panproto law checks + integration tests)

## Testing

### Lens Law Verification

Panproto provides `lens.checkLaws(instance)` which verifies both GetPut and PutGet laws. Run this on real source records from each provider.

### Integration Tests

- Real `community.lexicon.calendar.event` record from ATmosphereConf PDS → lens → verify output matches expected `tv.ionosphere.talk` shape
- Real `place.stream.video` record from Streamplace PDS → lens → verify video metadata maps correctly
- Whisper verbose_json output → lens → verify transcript format

### Round-Trip Tests

- Lens publish → PDS → appview backfill → resolve from index → apply → verify output
- PDS direct fetch fallback when appview index is empty

### Regression

- If a source lexicon changes upstream, auto-generation produces a different lens. Tests catch schema drift before it hits production.

## Internal Lens Graduation Path

`decodeToDocument` and `overlayAnnotations` are lens-shaped but stay as TypeScript. The graduation criteria:
- The combinator vocabulary can express the transform (array expansion with byte-range computation is the gap for `decodeToDocument`)
- Pannacotta demonstrates the pattern working for similar internal boundaries
- The benefit of formal lens laws outweighs the complexity of expressing the transform declaratively

This is not a near-term goal. Note it and revisit when panproto's combinator vocabulary grows.
