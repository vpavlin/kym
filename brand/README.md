# KYM brand

The KYM logo: **"KYM" stamped on an anthracite metallic coin** (white text, dark
brushed-steel disc with a reeded edge, on a charcoal background). A coin = money;
the wordmark = the name. Monochrome and premium; sits well in a dark UI.

## Masters (SVG — the source of truth)

| File | Use |
|---|---|
| `kym-logo.svg` | canonical logo, rounded tile + coin (brand refs, previews) |
| `kym-icon-full.svg` | full-bleed app icon (launcher masks the corners) |
| `kym-fg.svg` | Android adaptive-icon **foreground** (coin only, transparent, in the safe zone) |
| `kym-bg.svg` | Android adaptive-icon **background** (full-bleed charcoal gradient) |
| `kym-splash.svg` | splash-screen mark (smaller coin, transparent) |
| `kym-module.svg` | Basecamp module tile (rounded + coin) |

`logo-preview.png` is a rendered preview.

## Rebuild the rasters

Only `rsvg-convert` renders these correctly (ImageMagick has no SVG delegate here):

```sh
rsvg-convert -w 1024 -h 1024 kym-icon-full.svg -o ../mobile/assets/icon.png
rsvg-convert -w 1024 -h 1024 kym-fg.svg        -o ../mobile/assets/adaptive-icon.png
rsvg-convert -w 1024 -h 1024 kym-bg.svg        -o ../mobile/assets/adaptive-bg.png
rsvg-convert -w 1024 -h 1024 kym-splash.svg    -o ../mobile/assets/splash.png
rsvg-convert -w  512 -h  512 kym-module.svg    -o ../module/icon.png
```

The SVGs were emitted by a small `coin(R)` generator (palette + reeded-edge geometry);
tweak colours/size there and re-emit. Mobile picks these up on `expo prebuild`; the
Basecamp module needs `module/icon.png` **git-tracked** (nix flakes only see tracked files).
