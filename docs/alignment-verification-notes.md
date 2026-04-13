# Talk Alignment Verification Notes

Notes collected during manual verification of all 7 tracks.
Goal: inform design of a better automated alignment system.

## Observations

### Patterns in Misalignment
1. **Wrong-room assignments**: Boundary detection matched concurrent talks from other rooms to the same time slots. PT D1 had 6 wrong-room talks. Caused by schedule-based room+day matching.
2. **Hallucination zone boundaries**: Talks whose boundaries fall inside hallucination zones get wrong timestamps. The detector finds "gaps" between hallucination loops and treats them as talk boundaries.
3. **Round-number defaults**: Keynote end at exactly 1:00:00 was a default, not a real boundary.
4. **Panel boundary confusion**: Panel sessions (PT D1 media track, GH D2 design panel) don't have clear per-talk boundaries — speakers rotate within continuous discussions.
5. **Lightning talk compression**: Multiple lightning talks get the same timestamp when detection can't resolve the short gaps between them.
6. **Missing end times**: Last talk on every stream has endOffsetNs=0.
7. **Duplicate start times**: 5B02jaM and QKNkKMX both at 5:00:33 on R2301 D2 — detection couldn't split them.

### Whisper Hallucination Signatures
- "Transcription Outsourcing LLC" — repeating during silence (GH D2 lunch)
- "Transcribed by https://otter ai" — repeating during silence (GH D2, PT D2)
- "Thank you for watching" — repeating during late-day breaks (GH D2)
- Welsh text "Rwy n gobeithio eich bod chi n gweithio n fawr iawn" — repeating loops (ATScience lunch)
- Song lyrics from DJ music — transcribed as speech (GH D2: "give it away now", "I lose my mind", "candy she's sweet like candy")
- "www fema gov", "Subs by www zeoranger co uk" — hallucination markers (R2301 D2)
- Key pattern: repeating phrases in ~30s loops with gaps between them
- Hallucinations often get assigned to a real speaker ID by diarization

### Boundary Detection Signals That Work
- Self-introductions: "My name is X", "I'm X from Y" — very reliable talk start marker
- MC handoffs: "Please welcome X", "Next up is X", "Let's give a round of applause"
- "Thank you" followed by gap — reliable talk end
- Speaker ID changes with gap — strong signal when combined with content change
- Explicit topic statements: "I'm going to talk about X", "Today's talk is about X"
- **Diarization data** — tracks AUDIO not Whisper, so it shows real speech patterns even through hallucination zones. A 94-minute silence gap in diarization at PT D2 116-210m confirmed the exact break location that Whisper completely filled with hallucinations. Diarization speaker changes also confirm talk boundaries.

### Boundary Detection Signals That Fail
- Round-number timestamps (exactly 1:00:00) — likely defaults, not real boundaries
- Gaps during hallucination zones — Whisper creates artificial gaps between hallucination loops
- Panel sessions — no clear boundary between speakers in the same panel
- Schedule-based room+day matching — talks from wrong rooms get assigned (GH D2: PdNOkAP, ob8N65V at wrong timestamps)
- Lunch break boundaries — hallucination content fills the gap, making it look like continuous speech

### Cross-Track Assignment Errors
- GH D2: PdNOkAP (Rewilding) — not on this stream at all ("rewilding" never appears in transcript)
- GH D2: ob8N65V placed at 372.4m shows Daniel Holmgren content, real talk is at 461.5m
- GH D2: aQJAWl9 placed at 374m shows Daniel Holmgren content, real talk is at 451.5m
- PT D1: 6 wrong-room talks (EkexvrN, LZ4oWrj, J9EgEdX, OD6Gd0A, dWGJ41y, eqVMWz0) — all from other rooms, assigned because of matching schedule times
- R2301 D1: q4qlVLY (Community privacy) assigned but content is Hypercerts
- Cause: schedule data had concurrent talks in multiple rooms, boundary detection matched by time not content

### Data Quality Issues
- Dual DID issue: every talk exists under 2 DIDs (did:plc:lkeq4oghyhnztbu4dxr3joff and did:plc:dzqydlr5liucjrw3g43cccng). API deduplicates via GROUP BY rkey but DB is messy. The two DIDs sometimes have DIFFERENT video_segments values.
- Missing endOffsetNs on last talk of most tracks
- Some talks have endOffsetNs = 0 instead of null (shows as negative duration)
- "extrapolated" confidence talks are often wrong (timestamps past stream end)
- Zero-duration talks (startTimestamp == endTimestamp) on PT D2

## Per-Track Findings

### ATScience (Friday)

**Corrections needed:**
1. Talk 2 (ats26-keynote): End 3600s → 4242s (Q&A runs until 70.7m, "That's all we've got time for")
2. Talk 3 (ats26-semble): Start 3678s → 4266s (actual intro at 71.1m, "heard about Semble already")
3. Talk 3 end / Talk 4 start: Semble end → 5487s, Lea start stays 5487s (removes 23s overlap)
4. Talk 10 (ats26-astrosky): Welsh hallucination 264.5-280m, English emerges ~16800s. Keep start, note bad transcript.
5. Talk 18 (000NewDirections): Add end at 29664s (last word in stream)
6. Talk 19 (3mhzjk45462rg): REMOVE — timestamp 35991s is past stream end 29675s

**Observations:**
- Round-number boundaries (exactly 1:00:00) are likely defaults, not real boundaries
- Welsh hallucination: repeating "Rwy n gobeithio..." in 30s loops during silence
- Travis Simpson "SkySquare" demo played 3x due to AV issues — creates repeating intros that mimic hallucination patterns but are real speech
- 20min transcript gap at 180-200m makes talks 7-9 unverifiable from transcript alone
- Talks 7-9 boundary positions seem plausible from gap structure but can't confirm content match

### Great Hall Day 1 (Saturday)

**Status: Mostly clean — 3 fixes needed**

1. Talk 8/9 overlap (LZxV6dv→Y561Qv6): Consent Before Crypto end extends 42s into Expo panel intro. Fix: LZxV6dv end → ~15368s, Y561Qv6 start → ~15369s ("All right Welcome")
2. Talk 12/13 boundary (2EG4YMj→000Jer): Tori still talking at 21960s+, current Jer start 21870s is mid-Tori. Jeremy actually starts ~22070s ("I had the good fortune... Tim O Reilly"). Fix: 2EG4YMj end → ~22070s, 000Jer start → ~22070s
3. Talk 16 (rj8Xv62): Missing end. Last word at 28433s. Fix: set end to 28433s.

**Observations:**
- Lightning talk transitions are the hardest boundaries — short gaps, fast speaker swaps, AV setup noise
- All main session talks (1-10) had clear speaker intros that matched titles perfectly
- Speaker diarization IDs are consistent within the stream (SPEAKER_10 = Tori throughout)

### Great Hall Day 2 (Sunday)

**Status: Multiple issues — needs significant rework**

**Actual talk sequence verified from transcript:**
1. MeWBzWX (npmx) — 24m, OK ✓
2. VLgVWM6 (tangled) — 70m, OK ✓
3. gDPMMa1 (Graze) — 101m, OK ✓
4. ODqQQJA (Waiting for Future) — 129m, OK ✓
5. kdobWjj (Resonant Computing) — 165m, OK ✓
6. [LUNCH BREAK with "Transcription Outsourcing LLC" hallucination 181-197m, DJ music 220-254m]
7. 9q8ZX5Q (Social Components) — ~263m, start in hallucination zone, mid-talk content
8. GxEe0Vz (Designing for social web) — panel, ~310m
9. xXWE9Dv (Data Sovereignty Games) — part of same panel
10. rjQ96kl (Protocol Governance) — Daniel Holmgren at 372.4m, "My name is Daniel Holmgren" ✓
11. [BREAK with DJ music 427-436m, "Thank you for watching" hallucination]
12. 81gXlXP (Building Bridgy) — ~436m, "building Bridgy" ✓
13. aQJAWl9 (Affordances of the Atmosphere) — 451.5m, "Let's talk some design affordances" by Tyne ✓ (currently at 6:14:00=374m WRONG)
14. ob8N65V (How to use Bluesky to preview software) — 461.5m, "Please welcome Tim" ✓ (currently at 6:12:24=372.4m WRONG — shows Daniel Holmgren content)
15. RG6Nepp (Podcasts) — 473.1m, "Hi I'm Roscoe I'm 16" ✓

**Corrections needed:**
1. ob8N65V: Move from 22344s to ~27690s (461.5m)
2. aQJAWl9: Move from 22440s to ~27090s (451.5m)
3. PdNOkAP (Rewilding): REMOVE — "rewilding" doesn't appear anywhere in stream transcript. Wrong-stream assignment.
4. rjQ96kl end: Currently 22320s (6:12:00). Daniel's talk continues well past this — need to find actual end.
5. 9q8ZX5Q start: Currently in hallucination zone after lunch. Start text is mid-talk. Likely OK but first ~seconds are in hallucination.
6. All NO END talks need end times.
7. End times for 81gXlXP: ~27090s (Affordances start). Currently 27300s — close but should match.

**Observations:**
- DJ music between talks creates song lyrics in transcript (RHCP "give it away", various pop songs)
- "Transcription Outsourcing LLC" is a recurring hallucination during lunch break silence
- "Transcribed by https://otter ai" appears at breaks
- "Thank you for watching" hallucination during late-day breaks
- Panel sessions (Designing for social web) have no clear talk-to-talk boundaries — it's one continuous conversation
- Talks at end of day were ordered differently in the stream than in the schedule

### Room 2301 Day 1 (Saturday)

**Status: Several fixes needed, mostly in lightning talk section**

**Verified talk sequence:**
1. BzrpDQK (Feature/Product/Business) — 0m, "How are you" ✓
2. gDPLaGd (Lexicon enterprise) — 34m, "excellent thank you" ✓
3. 9qkWqPG (AI in Atmosphere) — 64m, "Hello everybody My name is Cameron" ✓
4. VLerG2y (Custom Feeds) — 100m, "hello everyone I'm a phd student" ✓
5. [BREAK: "0 0 0 0" hallucination 140-200m, then "AtmosphereConf 2026 Room 2301" hallucination]
6. XxP4RzL (Building Cirrus) — 200m (12000s), real speech resumes with "the whole point of a PDS". Current start 198.2m (11892s) is in hallucination zone. Fix: start → 12000s
7. MelQ8Ak (Rethinking Client) — 228m, "Hello I'm Tyler Fisher" ✓
8. gDP6A8N (Account logic TEE) — 259.5m, "Hi I'm Kobi" ✓
9. [BREAK: "Thank you" loops 289-301m, "Session concluded" at 301.5m, then more hallucination 346-350m]
10. 9qP16Kp (Stop Hallucinating) — 350.5m, "Welcome to the lightning talk section My name is Jessie" ✓
11. QKZoLBX (How decentralized) — 359.3m ✓
12. Xxd7xqj (E2EE DMs) — 372m, "I'm Ranga Krishnan with Solidarity Social" ✓
13. 7Rr2zW6 (Pollen) — 382.5m ✓
14. RGqppqd (How Streamplace Works) — 393.7m, "My name is Eli Mellon" ✓
15. J9EgEdX (Hypercerts) — 427.5m, "funding impact and resource allocation... Hypersense Foundation" ✓ (currently DUPLICATE at 350.5m — wrong!)
16. q4qlVLY (Community privacy) — NOT FOUND on this stream. Currently assigned at 427.5m with Hypercerts content.

**Corrections needed:**
1. XxP4RzL start: Move from 11892s to ~12000s (past hallucination)
2. J9EgEdX (Hypercerts): Move from 21031s (350.5m) to 25651s (427.5m). It's the LAST talk, not a lightning talk.
3. J9EgEdX end: Set to stream end ~27419s
4. q4qlVLY (Community privacy): REMOVE from this stream — not on this stream. May be on PT D2.
5. 9qP16Kp start: Verify — currently 21031s which is same as old J9EgEdX. Should be 350.5m (21030s) which actually matches.

**Observations:**
- "0 0 0 0 0" hallucination is a distinct pattern — numeric zeros in loops
- "AtmosphereConf 2026 Room 2301 Saturday" — Whisper hallucinates room/event metadata during silence
- "Session concluded We will be back in just a few moments" — interesting hallucination that mimics a real conference announcement
- Lightning talk section starts cleanly with MC intro ("Welcome to the lightning talk section")

### Room 2301 Day 2 (Sunday)

**Status: Major rework needed — massive hallucination zone destroys 100-208m**

**Actual talk sequence from transcript:**
1. 0.1m: Mej2N5X "Roomy" — "Hi I'm Meri... creators of Roomie... Melbourne Australia" ✓
2. 34.2m: "I will speak about how to have more non English speakers" — CONTENT is about non-English users, but currently mapped to Mej2N5X. Likely this IS WOkL11Q (talk order in schedule may be wrong or Mej2N5X extends into this)
3. 67.2m: WOkL11Q — "My name is Stan but call me Stan" ✓
4. ~96m: zxRkxk8 "Blousques" (ends before hallucination at 100m)
5. **100-208m: HALLUCINATION ZONE (108 minutes!)**
   - 100-120m: "Microsoft Office Word Document MSWordDoc Word Document 8" (new pattern!)
   - 121-125m: "Transcription by CastingWords"
   - 141m: "Thank you for watching" / "6 The vote is now closed"
   - 162m: "Transcription by CastingWords"
   - 183m: "Subs by www zeoranger co uk"
   - Talks 4-6 (Content Mod Futures, Blacksky, part of Skywatch) HAPPENED during this zone but transcript is garbage
6. 208.7m: 2E9XG1b "Blacksky" MID-TALK — "the work we do at Black Sky" (start lost in hallucination)
7. 239.7m: LZ4oWrj "Skywatch" — "Ms Julia the next presenter... two years of Skywatch" ✓
8. 271.4m: 0Qq9NlZ "Coop" — "Welcome to KOOP Open Source Trust and Safety" ✓
9. 304.8m: 000WebTiles "WebTiles" — "welcome to the impromptu slightly impromptu tiles talk" ✓
10. [BREAK + hallucination 333-350m]
11. 357.6m: 5B02jaM "Keywords vs Embeddings" — "keywords versus embeddings I can tell you already" ✓
12. 368.8m: QKNkKMX "Scaling the Atmosphere" — "I'm Jim I run the platform team at Blue Sky" ✓
13. 380.5m: xX5yRJr "Skylimit" — "project called SkyLimit" ✓
14. 391.1m: 000TLog "AT Transparency Logs" — "Hi I'm Filippo... transparency logs" ✓
15. 402.4m: ZjMOl7o "Matadata" — "talk about MataDisco... My name is actually Volker" ✓
16. ~418m: QKqWDrG "DID:PLC War Games" — "DID PLC... trusted sequencer" ✓ (SPEAKER_07 discussing blockchain/RPC)
17. 449.6m: "Thank you for closing out the conference with this particular talk" — stream end

**Corrections needed:**
1. Mej2N5X start: Currently 34.4m but Roomy intro is at 0.1m. Fix: start → 0s
2. Talks at 34m and 67m: Need to verify which is WOkL11Q vs a continuation of Mej2N5X
3. eqVMWz0 "Content Mod Futures" (currently 121m): In hallucination zone. Keep timestamp but note bad transcript.
4. 2E9XG1b "Blacksky" (currently 152m): In hallucination zone. Real content emerges at 208.7m (12522s).
5. LZ4oWrj "Skywatch": Move start to 239.7m (14382s)
6. 0Qq9NlZ "Coop": Move start to 271.4m (16284s)
7. 000WebTiles: Move start to 304.8m (18288s)
8. 5B02jaM "Keywords": Currently 5:00:33 (18033s) — move to 357.6m (21456s)
9. QKNkKMX "Scaling": Currently 5:00:33 (same as above!) — move to 368.8m (22128s)
10. xX5yRJr "Skylimit": Move to 380.5m (22830s)
11. 000TLog: Currently 5:33:44 with 0 duration — move to 391.1m (23466s), set proper end
12. ZjMOl7o "Matadata": Move to 402.4m (24144s)
13. QKqWDrG "War Games": Move to ~418m (25080s), end at ~449.6m (26976s)
14. All end times need recalculating based on next talk's start

**New hallucination pattern:**
- "Microsoft Office Word Document MSWordDoc Word Document 8" — repeating in 30s loops (100-120m)
- "6 The vote is now closed Thank you for watching" — mixed hallucination at 141m

**Observations:**
- 108-minute hallucination zone is the longest in any stream
- 3+ talks completely lost to hallucination (Content Mod Futures, start of Blacksky)
- First real speech after hallucination is MID-TALK (no intro visible)
- Lightning talks (357-420m) are correctly ordered but all have wrong timestamps
- The conference MC ("Thank you for closing out the conference") confirms DID:PLC War Games is the last talk

### Performance Theatre Day 1 (Saturday)

**Status: NEEDS FULL REBUILD — wrong-room talks throughout**

This was a curated **Media & Civics track** (MC: Chad Koholik, Protocols for Publishers).

**Actual talk sequence from transcript:**
1. 0m: Chad Koholik MC intro — "media and civics track"
2. ~2m: Panel 1 — Justin Bank (Independent Journalism Atlas), Natalie (Bain Capital)
   - J9yOpYz "Aggregation Era burned journalism" ✓
   - EkGROKB "Free Press needs Free Protocols" ✓ (same panel)
3. ~32m: Natalie continues, sovereign media discussion
   - obLbvQV "Economics of Sovereign Media" ✓
4. ~63m: Josh Chiquette intro, then Hilke (musician)
   - 81VNEBO "Creators First" ✓
   - XxPK17j "Atmospheric Publishing Discussion" ✓ (same panel)
5. ~94m: Justin again — VLa69bl "Discussion with news creators" ✓
6. [BREAK 141-200m: "Thank you" loops, "For more UN videos visit www.un.org" hallucination]
7. 200m: Chad Koholik returns — "afternoon section"
   - QKlrLXG "Digital Sovereignty" ✓ (201m)
8. 233m: OD2PpYA "Open social tech and geopolitical risk" ✓
9. 260m: Sebastian Vogelsang — ja4ooAa "Public Interest Infrastructure" OR Bzr448Q "Gander Social"
10. [BREAK 286-348m]
11. 348-395m: Lightning talks section:
    - PdJ6Q8d "Journalism must create its own algorithms" (Chad MC)
    - 000WSocial "WSocial" (Jan Lindblad, 361m)
    - 000Ryo "Sky Follower Bridge" (Ryo, 371m)
    - lbkWPeN "OakLog" (381m)
12. 395m: Joe Germuska — ZjMOl7o "Matadata" ✓
13. 428m: Last talk — ZjL74D0 "Jacquard Magic"?

**Talks to REMOVE (wrong-room assignments):**
- EkexvrN "Cooperate and Succeed" — belongs to PT D2
- LZ4oWrj "Skywatch" — belongs to R2301 D2
- J9EgEdX "Hypercerts" — belongs to R2301 D1
- OD6Gd0A "Semble: Trails" — belongs to GH D1 (lightning talk)
- dWGJ41y "Abstracting AppView" — belongs to PT D2
- eqVMWz0 "Content Mod Futures" — belongs to R2301 D2

**Root cause:** Boundary detection assigned concurrent-room talks to this stream because they had matching scheduled times. The Media & Civics track ran in panels, so each "slot" had ONE panel, not multiple separate talks.

**Observations:**
- Panel format makes individual talk boundaries fuzzy — speakers rotate within panels
- MC intros are the most reliable boundary marker: "Welcome to the afternoon section"
- "For more UN videos visit www.un.org" is a new hallucination pattern (160m break)
- "Transcripts provided by Transcription Outsourcing LLC" also appears here (21-31m, between panels)

### Performance Theatre Day 2 (Sunday)

**Status: Significant rework needed — hallucination zones, zero-duration talks**

**Actual talk sequence from transcript:**
1. 0.9m: Jim (Blue Sky DevRel) — VLXBbzJ "How and Why News Organizations Should Build on ATProtocol" ✓
2. [hallucination at 25.6m: "Transcribed by https://otter ai"]
3. 61.1m: Jonathan Warden — jaAWVRY "Bringing Self Sovereign Identities" ✓
4. 91.0m: "can people hear me... North Sky Social" — 1AzdYWM "Bluenotes: Community Notes for ATProto" ✓
5. [break/hallucination 141-161m: ESO, UGA Extension Office]
6. 161-203m: Hallucination zone — q4qlVLY "Community privacy" and EkexvrN "Cooperate and Succeed" HAPPENED here but transcript is garbage
7. [hallucination 203-237m: numbers, otter ai]
8. ~240m: Real speech resumes — some talk mid-content
9. 272m: Baldemar — WObY04Q "furryli.st" ✓ (currently at 4:00:03=240m, should be ~272m)
10. 303.9m: Dame — 9qjDJZG "From Toilets to Moths" ✓ (currently at 4:32:04=272m, should be ~304m)
11. [break/hallucination 346-360m: ESO]
12. 360.8m: MC — "lightning rounds... first up Nick Perez with the design philosophy of BookHive"
    - q4QdXj7 "ATProto design philosophy behind BookHive" ✓ (currently ZERO DURATION at 5:03:54)
13. ~375m: dWGJ41y "Abstracting the AppView"? (one of the zero-duration talks)
14. 381.8m: 686gZde "Using GraphQL to build with ATProto" ✓
15. 393.3m: "Jekard Magic" — ZjL74D0 "Jacquard Magic" ✓ (Orwal/"Jekard is the AT Proto library")
16. ~421m: Hilke — A7YLlpl "An artist dreaming in the Atmosphere" ✓ ("I'm here to dream about the future")
17. Stream ends ~454.8m

**Corrections needed:**
1. VLXBbzJ start: Currently in "otter ai" hallucination. Actual Jim intro at 0.9m (54s). Fix start.
2. q4qlVLY + EkexvrN: In hallucination zone (141-237m). Keep approximate timestamps, note bad transcript.
3. WObY04Q: Move from 240m (14403s) to 272m (16326s)
4. 9qjDJZG: Move from 272m (16324s) to 304m (18234s)
5. q4QdXj7 (BookHive): Currently ZERO DURATION at 5:03:54. Fix: start ~361m (21648s) per MC intro
6. dWGJ41y (Abstracting AppView): Currently ZERO DURATION. Needs proper timestamps if on this stream.
7. 686gZde (GraphQL): Move from 5:03:54 to ~382m (22908s)
8. ZjL74D0 (Jacquard): Move from extrapolated 5:15:46 to ~393m (23598s)
9. A7YLlpl: Start at ~421m (25260s), end at ~454.8m (27288s)
10. All end times need recalculating.

**New hallucination patterns:**
- "Transcription by ESO Translation by —" (141m, 346m)
- "© 2016 University of Georgia College of Agricultural and Environmental Sciences UGA Extension Office" (161m)
- Random numbers: "3 13 25 29 30 31 32 33 34 35 36 37 38 39 41 43 54" (203m)
- "0 0 0 0 0" (207m)

**Observations:**
- MC lightning talk intro is gold: "First up we have Nick Perez with the design philosophy of BookHive" — gives us exact talk-to-speaker mapping
- "Jekard Magic" is Whisper's rendering of "Jacquard Magic" — phonetic matching could catch this
- Zero-duration talks cluster where the boundary detection couldn't find a gap
- Hallucination zones on PT D2 are shorter but more varied (5+ different patterns)
