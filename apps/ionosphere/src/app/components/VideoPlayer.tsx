"use client";

import { useRef, useEffect } from "react";
import { useTimestamp } from "./TimestampProvider";

interface VideoPlayerProps {
  videoUri: string;
  offsetNs?: number; // start offset in nanoseconds (for talks inside room-length recordings)
}

const VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";

export default function VideoPlayer({ videoUri, offsetNs = 0 }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { setCurrentTimeNs, setPaused, onSeek } = useTimestamp();
  const offsetS = offsetNs / 1e9;
  const playlistUrl = `${VOD_ENDPOINT}?uri=${encodeURIComponent(videoUri)}`;

  // Ref-based auto-play guard survives React Strict Mode double-invocation.
  // A closure variable would get a fresh copy per effect invocation, allowing
  // a stale setTimeout from the first invocation to call play() with its own
  // hasAutoPlayed=false even after the second invocation already auto-played.
  const hasAutoPlayedRef = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: any;
    let manifestTimeoutId: ReturnType<typeof setTimeout> | null = null;

    async function setupHls() {
      const { default: Hls } = await import("hls.js");
      if (Hls.isSupported()) {
        hls = new Hls({ debug: false });
        hls.loadSource(playlistUrl);
        hls.attachMedia(video!);

        let audioSettled = false;
        let seekSettled = offsetS <= 0;

        const tryAutoPlay = () => {
          if (!hasAutoPlayedRef.current && video!.paused && audioSettled && seekSettled) {
            hasAutoPlayedRef.current = true;
            video!.play().catch(() => {});
          }
        };

        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
          if (audioSettled) return;
          const tracks = hls!.audioTracks;
          if (tracks.length > 1) {
            const aacTrack = tracks.findIndex((t: any) =>
              t.name?.includes("bafk") || t.url?.includes("bafk")
            );
            if (aacTrack >= 0 && hls!.audioTrack !== aacTrack) {
              hls!.audioTrack = aacTrack;
            }
          }
          audioSettled = true;
          tryAutoPlay();
        });

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // If no audio tracks event fires within 200ms, consider audio settled
          manifestTimeoutId = setTimeout(() => {
            if (!audioSettled) {
              audioSettled = true;
              tryAutoPlay();
            }
          }, 200);

          // Seek to offset before playback starts
          if (offsetS > 0) {
            video!.currentTime = offsetS;
            video!.addEventListener("seeked", () => {
              seekSettled = true;
              tryAutoPlay();
            }, { once: true });
          }
        });

        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          if (!hasAutoPlayedRef.current) tryAutoPlay();
        });

        hls.on(Hls.Events.ERROR, (_: any, data: any) => {
          if (!data.fatal) return;
          console.warn("[HLS] Fatal error:", data.type, data.details);
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls!.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls!.recoverMediaError();
              break;
            default:
              hls!.destroy();
              break;
          }
        });
      } else if (video!.canPlayType("application/vnd.apple.mpegurl")) {
        video!.src = playlistUrl;
        if (offsetS > 0) {
          video!.addEventListener("loadedmetadata", () => {
            video!.currentTime = offsetS;
          }, { once: true });
        }
      }
    }

    setupHls();
    return () => {
      if (manifestTimeoutId !== null) clearTimeout(manifestTimeoutId);
      if (hls) hls.destroy();
    };
  }, [playlistUrl, offsetS]);

  // Broadcast current time at 60fps via RAF (instead of ~4Hz timeupdate).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let rafId = 0;
    let isPlaying = false;

    const pollTime = () => {
      setCurrentTimeNs((video.currentTime - offsetS) * 1e9);
      if (isPlaying) rafId = requestAnimationFrame(pollTime);
    };

    const onPlay = () => {
      isPlaying = true;
      setPaused(false);
      rafId = requestAnimationFrame(pollTime);
    };
    const onPause = () => {
      isPlaying = false;
      setPaused(true);
      cancelAnimationFrame(rafId);
      setCurrentTimeNs((video.currentTime - offsetS) * 1e9);
    };
    const onSeeked = () => {
      setCurrentTimeNs((video.currentTime - offsetS) * 1e9);
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    return () => {
      cancelAnimationFrame(rafId);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
    };
  }, [setCurrentTimeNs, setPaused, offsetS]);

  // Listen for seek requests from transcript clicks, adjusted for offset
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    return onSeek((ns: number) => {
      video.currentTime = ns / 1e9 + offsetS;
    });
  }, [onSeek, offsetS]);

  return (
    <video ref={videoRef} controls className="max-w-full max-h-[33vh] object-contain rounded-lg bg-black" />
  );
}
