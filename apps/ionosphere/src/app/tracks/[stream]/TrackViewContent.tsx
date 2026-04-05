"use client";

import { TimestampProvider, useTimestamp } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import StreamTimeline from "@/app/components/StreamTimeline";
import DiarizationBand from "@/app/components/DiarizationBand";

interface Talk {
  rkey: string;
  title: string;
  speakers: string[];
  startSeconds: number;
  endSeconds: number | null;
  confidence: string;
}

interface TrackData {
  slug: string;
  name: string;
  room: string;
  dayLabel: string;
  streamUri: string;
  durationSeconds: number;
  playbackUrl: string;
  talks: Talk[];
  diarization: Array<{ start: number; end: number; speaker: string }>;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function TalkList({ talks }: { talks: Talk[] }) {
  const { seekTo, currentTimeNs } = useTimestamp();
  const currentTimeSec = currentTimeNs / 1e9;

  return (
    <div className="space-y-1">
      {talks.map((talk, i) => {
        const isActive =
          currentTimeSec >= talk.startSeconds &&
          (talk.endSeconds ? currentTimeSec < talk.endSeconds : i === talks.length - 1);

        return (
          <button
            key={`${talk.rkey}-${i}`}
            onClick={() => seekTo(talk.startSeconds * 1e9)}
            className={`w-full text-left px-3 py-2 rounded transition-colors flex items-baseline gap-3 ${
              isActive
                ? "bg-neutral-800 text-neutral-100"
                : "hover:bg-neutral-800/50 text-neutral-400"
            }`}
          >
            <span className="text-xs font-mono shrink-0 w-16 text-neutral-500">
              {formatTime(talk.startSeconds)}
            </span>
            <span className="text-sm flex-1 truncate">{talk.title}</span>
            <span className="text-xs text-neutral-600 shrink-0">
              {talk.speakers.join(", ")}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function TrackViewInner({ track }: { track: TrackData }) {
  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="mb-4">
        <h1 className="text-xl font-bold">{track.name}</h1>
        <p className="text-sm text-neutral-500">
          {track.room} · {track.talks.length} talks · {formatTime(track.durationSeconds)}
        </p>
      </div>

      <div className="mb-4">
        <VideoPlayer videoUri={track.streamUri} />
      </div>

      <div className="mb-2">
        <StreamTimeline
          talks={track.talks}
          durationSeconds={track.durationSeconds}
        />
      </div>

      {track.diarization.length > 0 && (
        <div className="mb-6">
          <DiarizationBand
            segments={track.diarization}
            durationSeconds={track.durationSeconds}
          />
        </div>
      )}

      <div>
        <h2 className="text-sm font-semibold text-neutral-400 mb-2 uppercase tracking-wider">
          Talks
        </h2>
        <TalkList talks={track.talks} />
      </div>
    </div>
  );
}

export default function TrackViewContent({ track }: { track: TrackData }) {
  return (
    <TimestampProvider>
      <TrackViewInner track={track} />
    </TimestampProvider>
  );
}
