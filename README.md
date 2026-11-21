# Antigle MetaShield

A local, offline browser tool for inspecting, editing and removing hidden metadata from images.

## What it does

- **Inspects** an image byte by byte and shows EXIF, XMP, IPTC, comments, colour profiles and PNG/WebP chunks in plain language, with a privacy-risk score.
- **Removes** identifying data such as GPS coordinates, camera details, timestamps, software names, author fields, AI-prompt text and appended payloads.
- **Edits** Author, Copyright and Description fields before saving.
- **Handles bulk work**: add many files or a whole folder, watch progress, then download a ZIP or use Web Share.
- **Stays lossless**: no canvas, no re-encoding. Compressed image data is copied byte for byte, and the output is re-parsed to confirm the pixel hash is unchanged.

## Privacy

Everything runs in the browser. There is no backend, no CDN, no analytics and no upload step. Fonts, icons and the service worker are bundled locally, so after the first load from localhost or HTTPS the app keeps working offline and can be installed as a PWA.

## Supported formats

| Format | Handled metadata |
|---|---|
| JPEG | EXIF, XMP, IPTC, COM, ICC, appended trailer data |
| PNG | `tEXt`, `zTXt`, `iTXt`, `eXIf` |
| WebP | `EXIF`, `XMP `, `ICCP` |

## Modes

- **Smart** (recommended): removes identifying metadata while keeping colour behaviour and orientation.
- **Strict**: maximum removal, including colour profiles and appended data.
- **Tag**: keeps existing metadata and only adds the fields you choose.

## Run locally

Serve this folder over localhost:

```sh
python -m http.server 8123 --directory "<project-folder>"
```

Then open `http://127.0.0.1:8123/`.

A service worker requires localhost or HTTPS. Opening `index.html` directly with `file://` will not enable offline installation.

## Output naming

Choose either a `_clean` suffix or keep the original filename. Use the switch for EXIF orientation when phone photos need to stay visually upright.

## Limits

- Visible watermarks are part of the pixels and are not removed.
- Inspection shows what is present in the file; it cannot recover metadata that was never stored.

See `LICENSE` for licensing.
