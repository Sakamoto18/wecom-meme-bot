# Official platform wordmarks

These assets identify the source platform on video share cards. They are the
platforms' original website header logos, not favicons, generated drawings, or
crops of user-provided screenshots. The original marks belong to their respective
platforms.

## Bilibili

- Source page: <https://www.bilibili.com/blackboard/aboutUs.html>
- Header asset: <https://s1.hdslb.com/bfs/seed/laputa-header/bili-header.umd.js>
- Component: `BilibiliIcon` (`uNe`), with SVG viewBox `0 0 2240 1024`.
- Official theme: <https://s1.hdslb.com/bfs/seed/jinkela/short/bili-theme/light_all.css>
- Extraction: copied the original SVG path unchanged; resolved the source's
  `var(--brand_blue)` to the official `#00AEEC`; rasterized the SVG to a transparent
  560 × 256 PNG using `@resvg/resvg-js`.
- `bilibili.svg` retains the extracted vector source.

## Xiaohongshu

- Source page: <https://www.xiaohongshu.com/explore>
- Element: `img.header-logo` with a `data:image/png;base64,...` source.
- Extraction: decoded the embedded PNG bytes directly without modifying them.
- Original image: transparent 205 × 96 red capsule with the white wordmark.

Retrieved on 2026-09-11. The `.source.json` files record provenance and SHA-256
checksums. Both PNGs are bundled so generating a card does not need another logo
network request. Deploy the `assets/logos` directory together with the plugin.
