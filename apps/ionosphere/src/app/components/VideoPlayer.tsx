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
        let audioSettled = false;
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
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
        });

        // Auto-play once audio track is settled and first fragment is buffered
        let hasAutoPlayed = false;
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          if (!hasAutoPlayed && video!.paused && audioSettled) {
            hasAutoPlayed = true;
            video!.play().catch(() => {});
          }
        });

        // Fallback: if audio tracks never fire (single track), play after manifest
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // Give AUDIO_TRACKS_UPDATED a chance to fire first
          setTimeout(() => { audioSettled = true; }, 100);
        });

        // Error recovery with logging
        let mediaErrorRecoveries = 0;
        hls.on(Hls.Events.ERROR, (_: any, data: any) => {
          console.warn("[HLS]", data.type, data.details, data.fatal ? "FATAL" : "");
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            if (mediaErrorRecoveries < 5) {
              mediaErrorRecoveries++;
              hls!.recoverMediaError();
              return;
            }
            const tracks = hls!.audioTracks;
            if (tracks.length > 1) {
              const next = (hls!.audioTrack + 1) % tracks.length;
              console.warn("[HLS] Swapping to audio track", next);
              hls!.audioTrack = next;
              mediaErrorRecoveries = 0;
              return;
            }
          }
          if (data.fatal) {
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
          }
        });

        // Seek to offset once media is loaded
        if (offsetS > 0) {
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video!.currentTime = offsetS;
          });
        }
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
    <video ref={videoRef} controls className="w-full h-full object-contain rounded-lg bg-black" />
  );
}
