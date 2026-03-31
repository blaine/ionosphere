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
  const { setCurrentTimeNs, onSeek } = useTimestamp();
  const offsetS = offsetNs / 1e9;
  const playlistUrl = `${VOD_ENDPOINT}?uri=${encodeURIComponent(videoUri)}`;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: any;

    async function setupHls() {
      const { default: Hls } = await import("hls.js");
      if (Hls.isSupported()) {
        hls = new Hls();
        hls.loadSource(playlistUrl);
        hls.attachMedia(video!);

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

  // Broadcast current time to timestamp context, adjusted for offset
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handler = () => {
      // The transcript timestamps are relative to the talk start,
      // but the video time includes the offset. Subtract offset
      // so transcript sync aligns correctly.
      setCurrentTimeNs((video.currentTime - offsetS) * 1e9);
    };
    video.addEventListener("timeupdate", handler);
    return () => video.removeEventListener("timeupdate", handler);
  }, [setCurrentTimeNs, offsetS]);

  // Listen for seek requests from transcript clicks, adjusted for offset
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    return onSeek((ns: number) => {
      video.currentTime = ns / 1e9 + offsetS;
    });
  }, [onSeek, offsetS]);

  return (
    <video ref={videoRef} controls className="w-full rounded-lg bg-black aspect-video" />
  );
}
