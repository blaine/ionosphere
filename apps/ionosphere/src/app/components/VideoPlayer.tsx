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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: any;

    async function setupHls() {
      const { default: Hls } = await import("hls.js");
      if (Hls.isSupported()) {
        hls = new Hls({ debug: false });
        hls.loadSource(playlistUrl);
        hls.attachMedia(video!);

        // Select AAC audio track before playback starts to avoid mid-play rebuffer.
        // Streamplace serves both original + AAC renditions — switching after
        // playback begins causes a visible stall.
        //
        // Strategy: wait for MANIFEST_PARSED, then select the audio track
        // before any playback begins. Only auto-play after the track is set
        // and the first fragment is buffered — this avoids the reload cycle
        // caused by switching tracks mid-stream.
        let audioSettled = false;
        let seekSettled = offsetS <= 0; // no seek needed if no offset
        let hasAutoPlayed = false;

        const tryAutoPlay = () => {
          if (!hasAutoPlayed && video!.paused && audioSettled && seekSettled) {
            hasAutoPlayed = true;
            video!.play().catch(() => {});
          }
        };

        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
          if (audioSettled) return; // only run once
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
          setTimeout(() => {
            if (!audioSettled) {
              audioSettled = true;
              tryAutoPlay();
            }
          }, 200);

          // Seek to offset before playback starts
          if (offsetS > 0) {
            video!.currentTime = offsetS;
            // Wait for seek to complete before allowing auto-play
            video!.addEventListener("seeked", () => {
              seekSettled = true;
              tryAutoPlay();
            }, { once: true });
          }
        });

        // Auto-play once audio is settled, seek is done, and we have buffered data
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          tryAutoPlay();
        });

        // Error recovery — conservative approach to avoid reload cycles.
        // Only recover from fatal errors; non-fatal errors are handled by HLS.js internally.
        hls.on(Hls.Events.ERROR, (_: any, data: any) => {
          if (!data.fatal) return;

          console.warn("[HLS] Fatal error:", data.type, data.details);
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              // Network errors: retry loading
              hls!.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              // Media errors: single recovery attempt
              hls!.recoverMediaError();
              break;
            default:
              // Unrecoverable: destroy and give up
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
    return () => { if (hls) hls.destroy(); };
  }, [playlistUrl, offsetS]);

  // Broadcast current time and play/pause state
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTime = () => {
      setCurrentTimeNs((video.currentTime - offsetS) * 1e9);
    };
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);

    video.addEventListener("timeupdate", onTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
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
