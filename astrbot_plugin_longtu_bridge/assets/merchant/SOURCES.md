# Merchant interface references

User requested the look of the game screenshot and this public stock page:
https://www.onebiji.com/hykb_tools/comm/lkwgmerchant/preview.php?id=1&immgj=0

The PNG/JPG assets except `game-shop-title.png` are downloaded from:
https://res.3839pic.com/onebiji/hykb_tools/comm/lkwgmerchant/static/images/<filename>?0602

Retrieved 2026-11-18. `tit1.png` contains the reference's original lettering.
`game-shop-title.png` is the static shop header cropped/masked from the user-supplied
1080-class screenshot (original dimensions 1108×527). No stock/countdown is taken
from that screenshot. Runtime product icons and inventory always come from the
validated current round.

These are source/game artwork, not newly generated or owned by this project;
source provenance is retained in this file; the user requested that source
labels be removed from the rendered card. No blanket redistribution license
is asserted here.

The reference CSS has no @font-face; dynamic text uses system sans-serif, including
Microsoft Yahei on Windows. Runtime uses the host's msyh/msyhbd files when present,
then the project's existing CJK font. No font binary is added or represented as
the game's original typeface.
