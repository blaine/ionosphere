import { describe, it, expect } from "vitest";
import { buildPlaylistUrl } from "./extract-audio.js";

describe("extract-audio", () => {
  it("builds correct playlist URL from video URI", () => {
    const uri = "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3mi5stzyxji2e";
    const url = buildPlaylistUrl(uri);
    expect(url).toBe(
      "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist?uri=at%3A%2F%2Fdid%3Aplc%3Arbvrr34edl5ddpuwcubjiost%2Fplace.stream.video%2F3mi5stzyxji2e"
    );
  });
});
