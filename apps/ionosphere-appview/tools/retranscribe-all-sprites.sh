#!/bin/bash
# Re-transcribe all 7 full-day streams on sprites in parallel.
#
# Usage: OPENAI_API_KEY=... ./retranscribe-all-sprites.sh
#
# Each sprite gets the transcription script + openai package,
# then runs transcription in the background. Monitor with:
#   sprite use <name> && sprite exec -- tail -f /root/work/transcribe.log

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/transcribe-sprite.mjs"

if [ -z "$OPENAI_API_KEY" ]; then
  echo "OPENAI_API_KEY not set"
  exit 1
fi

# Stream configs: sprite-name | stream-uri | stream-label
STREAMS=(
  "iono-great-hall-day1|at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadw52j22|Great Hall - Day 1"
  "iono-great-hall-day2|at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miighlz53o22|Great Hall - Day 2"
  "iono-room-2301-day1|at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadx2dj22|Room 2301 - Day 1"
  "iono-room-2301-day2|at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadxeqn22|Room 2301 - Day 2"
  "iono-perf-theater-day1|at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwgvz22|Performance Theater - Day 1"
  "iono-perf-theater-day2|at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwqgy22|Performance Theater - Day 2"
  "iono-atscience|at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadvruo22|ATScience - Full Day"
)

setup_sprite() {
  local sprite_name="$1"
  echo "[$sprite_name] Setting up..."
  sprite use "$sprite_name"

  # Create work directory and install openai
  sprite exec -- sh -c "mkdir -p /root/work && cd /root/work && npm init -y 2>/dev/null && npm install openai 2>&1 | tail -1"

  # Upload the transcription script
  cat "$SCRIPT" | sprite exec -- sh -c "cat > /root/work/transcribe-sprite.mjs"

  echo "[$sprite_name] Setup done"
}

launch_sprite() {
  local sprite_name="$1"
  local stream_uri="$2"
  local stream_name="$3"

  sprite use "$sprite_name"

  # Clear old chunks so we re-extract from updated VODs
  sprite exec -- sh -c "rm -rf /root/work/chunks /root/work/transcript.json"

  # Launch transcription in background
  sprite exec -- sh -c "cd /root/work && OPENAI_API_KEY='$OPENAI_API_KEY' nohup node transcribe-sprite.mjs '$stream_uri' '$stream_name' > transcribe.log 2>&1 &"

  echo "[$sprite_name] Launched: $stream_name"
}

echo "=== Setting up sprites ==="
for entry in "${STREAMS[@]}"; do
  IFS='|' read -r sprite_name stream_uri stream_name <<< "$entry"
  setup_sprite "$sprite_name"
done

echo ""
echo "=== Launching transcriptions ==="
for entry in "${STREAMS[@]}"; do
  IFS='|' read -r sprite_name stream_uri stream_name <<< "$entry"
  launch_sprite "$sprite_name" "$stream_uri" "$stream_name"
done

echo ""
echo "=== All 7 transcriptions launched ==="
echo ""
echo "Monitor progress:"
echo "  sprite use <name> && sprite exec -- tail -f /root/work/transcribe.log"
echo ""
echo "Check completion:"
echo "  for s in iono-great-hall-day1 iono-great-hall-day2 iono-room-2301-day1 iono-room-2301-day2 iono-perf-theater-day1 iono-perf-theater-day2 iono-atscience; do"
echo "    sprite use \$s && echo -n \"\$s: \" && sprite exec -- sh -c 'tail -1 /root/work/transcribe.log 2>/dev/null || echo running'"
echo "  done"
echo ""
echo "Pull results:"
echo "  sprite use <name> && sprite exec -- cat /root/work/transcript.json > transcript-<name>.json"
