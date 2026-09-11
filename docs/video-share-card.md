# Video share cards

Source identity belongs to the video author. QQ sender data must never replace
the author or avatar. Bilibili displays the original description below the cover;
Xiaohongshu displays source topics there. An absent description/topic list leaves
the footer blank. The renderer measures text before allocating the canvas.

Official wordmarks and their provenance are in
astrbot_plugin_longtu_bridge/assets/logos/README.md. They are loaded locally;
card generation does not request a favicon or use a screenshot.

## Production paths

The live Xiaohongshu provider is the host service on port 9000:

- systemd: spider-xhs-provider.service
- live helper: /opt/Spider_XHS/page_content.py
- repository source: services/spider-xhs/page_content.py

Deploying only qq-bot or the optional spider-xhs Docker service does not update
that helper. The original helper discarded note.user, causing all downstream
author parsing attempts to receive no author fields. It now retains author,
avatarUrl and tags along with the existing media data.

The Node service runs from /opt/longtu-qq-bot and is rebuilt via its qq-bot Compose
service. The AstrBot plugin is mounted from that directory's
astrbot_plugin_longtu_bridge folder. Deploy main.py, video_card.py and assets/logos
together. Restart AstrBot after all files are present; do not recreate NapCat.

## Verification

- npm test
- python3 -m unittest discover -s test -p 'test_*py'
- scripts/verify-video-card.py invokes the deployed Bridge method directly with
  live resolver JSON, fetches actual cover/avatar images, and writes a PNG.
- Inspect both platforms' PNGs, then check the test group's OneBot image message
  IDs. A generated log or successful file copy alone does not validate contents.

Media cache validity depends on the media TTL, not optional card metadata.
Repeated shares across groups continue to reuse the resolved video/gallery.
