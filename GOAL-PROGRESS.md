# Antigle MetaShield — Goal & Progress

**Project folder:** `G:\Development\JavaScript\antigle-metashield\`
**Last updated:** 2026-11-19
**File to open when done:** `index.html` (served over localhost or HTTPS)

---

## 1. Goal of this chat

Build a **complete, offline, installable web app** that strips metadata from images, lets the user
**inspect and edit** that metadata, and works on **many files at once** — with the look and feel of
[gammamod.com](https://gammamod.com/) (the user's own reference site, explicitly approved).

### Hard requirements

| # | Requirement | Detail |
|---|-------------|--------|
| 1 | **Remove metadata** | JPEG: EXIF/XMP (APP1), IPTC (APP13), comments (COM), ICC (APP2, strict mode only), appended trailer data. PNG: `tEXt`, `zTXt`, `iTXt`, `eXIf`. WebP: `EXIF`, `XMP `, `ICCP` (strict only). |
| 2 | **View metadata** | "Inspector": every tag, chunk and segment in plain language, plus a privacy-risk score. |
| 3 | **Edit metadata** | Write Author / Copyright / Description into the file (EXIF for JPEG, `iTXt` for PNG, XMP for WebP). EXIF orientation can be preserved. |
| 4 | **Bulk files** | Multi-file and whole-folder input, sequential processing with progress, ZIP download, Web Share. |
| 5 | **Lossless** | Never decode/redraw through canvas. Compressed image data is copied byte for byte and the output is re-parsed to prove the pixel stream hash is unchanged. |
| 6 | **100% offline** | No backend, no CDN, no analytics. Local fonts, local service worker, PWA manifest, installable. |
| 7 | **UI like gammamod.com** | Light lavender background, white rounded cards, purple gradient pill CTAs, sticky header with pill nav, numbered feature grid, "how it works" steps, FAQ. Poppins (vendored). |
| 8 | **Filename options** | `_clean` suffix or keep original name. |

### Explicitly out of scope

- No deployment, no `git push`, no Cloudflare/GitHub Pages publishing (not authorised).
- Not a watermark remover — visible marks are part of the pixels.
- No accounts, no cloud storage, no server-side anything.

---

## 2. Decisions already made

- **Location:** `G:\Development\JavaScript\antigle-metashield\`. The AGENTS.md rule says websites go to
  `D:\Code Projects\websites\`, but **drive D: is not mounted**, so the documented JavaScript-project
  fallback on `G:` was used.
- **One brand family with the user's existing `antiglekit` site** — name "Antigle MetaShield".
- **Vendored everything** so the app works with the network cable pulled:
  Poppins 400/500/600/700 `woff2` are stored in `assets/fonts/`, no Google Fonts at runtime.
- **No third-party libraries.** JSZip was dropped in favour of a ~120-line STORE-only ZIP writer
  (images are already compressed, so storing costs nothing and removes a dependency).
- **Three modes:** `smart` (recommended), `strict` (max privacy), `tag` (keep everything, only add tags).

---

## 3. What is built (verified)

| File | State | Notes |
|------|-------|-------|
| `assets/js/engine.js` | ✅ done, tested | 48.7 KB. Detect / analyse / process for JPEG, PNG, WebP. TIFF EXIF reader (IFD0 + EXIF + GPS + Interop, GPS→decimal, orientation, maker-note skip), minimal big-endian EXIF writer, COM writer, PNG `iTXt` injection, XMP builder, AI-prompt heuristics, risk score, per-chunk `kept`/`removed`/`added` status, FNV pixel-hash verification. Exposed as `MetaShield.*` and via `module.exports`. |
| `assets/js/zip.js` | ✅ done, untested in browser | 3.5 KB. STORE-only ZIP writer: CRC32 table, UTF-8 name flag (bit 11), DOS timestamps, local headers + central directory + EOCD. |
| `index.html` | ✅ done, not yet styled/verified | 23.4 KB. Sticky header, hero, full tool panel (dropzone, mode cards, tag fields, switches, results area), "What it does" + inspector mock, 6 numbered features, 3 steps, FAQ, CTA band, footer, inspector modal, toast. |
| `assets/fonts/poppins-*.woff2` | ✅ done | 400 / 500 / 600 / 700 |
| `assets/css/app.css` | ⏳ **missing** | Page currently has no styling. |
| `assets/js/app.js` | ⏳ **missing** | No behaviour wired yet. |
| `manifest.json` | ⏳ **missing** | |
| `sw.js` | ⏳ **missing** | |
| `assets/icons/*` (192, 512, favicon) | ⏳ **missing** | Referenced by `index.html`. |

---

## 4. Verification actually run

Test fixtures generated with PIL at `C:/Users/Welcome/AppData/Local/Temp/gg/fix/`:
`photo.jpg` (EXIF + GPS + XMP + APP13 + COM + appended payload), `progressive.jpg`,
`art.png` (AI-prompt `tEXt` + `eXIf`), `photo.webp` (EXIF + XMP), `icc.jpg` (real sRGB ICC profile).

Harness: `node test.js` / `node t2.js` (engine) → outputs in `fix/out/`, checked with `verify.py` (PIL).

### Results

| Check | Result |
|-------|--------|
| Pixels identical to source, all 3 modes × 4 files | **PASS** — 12/12 decodes match exactly (`OK`) |
| Dimensions preserved | **PASS** |
| Smart mode leaks (`Rooftop`, `Canon`, `EOS R6`, timestamps, `Photoshop`, `HIDDEN-APPENDED`, prompt text, `ComfyUI`) | **PASS** — zero leaks |
| Strict mode leaks | **PASS** — zero leaks |
| Tag mode keeps original metadata + adds ours | **PASS** (by design) |
| Injected EXIF readable by a third-party parser (PIL) | **PASS** — Artist, Copyright, Description, Software, Orientation 6 all read back |
| ICC profile: smart keeps / strict removes | **PASS** — `icc smart keeps ICC: true`, `icc strict keeps ICC: false` |
| Progressive JPEG still decodes progressively, pixels identical | **PASS** |
| WebP VP8X flags after cleaning | **PASS** — original `0x0c` (EXIF+XMP) → cleaned `0x04` (EXIF bit cleared, XMP bit set because our own XMP is injected) |
| Trailing appended payload removed | **PASS** — 88 B trailer gone in smart/strict |

Engine bug found and fixed during testing: a broken string literal at `engine.js` line ~168
(`'‹int32 array›'`) that threw `SyntaxError: Unexpected identifier 'int32'`.

Not yet verified (blocked on missing files): browser behaviour, ZIP validity, service worker,
offline install, responsive layout.

---

## 5. Remaining work, in order

1. **`assets/css/app.css`** — the whole gammamod-style design system: tokens (lavender bg `#F6F4FF`,
   purple `#7C3AED` → `#A855F7`, 20–28 px radii, pill buttons), `@font-face`, header, hero with glow
   blobs, tool card, mode cards, switches, file list, inspector modal, features, steps, FAQ,
   responsive breakpoints ≤ 1000 px and ≤ 720 px.
2. **`assets/js/app.js`** — file/folder intake, drag-drop, auto-process, settings re-apply, per-file
   cards with thumbnails + risk + saved-bytes, inspector modal (tag table, chunk table, warnings,
   verified line, copy report), single download, ZIP download, Web Share, clear, install prompt,
   offline pill, toasts, filename `_clean` handling with de-duplication.
3. **`manifest.json` + `sw.js`** — cache `index.html`, CSS, three JS files, fonts, icons; version bump
   constant; offline-first fetch strategy.
4. **Icons** — 192/512 PNG + `favicon.svg` generated locally with PIL (gradient tile + shield).
5. **Smoke test** — `python -m http.server 8080` in the project folder, load the page, confirm no
   console errors, drop the fixtures in, check the ZIP opens and pixels are unchanged.
6. **Report** — state exactly which checks passed and which could not run.

---

## 6. How to run it later

```bash
cd "G:/Development/JavaScript/antigle-metashield"
python -m http.server 8080
# open http://localhost:8080
```

A service worker (and therefore full offline install) only works over `localhost` or HTTPS — opening
`index.html` directly from the file system still runs the cleaner, but not the PWA layer.
