"use client";

import { useRef, useEffect } from "react";

interface VideoPlayerProps {
  videoUri: string;
  onTimeUpdate?: (timeNs: number) => void;
}

const VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";

export default function VideoPlayer({ videoUri, onTimeUpdate }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !onTimeUpdate) return;

    const handler = () => { onTimeUpdate(video.currentTime * 1e9); };
    video.addEventListener("timeupdate", handler);
    return () => video.removeEventListener("timeupdate", handler);
  }, [onTimeUpdate]);

  return (
    <video ref={videoRef} controls className="w-full rounded-lg bg-black aspect-video" />
  );
}
