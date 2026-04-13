"use client";

import { useRef, useEffect, useState, useCallback } from "react";

interface Highlight {
  rank: number;
  talkRkey: string;
  talkTitle: string;
  speakers: string;
  videoUri: string;
  videoOffsetNs: number;
  clipStartMs: number;
  clipEndMs: number;
  clipDurationMs: number;
  peakOffsetMs: number;
  score: number;
  mentionCount: number;
  topMention: {
    text: string;
    authorHandle: string;
    authorDisplayName: string;
    authorAvatarUrl: string;
    likes: number;
  };
  transcriptSnippet: string;
}

interface Props {
  highlights: Highlight[];
}

const VOD_ENDPOINT =
  "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";

export default function HighlightsContent({ highlights }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<any>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showMention, setShowMention] = useState(false);
  const [ended, setEnded] = useState(false);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mentionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = highlights[currentIndex] ?? null;

  // Compute seek targets for the current highlight
  const getClipStart = useCallback(
    (h: Highlight) => h.videoOffsetNs / 1e9 + h.clipStartMs / 1000,
    []
  );
  const getClipEnd = useCallback(
    (h: Highlight) => h.videoOffsetNs / 1e9 + h.clipEndMs / 1000,
    []
  );

  // Load and play a highlight by index
  const loadHighlight = useCallback(
    (index: number) => {
      const h = highlights[index];
      if (!h) return;

      setCurrentIndex(index);
      setShowMention(false);
      setEnded(false);
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
      if (mentionTimerRef.current) clearTimeout(mentionTimerRef.current);

      const video = videoRef.current;
      if (!video) return;

      const playlistUrl = `${VOD_ENDPOINT}?uri=${encodeURIComponent(h.videoUri)}`;
      const seekTo = getClipStart(h);

      // Destroy old HLS instance
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      import("hls.js").then(({ default: Hls }) => {
        if (Hls.isSupported()) {
          const hls = new Hls({ debug: false });
          hlsRef.current = hls;
          hls.loadSource(playlistUrl);
          hls.attachMedia(video);

          // Select AAC audio track before playback
          let audioSettled = false;
          hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
            const tracks = hls.audioTracks;
            if (tracks.length > 1) {
              const aacTrack = tracks.findIndex(
                (t: any) => t.name?.includes("bafk") || t.url?.includes("bafk")
              );
              if (aacTrack >= 0 && hls.audioTrack !== aacTrack) {
                hls.audioTrack = aacTrack;
              }
            }
            audioSettled = true;
          });

          let hasAutoPlayed = false;
          hls.on(Hls.Events.FRAG_BUFFERED, () => {
            if (!hasAutoPlayed && video.paused && audioSettled) {
              hasAutoPlayed = true;
              video.play().catch(() => {});
            }
          });

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.currentTime = seekTo;
            setTimeout(() => {
              audioSettled = true;
            }, 100);
          });

          // Error recovery
          let mediaErrorRecoveries = 0;
          hls.on(Hls.Events.ERROR, (_: any, data: any) => {
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              if (mediaErrorRecoveries < 5) {
                mediaErrorRecoveries++;
                hls.recoverMediaError();
                return;
              }
            }
            if (data.fatal) {
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  hls.startLoad();
                  break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                  hls.recoverMediaError();
                  break;
                default:
                  hls.destroy();
                  break;
              }
            }
          });
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = playlistUrl;
          video.addEventListener(
            "loadedmetadata",
            () => {
              video.currentTime = seekTo;
              video.play().catch(() => {});
            },
            { once: true }
          );
        }
      });

      // Show mention after 2 seconds
      mentionTimerRef.current = setTimeout(() => {
        setShowMention(true);
      }, 2000);
    },
    [highlights, getClipStart]
  );

  // Monitor timeupdate for auto-advance
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !current) return;

    const clipEnd = getClipEnd(current);

    const onTimeUpdate = () => {
      if (video.currentTime >= clipEnd) {
        video.pause();
        if (currentIndex < highlights.length - 1) {
          advanceTimerRef.current = setTimeout(() => {
            loadHighlight(currentIndex + 1);
          }, 1000);
        } else {
          setEnded(true);
        }
      }
    };

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [current, currentIndex, highlights.length, getClipEnd, loadHighlight]);

  // Load first highlight on mount
  useEffect(() => {
    if (highlights.length > 0) {
      loadHighlight(0);
    }
    return () => {
      if (hlsRef.current) hlsRef.current.destroy();
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
      if (mentionTimerRef.current) clearTimeout(mentionTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll active card into view in the strip
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const activeCard = strip.querySelector("[data-active='true']");
    if (activeCard) {
      activeCard.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [currentIndex]);

  const handlePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const handleSkipBack = () => {
    if (currentIndex > 0) loadHighlight(currentIndex - 1);
  };

  const handleSkipForward = () => {
    if (currentIndex < highlights.length - 1) loadHighlight(currentIndex + 1);
  };

  if (highlights.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500">
        <p>No highlights available yet. Check back soon!</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-neutral-950">
      <div className="mx-auto max-w-[900px] px-4 py-6">
        {/* Video player */}
        <div className="relative rounded-xl overflow-hidden bg-black">
          <video
            ref={videoRef}
            className="w-full aspect-video object-contain bg-black"
          />
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-4 mt-4">
          <button
            onClick={handleSkipBack}
            disabled={currentIndex === 0}
            className="w-10 h-10 rounded-full bg-neutral-900 flex items-center justify-center text-neutral-300 hover:text-neutral-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Previous highlight"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3 2h2v12H3V2zm10 0L6 8l7 6V2z" />
            </svg>
          </button>
          <button
            onClick={handlePlayPause}
            className="w-12 h-12 rounded-full bg-neutral-800 flex items-center justify-center text-neutral-100 hover:bg-neutral-700 transition-colors"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
                <rect x="4" y="2" width="4" height="14" rx="1" />
                <rect x="10" y="2" width="4" height="14" rx="1" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
                <path d="M4 2l12 7-12 7V2z" />
              </svg>
            )}
          </button>
          <button
            onClick={handleSkipForward}
            disabled={currentIndex >= highlights.length - 1}
            className="w-10 h-10 rounded-full bg-neutral-900 flex items-center justify-center text-neutral-300 hover:text-neutral-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Next highlight"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11 2h2v12h-2V2zM3 2l7 6-7 6V2z" />
            </svg>
          </button>
        </div>

        {/* Current highlight info */}
        {current && (
          <div className="mt-5 rounded-xl bg-neutral-900 p-5">
            <h2 className="text-lg font-semibold text-neutral-100">
              {current.talkTitle}
            </h2>
            <p className="text-sm text-neutral-400 mt-1">
              by {current.speakers}
            </p>

            {/* Social mention */}
            {current.topMention && (
              <div
                className={`mt-4 transition-opacity duration-500 ${
                  showMention ? "opacity-100" : "opacity-0"
                }`}
              >
                <div className="flex items-start gap-3">
                  {current.topMention.authorAvatarUrl && (
                    <img
                      src={current.topMention.authorAvatarUrl}
                      alt=""
                      className="w-8 h-8 rounded-full shrink-0"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-blue-400">
                        @{current.topMention.authorHandle}
                      </span>
                      <span className="text-neutral-600">
                        {current.topMention.likes} &#9825;
                      </span>
                    </div>
                    <p className="text-sm text-neutral-300 mt-1 leading-relaxed">
                      &ldquo;{current.topMention.text}&rdquo;
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Transcript snippet */}
            {current.transcriptSnippet && (
              <p className="mt-4 text-sm text-neutral-500 italic leading-relaxed">
                {current.transcriptSnippet}
              </p>
            )}

            <div className="mt-4 flex items-center justify-between text-xs text-neutral-600">
              <span>
                Highlight {currentIndex + 1} of {highlights.length}
              </span>
              <span>
                {current.mentionCount} mention{current.mentionCount !== 1 ? "s" : ""}
              </span>
            </div>
          </div>
        )}

        {/* Highlight strip */}
        <div className="mt-5">
          <div
            ref={stripRef}
            className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin"
          >
            {highlights.map((h, i) => (
              <button
                key={h.rank}
                data-active={i === currentIndex}
                onClick={() => loadHighlight(i)}
                className={`shrink-0 w-48 rounded-lg p-3 text-left transition-colors ${
                  i === currentIndex
                    ? "bg-neutral-800 border-2 border-blue-500"
                    : "bg-neutral-900 border-2 border-transparent hover:border-neutral-700"
                }`}
              >
                <p className="text-sm font-medium text-neutral-200 truncate">
                  {h.talkTitle}
                </p>
                <p className="text-xs text-neutral-500 mt-1 truncate">
                  {h.speakers}
                </p>
                <div className="flex items-center gap-2 mt-2 text-xs text-neutral-600">
                  <span>#{h.rank}</span>
                  <span>{h.mentionCount} mentions</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {ended && (
          <div className="mt-6 text-center text-neutral-500 text-sm">
            That&apos;s all the highlights!
            <button
              onClick={() => loadHighlight(0)}
              className="ml-2 text-blue-400 hover:text-blue-300"
            >
              Watch again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
