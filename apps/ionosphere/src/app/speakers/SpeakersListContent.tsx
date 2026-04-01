"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { TimestampProvider, useTimestamp } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import TranscriptView from "@/app/components/TranscriptView";

/** Aggressively seeks and plays the video once HLS is ready. */
function InitialSeek({ timestampNs }: { timestampNs: number }) {
  const { seekTo } = useTimestamp();
  useEffect(() => {
    let cancelled = false;

    function trySeekAndPlay() {
      if (cancelled) return;
      const video = document.querySelector<HTMLVideoElement>("video");
      if (!video) {
        setTimeout(trySeekAndPlay, 100);
        return;
      }

      function doSeekAndPlay() {
        if (cancelled) return;
        if (timestampNs > 0) seekTo(timestampNs);
        video!.play().catch(() => {});
      }

      if (video.readyState >= 2) {
        doSeekAndPlay();
        return;
      }

      video.addEventListener("loadeddata", doSeekAndPlay, { once: true });
      video.addEventListener("canplay", doSeekAndPlay, { once: true });
      video.play().catch(() => {});
    }

    trySeekAndPlay();
    return () => { cancelled = true; };
  }, [timestampNs, seekTo]);
  return null;
}

interface Speaker {
  rkey: string;
  name: string;
  handle?: string;
}

interface Talk {
  rkey: string;
  title: string;
  speaker_names: string;
  starts_at: string;
}

interface SpeakerWithTalks {
  rkey: string;
  name: string;
  handle?: string;
  talks: Talk[];
}

interface LetterGroup {
  letter: string;
  speakers: SpeakerWithTalks[];
}

function groupByLetter(speakers: SpeakerWithTalks[]): LetterGroup[] {
  const map = new Map<string, SpeakerWithTalks[]>();
  for (const s of speakers) {
    const letter = s.name[0]?.toUpperCase() || "#";
    if (!map.has(letter)) map.set(letter, []);
    map.get(letter)!.push(s);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([letter, items]) => ({ letter, speakers: items }));
}

/** Match talks to speakers by checking if speaker name appears in talk's speaker_names field */
function buildSpeakersWithTalks(speakers: Speaker[], talks: Talk[]): SpeakerWithTalks[] {
  return speakers.map((speaker) => {
    const speakerTalks = talks.filter((talk) => {
      if (!talk.speaker_names) return false;
      // speaker_names is comma-separated; check if this speaker's name appears
      const names = talk.speaker_names.split(",").map((n) => n.trim().toLowerCase());
      return names.includes(speaker.name.toLowerCase());
    });
    return { ...speaker, talks: speakerTalks };
  });
}

export default function SpeakersListContent({
  speakers,
  talks,
}: {
  speakers: Speaker[];
  talks: Talk[];
}) {
  const [selectedTalk, setSelectedTalk] = useState<{
    rkey: string;
    title: string;
    videoUri: string;
    offsetNs: number;
    document: any;
    seekToNs: number;
  } | null>(null);

  const [filter, setFilter] = useState("");
  const [widePlayer, setWidePlayer] = useState(false);
  const [showMobilePlayer, setShowMobilePlayer] = useState(false);

  const speakersWithTalks = useMemo(
    () => buildSpeakersWithTalks(speakers, talks),
    [speakers, talks]
  );

  const sortedSpeakers = useMemo(
    () => [...speakersWithTalks].sort((a, b) => a.name.localeCompare(b.name)),
    [speakersWithTalks]
  );

  const filteredSpeakers = useMemo(() => {
    if (!filter) return sortedSpeakers;
    const q = filter.toLowerCase();
    return sortedSpeakers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.handle || "").toLowerCase().includes(q) ||
        s.talks.some((t) => t.title.toLowerCase().includes(q))
    );
  }, [sortedSpeakers, filter]);

  const allLetters = useMemo(() => {
    const set = new Set<string>();
    for (const s of sortedSpeakers) {
      const l = s.name[0]?.toUpperCase();
      if (l && /[A-Z]/.test(l)) set.add(l);
    }
    return [...set].sort();
  }, [sortedSpeakers]);

  const groups = useMemo(() => groupByLetter(filteredSpeakers), [filteredSpeakers]);

  const handleSelectTalk = useCallback(async (rkey: string) => {
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
      const talkRes = await fetch(`${API_BASE}/talks/${rkey}`);
      if (!talkRes.ok) return;
      const { talk } = await talkRes.json();
      const doc = talk.document ? JSON.parse(talk.document) : null;

      setSelectedTalk({
        rkey: talk.rkey,
        title: talk.title,
        videoUri: talk.video_uri,
        offsetNs: talk.video_offset_ns || 0,
        document: doc?.facets?.length > 0 ? doc : null,
        seekToNs: 0,
      });
      setShowMobilePlayer(true);
    } catch (err) {
      console.error("[Speakers] handleSelectTalk error:", err);
    }
  }, []);

  const scrollToLetter = useCallback((letter: string) => {
    const el = document.getElementById(`speaker-letter-${letter}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="h-full flex">
      {/* Letter nav */}
      <nav className="shrink-0 w-8 flex flex-col items-center justify-center gap-0 border-r border-neutral-800 py-1 hidden md:flex">
        {allLetters.map((letter) => (
          <button
            key={letter}
            onClick={() => scrollToLetter(letter)}
            className="text-[11px] leading-none text-neutral-500 hover:text-neutral-100 transition-colors w-6 h-6 flex items-center justify-center"
          >
            {letter}
          </button>
        ))}
      </nav>

      {/* Main: search + multi-column speaker list */}
      <div className={`flex-1 min-w-0 overflow-y-auto p-4 ${showMobilePlayer ? "hidden md:block" : ""}`}>
        {/* Sticky search bar */}
        <div className="flex items-center gap-3 mb-4 sticky top-0 z-10 bg-neutral-950 py-2 -mt-2">
          <div className="flex-1 max-w-sm">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, handle, or talk..."
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500"
            />
          </div>
          <span className="text-sm text-neutral-500 shrink-0">
            {filteredSpeakers.length} speakers
          </span>
        </div>

        <div style={{ columnWidth: "280px", columnGap: "1.5rem" }}>
          {groups.map((group) => (
            <div key={group.letter} className="break-inside-avoid mb-4">
              <h2
                id={`speaker-letter-${group.letter}`}
                className="text-base font-bold text-neutral-500 border-b border-neutral-800 pb-0.5 mb-1"
              >
                {group.letter}
              </h2>
              {group.speakers.map((speaker) => (
                <div
                  key={speaker.rkey}
                  className="text-[13px] leading-[1.6] mb-2"
                >
                  <div className="font-medium text-neutral-200">
                    {speaker.name}
                    {speaker.handle && (
                      <span className="text-neutral-600 font-normal ml-1.5">
                        @{speaker.handle}
                      </span>
                    )}
                  </div>
                  {speaker.talks.map((talk) => (
                    <div key={talk.rkey} className="pl-3 truncate text-neutral-500">
                      <button
                        onClick={() => handleSelectTalk(talk.rkey)}
                        className="hover:text-neutral-100 hover:underline underline-offset-2 transition-colors text-left"
                      >
                        {talk.title}
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Right: player panel */}
      <div className={
        !selectedTalk
          ? "hidden"
          : showMobilePlayer
            ? `flex w-full ${widePlayer ? "md:w-2/3" : "md:w-[400px]"} shrink-0 md:border-l border-neutral-800 flex-col transition-all`
            : `hidden md:flex ${widePlayer ? "md:w-2/3" : "md:w-[400px]"} shrink-0 border-l border-neutral-800 flex-col transition-all`
      }>
        {selectedTalk ? (
          <TimestampProvider key={selectedTalk.rkey + selectedTalk.seekToNs}>
            <InitialSeek timestampNs={selectedTalk.seekToNs} />
            <div className="p-3 border-b border-neutral-800 text-sm font-medium flex items-center gap-2">
              <button
                onClick={() => { setShowMobilePlayer(false); setSelectedTalk(null); }}
                className="md:hidden text-neutral-400 hover:text-neutral-200 transition-colors shrink-0 text-sm"
              >
                &larr; Back to list
              </button>
              <button
                onClick={() => setWidePlayer(!widePlayer)}
                className="text-neutral-500 hover:text-neutral-200 transition-colors shrink-0 hidden md:block"
                title={widePlayer ? "Collapse player" : "Expand player"}
              >
                {widePlayer ? "\u2192" : "\u2190"}
              </button>
              <span className="truncate">{selectedTalk.title}</span>
            </div>
            <div className="shrink-0 bg-black overflow-hidden">
              <VideoPlayer
                videoUri={selectedTalk.videoUri}
                offsetNs={selectedTalk.offsetNs}
              />
            </div>
            {selectedTalk.document && (
              <div className="flex-1 min-h-0">
                <TranscriptView document={selectedTalk.document} />
              </div>
            )}
          </TimestampProvider>
        ) : (
          <div className="flex-1 flex items-center justify-center text-neutral-600 text-sm p-6 text-center">
            Click a talk to play it
          </div>
        )}
      </div>
    </div>
  );
}
