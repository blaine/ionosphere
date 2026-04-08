// apps/ionosphere/src/lib/corrections.ts

export interface BaseTalk {
  rkey: string;
  title: string;
  speakers: string[];
  startSeconds: number;
  endSeconds: number | null;
  confidence: string;
}

export interface EffectiveTalk extends BaseTalk {
  verified: boolean;
}

export type CorrectionAction =
  | { type: "move_boundary"; talkRkey: string; edge: "start" | "end"; fromSeconds: number; toSeconds: number }
  | { type: "split_talk"; talkRkey: string; atSeconds: number; newRkey: string }
  | { type: "add_talk"; rkey: string; title: string; startSeconds: number; endSeconds: number }
  | { type: "remove_talk"; talkRkey: string }
  | { type: "set_talk_title"; talkRkey: string; title: string }
  | { type: "verify_talk"; talkRkey: string }
  | { type: "unverify_talk"; talkRkey: string }
  | { type: "name_speaker"; speakerId: string; name: string };

export interface CorrectionEntry {
  id: string;
  timestamp: string;
  authorDid?: string;
  streamSlug: string;
  action: CorrectionAction;
}

export interface ReplayResult {
  talks: EffectiveTalk[];
  speakerNames: Map<string, string>;
}

export function replayCorrections(
  baseTalks: BaseTalk[],
  corrections: CorrectionEntry[],
  cursor?: number,
): ReplayResult {
  const limit = cursor ?? corrections.length;
  const active = corrections.slice(0, limit);

  let talks: EffectiveTalk[] = baseTalks.map((t) => ({ ...t, verified: false }));
  const speakerNames = new Map<string, string>();

  for (const entry of active) {
    const { action } = entry;

    switch (action.type) {
      case "move_boundary": {
        talks = talks.map((t) => {
          if (t.rkey !== action.talkRkey) return t;
          if (action.edge === "start") return { ...t, startSeconds: action.toSeconds };
          return { ...t, endSeconds: action.toSeconds };
        });
        break;
      }
      case "split_talk": {
        const idx = talks.findIndex((t) => t.rkey === action.talkRkey);
        if (idx === -1) break;
        const original = talks[idx];
        const first: EffectiveTalk = { ...original, endSeconds: action.atSeconds };
        const second: EffectiveTalk = {
          ...original,
          rkey: action.newRkey,
          title: "Untitled",
          startSeconds: action.atSeconds,
          verified: false,
        };
        talks = [...talks.slice(0, idx), first, second, ...talks.slice(idx + 1)];
        break;
      }
      case "add_talk": {
        const newTalk: EffectiveTalk = {
          rkey: action.rkey,
          title: action.title,
          speakers: [],
          startSeconds: action.startSeconds,
          endSeconds: action.endSeconds,
          confidence: "manual",
          verified: false,
        };
        talks = [...talks, newTalk].sort((a, b) => a.startSeconds - b.startSeconds);
        break;
      }
      case "remove_talk": {
        talks = talks.filter((t) => t.rkey !== action.talkRkey);
        break;
      }
      case "set_talk_title": {
        talks = talks.map((t) =>
          t.rkey === action.talkRkey ? { ...t, title: action.title } : t,
        );
        break;
      }
      case "verify_talk": {
        talks = talks.map((t) =>
          t.rkey === action.talkRkey ? { ...t, verified: true } : t,
        );
        break;
      }
      case "unverify_talk": {
        talks = talks.map((t) =>
          t.rkey === action.talkRkey ? { ...t, verified: false } : t,
        );
        break;
      }
      case "name_speaker": {
        speakerNames.set(action.speakerId, action.name);
        break;
      }
    }
  }

  return { talks, speakerNames };
}
