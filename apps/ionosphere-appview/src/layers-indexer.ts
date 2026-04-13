import type Database from "better-sqlite3";
import {
  layersPubToDocument,
  type ExpressionRecord,
  type SegmentationRecord,
  type AnnotationLayersResult,
  type AnnotationLayerRecord,
} from "@ionosphere/format/layers-pub";

// ─── Index functions (create/update) ─────────────────────────────────────────

export function indexExpression(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO layers_expressions
     (uri, rkey, did, transcript_uri, text, language, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uri,
    rkey,
    did,
    (record.sourceRef as string) || "",
    (record.text as string) || "",
    (record.language as string) || "en",
    (record.createdAt as string) || new Date().toISOString(),
  );
}

export function indexSegmentation(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO layers_segmentations
     (uri, rkey, did, expression_uri, tokens_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    uri,
    rkey,
    did,
    (record.expression as string) || "",
    JSON.stringify(record.tokenizations),
    (record.createdAt as string) || new Date().toISOString(),
  );
}

export function indexAnnotationLayer(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO layers_annotations
     (uri, rkey, did, expression_uri, kind, subkind, annotations_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uri,
    rkey,
    did,
    (record.expression as string) || "",
    (record.kind as string) || "",
    (record.subkind as string) || "",
    JSON.stringify(record.annotations),
    (record.createdAt as string) || new Date().toISOString(),
  );
}

// ─── Delete functions ────────────────────────────────────────────────────────

export function deleteExpression(db: Database.Database, uri: string): void {
  // CASCADE: delete segmentations and annotations that reference this expression
  db.prepare("DELETE FROM layers_segmentations WHERE expression_uri = ?").run(uri);
  db.prepare("DELETE FROM layers_annotations WHERE expression_uri = ?").run(uri);
  db.prepare("DELETE FROM layers_expressions WHERE uri = ?").run(uri);
}

export function deleteSegmentation(db: Database.Database, uri: string): void {
  db.prepare("DELETE FROM layers_segmentations WHERE uri = ?").run(uri);
}

export function deleteAnnotationLayer(db: Database.Database, uri: string): void {
  db.prepare("DELETE FROM layers_annotations WHERE uri = ?").run(uri);
}

// ─── Document rebuild ────────────────────────────────────────────────────────

/**
 * Rebuild the materialized document for a talk by re-running Lens 3
 * (layersPubToDocument) from the stored layers.pub records.
 *
 * Called after any layers.pub record is created/updated. If the full set
 * of records (expression + segmentation + at least one annotation layer)
 * isn't available yet, this is a no-op — the document will be rebuilt
 * when the final piece arrives.
 */
export async function rebuildDocument(
  db: Database.Database,
  expressionUri: string,
): Promise<void> {
  // 1. Look up expression
  const expr = db
    .prepare("SELECT * FROM layers_expressions WHERE uri = ?")
    .get(expressionUri) as any;
  if (!expr) return;

  // 2. Look up segmentation
  const seg = db
    .prepare("SELECT * FROM layers_segmentations WHERE expression_uri = ?")
    .get(expressionUri) as any;
  if (!seg) return;

  // 3. Look up all annotation layers
  const annRows = db
    .prepare("SELECT * FROM layers_annotations WHERE expression_uri = ?")
    .all(expressionUri) as any[];

  // Map subkind → layer key
  const subkindToKey: Record<string, keyof AnnotationLayersResult> = {
    "sentence-boundary": "sentences",
    "paragraph-boundary": "paragraphs",
    ner: "entities",
    "topic-segment": "topics",
  };

  const annotationLayers: Partial<AnnotationLayersResult> = {};
  for (const row of annRows) {
    const key = subkindToKey[row.subkind];
    if (key) {
      annotationLayers[key] = {
        $type: "pub.layers.annotation.annotationLayer",
        expression: expressionUri,
        kind: row.kind,
        subkind: row.subkind,
        sourceMethod: "automatic",
        metadata: { tool: "ionosphere-pipeline", timestamp: row.created_at },
        annotations: JSON.parse(row.annotations_json),
        createdAt: row.created_at,
      } as AnnotationLayerRecord;
    }
  }

  // Need at least one annotation layer to produce a useful document
  if (Object.keys(annotationLayers).length === 0) return;

  // 4. Build typed records for layersPubToDocument
  const expressionRecord: ExpressionRecord = {
    $type: "pub.layers.expression.expression",
    id: expr.rkey,
    kind: "transcript",
    text: expr.text,
    language: expr.language,
    sourceRef: expr.transcript_uri,
    metadata: { tool: "ionosphere-pipeline", timestamp: expr.created_at },
    createdAt: expr.created_at,
  };

  const segmentationRecord: SegmentationRecord = {
    $type: "pub.layers.segmentation.segmentation",
    expression: expressionUri,
    tokenizations: JSON.parse(seg.tokens_json),
    createdAt: seg.created_at,
  };

  // Fill missing layers with empty annotations so layersPubToDocument gets
  // the full AnnotationLayersResult shape it expects
  const emptyLayer = (kind: string, subkind: string): AnnotationLayerRecord => ({
    $type: "pub.layers.annotation.annotationLayer",
    expression: expressionUri,
    kind,
    subkind,
    sourceMethod: "automatic",
    metadata: { tool: "ionosphere-pipeline", timestamp: "" },
    annotations: [],
    createdAt: "",
  });

  const fullLayers: AnnotationLayersResult = {
    sentences: annotationLayers.sentences ?? emptyLayer("span", "sentence-boundary"),
    paragraphs: annotationLayers.paragraphs ?? emptyLayer("span", "paragraph-boundary"),
    entities: annotationLayers.entities ?? emptyLayer("span", "ner"),
    topics: annotationLayers.topics ?? emptyLayer("span", "topic-segment"),
  };

  // 5. Run Lens 3
  const document = await layersPubToDocument(
    expressionRecord,
    segmentationRecord,
    fullLayers,
  );

  // 6. Find the talk_uri from the transcript table
  const transcript = db
    .prepare("SELECT talk_uri FROM transcripts WHERE uri = ?")
    .get(expr.transcript_uri) as any;
  if (!transcript) return;

  // 7. Update the talk's document field
  db.prepare("UPDATE talks SET document = ? WHERE uri = ?").run(
    JSON.stringify(document),
    transcript.talk_uri,
  );
}
