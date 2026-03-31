export interface ScheduleEvent {
  uri: string;
  name: string;
  startsAt: string;
  endsAt: string;
  type: string;
  room: string;
  category: string;
  speakers: Array<{ id: string; name: string }>;
  description: string;
}

export interface VodRecord {
  uri: string;
  title: string;
  creator: string;
  duration: number;
  createdAt: string;
}

export interface Match {
  schedule: ScheduleEvent;
  vod: VodRecord;
  confidence: number;
}

const NOISE_TITLES = new Set([
  "lunch", "lunch break", "break", "doors open", "starting soon",
  "join us tomorrow", "lunch day", "breakfast", "coffee break",
  "irl only", "no stream",
]);

function isNoise(title: string): boolean {
  const lower = title.toLowerCase().trim();
  if (NOISE_TITLES.has(lower)) return true;
  if (lower.startsWith("lunch")) return true;
  if (lower.startsWith("doors open")) return true;
  if (lower.startsWith("atmosphereconf starting")) return true;
  if (lower.startsWith("atmoshereconf starting")) return true;
  if (lower.startsWith("join us")) return true;
  if (lower.startsWith("please join")) return true;
  if (lower.startsWith("follow @")) return true;
  if (lower.includes("starting soon")) return true;
  return false;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wordsA = new Set(na.split(" "));
  const wordsB = new Set(nb.split(" "));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}

export function correlate(schedule: ScheduleEvent[], vods: VodRecord[]): Match[] {
  const matches: Match[] = [];
  const usedVods = new Set<string>();
  const realVods = vods.filter((v) => !isNoise(v.title));

  for (const event of schedule) {
    let bestMatch: VodRecord | null = null;
    let bestScore = 0;

    for (const vod of realVods) {
      if (usedVods.has(vod.uri)) continue;
      const score = titleSimilarity(event.name, vod.title);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = vod;
      }
    }

    if (bestMatch && bestScore >= 0.5) {
      matches.push({ schedule: event, vod: bestMatch, confidence: bestScore });
      usedVods.add(bestMatch.uri);
    }
  }

  return matches.sort((a, b) =>
    new Date(a.schedule.startsAt).getTime() - new Date(b.schedule.startsAt).getTime()
  );
}
