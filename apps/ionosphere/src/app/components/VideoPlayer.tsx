"use client";

import { useRef, useEffect } from "react";
import { useTimestamp } from "./TimestampProvider";

interface VideoPlayerProps {
  videoUri: string;
}

const VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";

export default function VideoPlayer({ videoUri }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { setCurrentTimeNs, onSeek } = useTimestamp();
  const playlistUrl = `${VOD_ENDPOINT}?uri=${encodeURIComponent(videoUri)}`;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: any;

    async function setupHls() {
      if (video!.canPlayType("application/vnd.apple.mpegurl")) {
        video!.src = playlistUrl;
      } else {
        const { default: Hls } = await import("hls.js");
        if (Hls.isSupported()) {
          hls = new Hls();
          hls.loadSource(playlistUrl);
          hls.attachMedia(video!);
        }
      }
    }

    setupHls();
    return () => { if (hls) hls.destroy(); };
  }, [playlistUrl]);

  // Broadcast current time to timestamp context
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handler = () => { setCurrentTimeNs(video.currentTime * 1e9); };
    video.addEventListener("timeupdate", handler);
    return () => video.removeEventListener("timeupdate", handler);
  }, [setCurrentTimeNs]);

  // Listen for seek requests from transcript clicks
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    return onSeek((ns: number) => {
      video.currentTime = ns / 1e9;
    });
  }, [onSeek]);

  return (
    <video ref={videoRef} controls className="w-full rounded-lg bg-black aspect-video" />
  );
}
