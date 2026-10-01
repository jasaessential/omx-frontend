# PWA Icons

These icons are required for the Play Store AAB build via PWABuilder.

## Required Files

| File | Size | Purpose |
|------|------|---------|
| launchericon-48x48.png | 48×48 | Android legacy |
| launchericon-72x72.png | 72×72 | Android legacy |
| launchericon-96x96.png | 96×96 | Android legacy |
| launchericon-144x144.png | 144×144 | Android / Windows |
| launchericon-192x192.png | 192×192 | Android home screen |
| launchericon-512x512.png | 512×512 | Play Store listing |
| launchericon-512x512-maskable.png | 512×512 | Android adaptive icon (maskable) |

## How to Generate

1. Go to https://www.pwabuilder.com/imageGenerator
2. Upload your `assets/logo.png`
3. Download the generated icon pack
4. Place all icons in this folder (`assets/icons/`)

## Maskable Icon Note
The maskable icon (`launchericon-512x512-maskable.png`) must have safe zone padding (~20% on all sides).
Use https://maskable.app/editor to preview and adjust.

## Screenshots (also required)
Place these in `assets/screenshots/`:
- `screenshot-mobile.png` — 390×844 (portrait phone screenshot)
- `screenshot-desktop.png` — 1280×800 (landscape desktop screenshot)
