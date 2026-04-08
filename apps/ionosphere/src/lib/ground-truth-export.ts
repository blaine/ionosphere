import type { EffectiveTalk } from "./corrections";

interface GroundTruthTalk {
  rkey: string;
  title: string;
  speaker: string;
  ground_truth_start: number;
  tolerance_seconds: number;
  verified: boolean;
  notes: string;
}

interface GroundTruthExport {
  stream: string;
  talks: GroundTruthTalk[];
}

export function exportGroundTruth(
  streamSlug: string,
  talks: EffectiveTalk[],
  speakerNames: Map<string, string>,
  dominantSpeakers?: Record<string, string>,
): GroundTruthExport {
  const verified = talks.filter((t) => t.verified);

  return {
    stream: streamSlug,
    talks: verified.map((t) => {
      const speakerId = dominantSpeakers?.[t.rkey];
      const speaker = speakerId ? (speakerNames.get(speakerId) || "") : "";

      return {
        rkey: t.rkey,
        title: t.title,
        speaker,
        ground_truth_start: t.startSeconds,
        tolerance_seconds: 120,
        verified: true,
        notes: `Verified via alignment editor. Confidence: ${t.confidence}.`,
      };
    }),
  };
}
