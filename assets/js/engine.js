/*!
 * Antigle MetaShield — lossless image metadata engine
 * JPEG / PNG / WebP. Binary chunk surgery only: no canvas, no re-encoding.
 * Works in a browser window and in Node (no DOM access).
 */
(function (g) {
  'use strict';

  var VERSION = '1.0.0';

  /* ------------------------------------------------------------------ *
   *  helpers
   * ------------------------------------------------------------------ */

  var TE = new TextEncoder();

  function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u32be(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }
  function u32le(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }
  function ascii(b, o, n) {
    var s = '';
    for (var i = o; i < o + n; i++) { s += String.fromCharCode(b[i]); }
    return s;
  }
  function startsWith(b, o, str) {
    if (o + str.length > b.length) return false;
    for (var i = 0; i < str.length; i++) {
      if (b[o + i] !== str.charCodeAt(i)) return false;
    }
    return true;
  }
  function toAsciiBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }
  function utf8(str) { return TE.encode(str); }

  function cat(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total), at = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], at); at += list[i].length; }
    return out;
  }

  function fnv(bytes, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function readU16BE(b, o) { return (b[o] << 8) | b[o + 1]; }

  /* ------------------------------------------------------------------ *
   *  EXIF / TIFF reader
   * ------------------------------------------------------------------ */

  var TAG_NAMES = {
    0x0100: 'Image width', 0x0101: 'Image height', 0x0102: 'Bits per sample',
    0x010e: 'Image description', 0x010f: 'Camera make', 0x0110: 'Camera model',
    0x0112: 'Orientation', 0x011a: 'X resolution', 0x011b: 'Y resolution',
    0x0128: 'Resolution unit', 0x0131: 'Software', 0x0132: 'File date/time',
    0x013b: 'Artist', 0x013c: 'Host computer', 0x0213: 'YCbCr positioning',
    0x8298: 'Copyright', 0x829a: 'Exposure time', 0x829d: 'F-number',
    0x8822: 'Exposure program', 0x8827: 'ISO speed', 0x9000: 'EXIF version',
    0x9003: 'Date taken', 0x9004: 'Date digitised', 0x9010: 'UTC offset',
    0x9011: 'UTC offset original', 0x9201: 'Shutter speed', 0x9202: 'Aperture',
    0x9204: 'Exposure bias', 0x9207: 'Metering mode', 0x9209: 'Flash',
    0x920a: 'Focal length', 0x927c: 'Maker note', 0x9286: 'User comment',
    0x9290: 'Sub-second', 0x9291: 'Sub-second original',
    0xa001: 'Colour space', 0xa002: 'Pixel width', 0xa003: 'Pixel height',
    0xa405: 'Focal length (35mm)', 0xa431: 'Body serial number',
    0xa434: 'Lens model', 0xa435: 'Lens serial number',
    0xc4a5: 'Print image matching'
  };

  var GPS_NAMES = {
    0x0000: 'GPS version', 0x0001: 'Latitude ref', 0x0002: 'Latitude',
    0x0003: 'Longitude ref', 0x0004: 'Longitude', 0x0005: 'Altitude ref',
    0x0006: 'Altitude', 0x0007: 'GPS time', 0x0008: 'Satellites',
    0x0009: 'Status', 0x000a: 'Measure mode', 0x000b: 'DOP',
    0x000c: 'Speed ref', 0x000d: 'Speed', 0x000e: 'Track ref',
    0x000f: 'Track', 0x0010: 'Image direction ref', 0x0011: 'Image direction',
    0x0012: 'Map datum', 0x001d: 'GPS date', 0x001f: 'GPS processing method'
  };

  var ORIENTATION_NAMES = {
    1: 'Normal', 2: 'Mirrored horizontally', 3: 'Rotated 180°',
    4: 'Mirrored vertically', 5: 'Mirrored, rotated 90° CCW',
    6: 'Rotated 90° CW', 7: 'Mirrored, rotated 90° CW',
    8: 'Rotated 90° CCW'
  };

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  function parseTiff(tiff) {
    if (!tiff || tiff.length < 8) return null;
    var le = tiff[0] === 0x49 && tiff[1] === 0x49;
    var be = tiff[0] === 0x4d && tiff[1] === 0x4d;
    if (!le && !be) return null;

    var dv, u16, u32;
    try {
      dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    } catch (e) { return null; }
    u16 = function (o) { return dv.getUint16(o, le); };
    u32 = function (o) { return dv.getUint32(o, le); };

    if (u16(2) !== 42) return null;

    var entries = [];
    var visited = {};

    function readValue(type, count, off) {
      var i, arr;
      switch (type) {
        case 2: {
          var s = '';
          for (i = 0; i < count; i++) {
            var c = tiff[off + i] || 0;
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        }
        case 1:
        case 7: {
          if (count > 8) return '\u2039' + count + ' bytes\u203a';
          arr = [];
          for (i = 0; i < count; i++) arr.push(tiff[off + i]);
          return arr;
        }
        case 3:
          if (count === 1) return u16(off);
          arr = [];
          for (i = 0; i < Math.min(count, 8); i++) arr.push(u16(off + i * 2));
          return arr;
        case 4:
          if (count === 1) return u32(off);
          arr = [];
          for (i = 0; i < Math.min(count, 8); i++) arr.push(u32(off + i * 4));
          return arr;
        case 9:
          return count === 1 ? dv.getInt32(off, le) : '\u2039int32 array\u203a';
        case 5:
        case 10: {
          arr = [];
          for (i = 0; i < Math.min(count, 8); i++) {
            var num = type === 5 ? u32(off + i * 8) : dv.getInt32(off + i * 8, le);
            var den = type === 5 ? u32(off + i * 8 + 4) : dv.getInt32(off + i * 8 + 4, le);
            arr.push(den ? num / den : 0);
          }
          return count === 1 ? arr[0] : arr;
        }
        default:
          return '\u2039type ' + type + '\u203a';
      }
    }

    function readIFD(offset, group, depth) {
      if (depth > 4 || !offset || offset < 8 || offset + 2 > tiff.length) return;
      if (visited[offset]) return;
      visited[offset] = 1;
      var count = u16(offset);
      if (!count || count > 1024) return;
      for (var i = 0; i < count; i++) {
        var e = offset + 2 + i * 12;
        if (e + 12 > tiff.length) break;
        var tag = u16(e), type = u16(e + 2), n = u32(e + 4);
        var size = TYPE_SIZE[type] || 1;
        var byteLen = size * n;
        var vOff = e + 8;
        if (byteLen > 4) {
          vOff = u32(e + 8);
          if (vOff + byteLen > tiff.length) {
            entries.push({ tag: tag, group: group, value: '\u2039out of range\u203a', type: type });
            continue;
          }
        }
        var value;
        try { value = readValue(type, n, vOff); } catch (err) { value = '\u2039unreadable\u203a'; }
        if (group === 'MakerNote' && tag === 0x927c) {
          entries.push({ tag: tag, group: group, value: '\u2039' + n + ' bytes\u203a', type: type });
        } else {
          entries.push({ tag: tag, group: group, value: value, type: type });
        }
        if (group === 'IFD0') {
          if (tag === 0x8769 && typeof value === 'number') readIFD(value, 'EXIF', depth + 1);
          if (tag === 0x8825 && typeof value === 'number') readIFD(value, 'GPS', depth + 1);
          if (tag === 0xa005 && typeof value === 'number') readIFD(value, 'Interop', depth + 1);
        }
      }
    }

    try { readIFD(u32(4), 'IFD0', 0); } catch (err) { return null; }

    var byGroup = { IFD0: {}, EXIF: {}, GPS: {}, Interop: {} };
    entries.forEach(function (en) {
      (byGroup[en.group] = byGroup[en.group] || {})[en.tag] = en.value;
    });

    var orientation = byGroup.IFD0[0x0112] || 1;
    var gps = null;
    var latVals = byGroup.GPS[0x0002];
    var lonVals = byGroup.GPS[0x0004];
    if (Array.isArray(latVals) && latVals.length >= 3 && Array.isArray(lonVals) && lonVals.length >= 3) {
      var lat = latVals[0] + latVals[1] / 60 + latVals[2] / 3600;
      var lon = lonVals[0] + lonVals[1] / 60 + lonVals[2] / 3600;
      if (String(byGroup.GPS[0x0001] || '').toUpperCase().indexOf('S') === 0) lat = -lat;
      if (String(byGroup.GPS[0x0003] || '').toUpperCase().indexOf('W') === 0) lon = -lon;
      gps = { lat: lat, lon: lon, altitude: byGroup.GPS[0x0006], date: byGroup.GPS[0x001d] };
    }

    return {
      entries: entries,
      orientation: typeof orientation === 'number' ? orientation : 1,
      gps: gps,
      make: byGroup.IFD0[0x010f],
      model: byGroup.IFD0[0x0110],
      software: byGroup.IFD0[0x0131],
      artist: byGroup.IFD0[0x013b],
      copyright: byGroup.IFD0[0x8298],
      description: byGroup.IFD0[0x010e],
      userComment: byGroup.EXIF[0x9286],
      dateTaken: byGroup.EXIF[0x9003] || byGroup.IFD0[0x0132]
    };
  }

  /* ------------------------------------------------------------------ *
   *  EXIF / TIFF writer  (minimal, big-endian)
   * ------------------------------------------------------------------ */

  function buildExifApp1(fields) {
    var list = [];

    function asciiEntry(tag, str) {
      if (!str) return;
      var raw = utf8(String(str));
      var bytes = new Uint8Array(raw.length + 1);
      bytes.set(raw);
      list.push({ tag: tag, type: 2, count: bytes.length, bytes: bytes });
    }

    asciiEntry(0x010e, fields.description);
    asciiEntry(0x0131, fields.software);
    asciiEntry(0x013b, fields.artist);
    asciiEntry(0x8298, fields.copyright);

    if (fields.orientation && fields.orientation !== 1) {
      list.push({ tag: 0x0112, type: 3, count: 1, value: fields.orientation });
    }
    if (!list.length) return null;

    list.sort(function (a, b) { return a.tag - b.tag; });

    var n = list.length;
    var cursor = 8 + 2 + n * 12 + 4;
    var blobs = [];
    list.forEach(function (e) {
      if (!e.bytes) return;
      if (cursor % 2) cursor++;
      e.offset = cursor;
      blobs.push([cursor, e.bytes]);
      cursor += e.bytes.length;
    });

    var tiff = new Uint8Array(cursor);
    var dv = new DataView(tiff.buffer);
    tiff[0] = 0x4d; tiff[1] = 0x4d;
    dv.setUint16(2, 42, false);
    dv.setUint32(4, 8, false);
    dv.setUint16(8, n, false);

    list.forEach(function (e, i) {
      var o = 10 + i * 12;
      dv.setUint16(o, e.tag, false);
      dv.setUint16(o + 2, e.type, false);
      dv.setUint32(o + 4, e.count, false);
      if (e.bytes) dv.setUint32(o + 8, e.offset, false);
      else dv.setUint16(o + 8, e.value, false);
    });
    dv.setUint32(10 + n * 12, 0, false);
    blobs.forEach(function (pair) { tiff.set(pair[1], pair[0]); });

    var payload = cat([toAsciiBytes('Exif\u0000\u0000'), tiff]);
    var seg = new Uint8Array(4 + payload.length);
    seg[0] = 0xff; seg[1] = 0xe1;
    seg[2] = ((payload.length + 2) >> 8) & 0xff;
    seg[3] = (payload.length + 2) & 0xff;
    seg.set(payload, 4);
    return seg;
  }

  function buildComSegment(text) {
    var payload = utf8(text);
    var seg = new Uint8Array(4 + payload.length);
    seg[0] = 0xff; seg[1] = 0xfe;
    seg[2] = ((payload.length + 2) >> 8) & 0xff;
    seg[3] = (payload.length + 2) & 0xff;
    seg.set(payload, 4);
    return seg;
  }

  /* ------------------------------------------------------------------ *
   *  text heuristics
   * ------------------------------------------------------------------ */

  var AI_HINTS = [
    /stable\s*diffusion/i, /comfy\s*ui/i, /midjourney/i, /dall[\s-]?e/i,
    /negative\s*prompt/i, /sampler\s*:/i, /cfg\s*scale\s*:/i, /steps\s*:\s*\d+/i,
    /novelai/i, /invoke\s*ai/i, /adobe\s*firefly/i, /generative\s*fill/i,
    /automatic1111/i, /flux\.1/i, /sdxl/i, /prompt\s*:/i, /workflow/i
  ];

  function looksLikeAiPrompt(text) {
    if (!text || text.length < 4) return false;
    for (var i = 0; i < AI_HINTS.length; i++) if (AI_HINTS[i].test(text)) return true;
    return false;
  }

  /* ------------------------------------------------------------------ *
   *  JPEG
   * ------------------------------------------------------------------ */

  var JPEG_NAMES = {
    0x01: 'TEM', 0xc0: 'SOF0', 0xc1: 'SOF1', 0xc2: 'SOF2', 0xc3: 'SOF3',
    0xc4: 'DHT', 0xc5: 'SOF5', 0xc6: 'SOF6', 0xc7: 'SOF7', 0xc8: 'JPG',
    0xc9: 'SOF9', 0xca: 'SOF10', 0xcb: 'SOF11', 0xcc: 'DAC', 0xcd: 'SOF13',
    0xce: 'SOF14', 0xcf: 'SOF15', 0xd8: 'SOI', 0xd9: 'EOI', 0xda: 'SOS',
    0xdb: 'DQT', 0xdc: 'DNL', 0xdd: 'DRI', 0xde: 'DHP', 0xdf: 'EXP',
    0xfe: 'COM'
  };
  for (var _m = 0xe0; _m <= 0xef; _m++) JPEG_NAMES[_m] = 'APP' + (_m - 0xe0);

  var SOF_MARKERS = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];

  function jpegTagList(exif, extra) {
    var tags = [];
    if (exif) {
      var seen = {};
      exif.entries.forEach(function (en) {
        var key = en.group + ':' + en.tag;
        if (seen[key]) return;
        seen[key] = 1;
        if (en.tag === 0x927c) return;
        var label = (en.group === 'GPS' ? GPS_NAMES[en.tag] : TAG_NAMES[en.tag]) || ('Tag 0x' + en.tag.toString(16));
        var group = en.group === 'IFD0' ? 'Image' : en.group;
        var value = en.value;
        if (en.tag === 0x0112 && typeof value === 'number') {
          value = value + ' \u2014 ' + (ORIENTATION_NAMES[value] || 'Unknown');
        } else if (en.tag === 0x829a && typeof value === 'number' && value > 0) {
          value = value >= 1 ? value + ' s' : '1/' + Math.round(1 / value) + ' s';
        } else if (en.tag === 0x829d && typeof value === 'number') {
          value = 'f/' + (Math.round(value * 10) / 10);
        } else if (en.tag === 0x920a && typeof value === 'number') {
          value = value + ' mm';
        } else if (en.tag === 0x8827) {
          value = Array.isArray(value) ? value.join(', ') : value;
        } else if (Array.isArray(value)) {
          value = value.join(', ');
        }
        tags.push({ group: group, key: label, value: String(value) });
      });
      if (exif.gps) {
        tags.push({
          group: 'Location', key: 'GPS coordinates',
          value: exif.gps.lat.toFixed(6) + ', ' + exif.gps.lon.toFixed(6)
        });
        if (exif.gps.date) tags.push({ group: 'Location', key: 'GPS date', value: String(exif.gps.date) });
        if (typeof exif.gps.altitude === 'number') {
          tags.push({ group: 'Location', key: 'Altitude', value: Math.round(exif.gps.altitude) + ' m' });
        }
      }
    }
    (extra || []).forEach(function (t) { tags.push(t); });
    return tags;
  }

  function parseJpeg(bytes) {
    var doc = {
      format: 'jpeg', mime: 'image/jpeg', bytes: bytes,
      items: [], tags: [], warnings: [], width: 0, height: 0,
      flags: {}, trailer: null, pixelHash: 0x811c9dc5, exif: null, orientation: 1
    };
    var o = 2;
    var extraTags = [];
    var pixelSeed = 0x811c9dc5;

    doc.items.push({
      kind: 'struct', marker: 0xd8, name: 'SOI', note: 'Start of image',
      raw: bytes.subarray(0, 2), size: 2
    });

    while (o < bytes.length) {
      if (bytes[o] !== 0xff) {
        doc.trailer = bytes.subarray(o);
        doc.warnings.push('Unrecognised bytes at offset ' + o + ' \u2014 kept as trailing data.');
        break;
      }
      if (o + 1 >= bytes.length) break;
      var marker = bytes[o + 1];
      if (marker === 0xff) { o++; continue; }

      if (marker === 0xd9) {
        doc.items.push({ kind: 'struct', marker: marker, name: 'EOI', note: 'End of image', raw: bytes.subarray(o, o + 2), size: 2 });
        o += 2;
        if (o < bytes.length) doc.trailer = bytes.subarray(o);
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        doc.items.push({ kind: 'struct', marker: marker, name: JPEG_NAMES[marker] || 'RST', raw: bytes.subarray(o, o + 2), size: 2 });
        o += 2;
        continue;
      }
      if (o + 4 > bytes.length) { doc.trailer = bytes.subarray(o); break; }

      var len = u16be(bytes, o + 2);
      if (len < 2 || o + 2 + len > bytes.length) {
        doc.trailer = bytes.subarray(o);
        doc.warnings.push('Truncated ' + (JPEG_NAMES[marker] || 'segment') + ' at offset ' + o + '.');
        break;
      }

      var raw = bytes.subarray(o, o + 2 + len);
      var payload = raw.subarray(4);
      var name = JPEG_NAMES[marker] || ('0x' + marker.toString(16));

      if (marker === 0xda) {
        doc.items.push({ kind: 'struct', marker: marker, name: 'SOS', note: 'Start of scan', raw: raw, size: raw.length });
        o += 2 + len;
        var start = o;
        var p = o;
        while (p + 1 < bytes.length) {
          if (bytes[p] !== 0xff) { p++; continue; }
          var nxt = bytes[p + 1];
          if (nxt === 0x00 || (nxt >= 0xd0 && nxt <= 0xd7)) { p += 2; continue; }
          if (nxt === 0xff) { p += 1; continue; }
          break;
        }
        var end = Math.min(p, bytes.length);
        if (end > start) {
          var scan = bytes.subarray(start, end);
          doc.items.push({ kind: 'pixels', marker: -1, name: 'Scan data', raw: scan, size: scan.length });
          pixelSeed = fnv(scan, pixelSeed);
        }
        o = end;
        continue;
      }

      if (marker >= 0xc0 && marker <= 0xcf && SOF_MARKERS.indexOf(marker) !== -1) {
        if (payload.length >= 5) {
          doc.height = u16be(payload, 1);
          doc.width = u16be(payload, 3);
        }
      }

      var item = { kind: 'struct', marker: marker, name: name, raw: raw, size: raw.length, note: '' };

      if (marker === 0xe0 && startsWith(payload, 0, 'JFIF\u0000')) {
        var vMaj = payload[5], vMin = payload[6], units = payload[7];
        item.note = 'JFIF ' + vMaj + '.' + vMin + ' \u00b7 density ' + u16be(payload, 8) + ' \u00d7 ' + u16be(payload, 10) +
          (units === 1 ? ' dpi' : units === 2 ? ' dpcm' : ' aspect');
        item.kind = 'structure';
        extraTags.push({ group: 'File', key: 'Colour format', value: 'JFIF baseline container' });
      } else if (marker === 0xe0) {
        item.note = 'Application segment (JFXX or vendor)';
        item.kind = 'metadata';
      } else if (marker === 0xe1) {
        if (startsWith(payload, 0, 'Exif\u0000\u0000')) {
          var exif = parseTiff(payload.subarray(6));
          doc.exif = exif;
          item.kind = 'metadata';
          item.name = 'APP1 \u00b7 EXIF';
          if (exif) {
            doc.orientation = exif.orientation || 1;
            var bits = [];
            if (exif.make || exif.model) bits.push([exif.make, exif.model].filter(Boolean).join(' '));
            if (exif.dateTaken) bits.push(String(exif.dateTaken));
            if (exif.gps) bits.push('GPS');
            if (exif.software) bits.push(String(exif.software));
            item.note = bits.length ? bits.join(' \u00b7 ') : 'EXIF block';
            if (exif.entries.length) {
              item.kind = 'metadata';
            }
          } else {
            item.note = 'EXIF block (unreadable)';
          }
        } else if (startsWith(payload, 0, 'http://ns.adobe.com/xap/1.0/\u0000')) {
          item.kind = 'metadata';
          item.name = 'APP1 \u00b7 XMP';
          var xmpText = new TextDecoder('utf-8', { fatal: false }).decode(payload.subarray(29));
          item.note = 'XMP metadata (' + xmpText.length + ' chars)';
          item.text = xmpText;
          doc.xmp = xmpText;
          var creator = /dc:creator[\s\S]{0,200}?<rdf:li[^>]*>([^<]+)</i.exec(xmpText);
          if (creator) extraTags.push({ group: 'XMP', key: 'Creator', value: creator[1].trim() });
          var tool = /xmp:CreatorTool[^>]*>([^<]+)</i.exec(xmpText);
          if (tool) extraTags.push({ group: 'XMP', key: 'Creator tool', value: tool[1].trim() });
          var rights = /dc:rights[\s\S]{0,200}?<rdf:li[^>]*>([^<]+)</i.exec(xmpText);
          if (rights) extraTags.push({ group: 'XMP', key: 'Rights', value: rights[1].trim() });
        } else if (startsWith(payload, 0, 'http://ns.adobe.com/xmp/extension/\u0000')) {
          item.kind = 'metadata';
          item.name = 'APP1 \u00b7 Extended XMP';
          item.note = 'Extended XMP (large metadata payload)';
        } else {
          item.kind = 'metadata';
          item.name = 'APP1 \u00b7 unknown';
          item.note = 'Vendor application block';
        }
      } else if (marker === 0xe2) {
        if (startsWith(payload, 0, 'ICC_PROFILE\u0000')) {
          item.kind = 'color';
          item.name = 'APP2 \u00b7 ICC profile';
          item.note = 'Colour profile \u00b7 ' + (payload.length + 4) + ' bytes \u00b7 part ' + payload[12] + '/' + payload[13];
          doc.hasIcc = true;
        } else {
          item.kind = 'metadata';
          item.note = 'Vendor application block';
        }
      } else if (marker === 0xed) {
        item.kind = 'metadata';
        item.name = 'APP13 \u00b7 IPTC';
        item.note = startsWith(payload, 0, 'Photoshop 3.0\u0000')
          ? 'Photoshop / IPTC caption, credit and keyword block'
          : 'IPTC application block';
        doc.hasIptc = true;
      } else if (marker === 0xee) {
        item.kind = 'color';
        item.name = 'APP14 \u00b7 Adobe';
        item.note = 'Adobe colour transform marker (kept \u2014 required for correct colour)';
      } else if (marker === 0xeb) {
        item.kind = 'metadata';
        item.name = 'APP11 \u00b7 JUMBF';
        item.note = 'Content credentials / JUMBF provenance block';
      } else if (marker === 0xfe) {
        item.kind = 'metadata';
        item.name = 'COM \u00b7 comment';
        var comText = new TextDecoder('utf-8', { fatal: false }).decode(payload);
        item.note = comText.slice(0, 120) || 'Comment segment';
        item.text = comText;
        doc.comment = comText;
        extraTags.push({ group: 'Comment', key: 'Comment', value: comText });
      } else if (marker >= 0xe3 && marker <= 0xef) {
        item.kind = 'metadata';
        item.note = 'Vendor application block';
      }

      doc.items.push(item);
      o += 2 + len;
    }

    if (!doc.width || !doc.height) {
      doc.warnings.push('Image dimensions could not be read.');
    }
    doc.pixelHash = pixelSeed;
    doc.tags = jpegTagList(doc.exif, extraTags);
    if (doc.orientation > 1) {
      doc.warnings.push('EXIF Orientation = ' + doc.orientation + ' (' + (ORIENTATION_NAMES[doc.orientation] || 'rotated') +
        '). Stripping it can make the photo appear sideways \u2014 MetaShield can keep it.');
    }
    return doc;
  }

  function jpegRemoval(item, mode) {
    if (mode === 'tag') return false;
    if (item.kind === 'metadata') return true;
    if (item.kind === 'color') {
      if (item.marker === 0xee) return false;      // Adobe transform: never
      return mode === 'strict';                     // ICC profile
    }
    return false;
  }

  function buildJpeg(doc, opts) {
    var mode = opts.mode || 'smart';
    var out = [];
    var chunks = [];
    var removedBytes = 0;
    var removedNames = [];
    var injected = [];

    var fields = {
      artist: opts.author || '',
      copyright: opts.copyright || '',
      description: opts.description || '',
      software: 'Antigle MetaShield',
      orientation: opts.keepOrientation ? doc.orientation : 1
    };

    var injection = null;
    if (mode === 'tag') {
      var lines = [];
      if (opts.author) lines.push('Author: ' + opts.author);
      if (opts.copyright) lines.push('Copyright: ' + opts.copyright);
      if (opts.description) lines.push('Description: ' + opts.description);
      if (lines.length) {
        injection = buildComSegment(lines.join(' \u00b7 '));
        injected.push('COM \u00b7 comment');
      }
    } else {
      injection = buildExifApp1(fields);
      if (injection) {
        var what = [];
        if (fields.artist) what.push('Author');
        if (fields.copyright) what.push('Copyright');
        if (fields.description) what.push('Description');
        if (fields.orientation && fields.orientation !== 1) what.push('Orientation ' + fields.orientation);
        injected.push('APP1 \u00b7 EXIF (' + what.join(', ') + ')');
      }
    }

    var kept = [];
    doc.items.forEach(function (item) {
      var remove = jpegRemoval(item, mode);
      if (remove) {
        removedBytes += item.size;
        removedNames.push(item.name);
        chunks.push({ name: item.name, size: item.size, status: 'removed', note: item.note || '' });
        return;
      }
      kept.push(item);
      chunks.push({ name: item.name, size: item.size, status: 'kept', note: item.note || '' });
    });

    var insertAt = 0;
    while (insertAt < kept.length && (kept[insertAt].marker === 0xd8 || kept[insertAt].marker === 0xe0)) insertAt++;

    kept.forEach(function (item, i) {
      if (i === insertAt && injection) out.push(injection);
      out.push(item.raw);
    });
    if (insertAt >= kept.length && injection) out.push(injection);

    var trailerRemoved = 0;
    if (doc.trailer && doc.trailer.length) {
      if (opts.stripTrailer !== false) {
        trailerRemoved = doc.trailer.length;
        removedBytes += trailerRemoved;
        chunks.push({ name: 'Trailing data after EOI', size: trailerRemoved, status: 'removed', note: 'Appended data outside the JPEG stream' });
        removedNames.push('trailing data');
      } else {
        out.push(doc.trailer);
        chunks.push({ name: 'Trailing data after EOI', size: doc.trailer.length, status: 'kept', note: 'Appended data outside the JPEG stream' });
      }
    }

    if (injection) chunks.push({ name: injected[0], size: injection.length, status: 'added', note: 'Written by MetaShield' });

    return {
      bytes: cat(out), chunks: chunks, removedBytes: removedBytes,
      removedNames: removedNames, injected: injected,
      pixelsIdentical: true
    };
  }

  /* ------------------------------------------------------------------ *
   *  PNG
   * ------------------------------------------------------------------ */

  var PNG_KEEP = {
    IHDR: 1, PLTE: 1, IDAT: 1, IEND: 1, tRNS: 1, gAMA: 1, cHRM: 1, sRGB: 1,
    sBIT: 1, bKGD: 1, pHYs: 1, hIST: 1, sPLT: 1, cICP: 1, mDCv: 1, cLLi: 1,
    acTL: 1, fcTL: 1, fdAT: 1
  };
  var PNG_TEXT = { tEXt: 1, zTXt: 1, iTXt: 1 };

  function readPngText(type, data) {
    var zero = data.indexOf(0);
    if (zero < 0) return null;
    var keyword = ascii(data, 0, zero);
    if (type === 'tEXt') {
      return { keyword: keyword, text: new TextDecoder('latin1').decode(data.subarray(zero + 1)) };
    }
    if (type === 'zTXt') {
      return { keyword: keyword, text: '\u2039compressed text, ' + (data.length - zero - 2) + ' bytes\u203a', compressed: true };
    }
    if (type === 'iTXt') {
      var flag = data[zero + 1];
      var p = zero + 3;
      while (p < data.length && data[p] !== 0) p++;
      p++;
      while (p < data.length && data[p] !== 0) p++;
      p++;
      var body = data.subarray(p);
      return {
        keyword: keyword,
        text: flag ? '\u2039compressed text, ' + body.length + ' bytes\u203a' : new TextDecoder('utf-8', { fatal: false }).decode(body),
        compressed: !!flag
      };
    }
    return null;
  }

  function parsePng(bytes) {
    var doc = {
      format: 'png', mime: 'image/png', bytes: bytes, items: [], tags: [],
      warnings: [], width: 0, height: 0, flags: {}, trailer: null,
      pixelHash: 0x811c9dc5, hasIcc: false
    };
    var o = 8;
    var pixelSeed = 0x811c9dc5;

    while (o + 12 <= bytes.length) {
      var len = u32be(bytes, o);
      var type = ascii(bytes, o + 4, 4);
      var dataStart = o + 8;
      var dataEnd = dataStart + len;
      if (dataEnd + 4 > bytes.length) {
        doc.warnings.push('Truncated "' + type + '" chunk at offset ' + o + '.');
        break;
      }
      var storedCrc = u32be(bytes, dataEnd);
      var calcCrc = crc32(bytes.subarray(o + 4, dataEnd));
      var data = bytes.subarray(dataStart, dataEnd);
      var item = {
        kind: 'struct', type: type, name: type, raw: bytes.subarray(o, dataEnd + 4),
        size: len + 12, payload: data, note: '', crcOk: storedCrc === calcCrc
      };
      if (storedCrc !== calcCrc) {
        doc.warnings.push('CRC mismatch in "' + type + '" chunk.');
      }

      if (type === 'IHDR') {
        doc.width = u32be(data, 0);
        doc.height = u32be(data, 4);
        item.note = doc.width + ' \u00d7 ' + doc.height + ' \u00b7 bit depth ' + data[8] + ' \u00b7 colour type ' + data[9];
      } else if (type === 'IDAT') {
        item.kind = 'pixels';
        pixelSeed = fnv(data, pixelSeed);
      } else if (PNG_TEXT[type]) {
        var parsed = readPngText(type, data);
        item.kind = 'metadata';
        item.note = parsed ? parsed.keyword + ': ' + (parsed.text || '').slice(0, 100) : 'Text chunk';
        if (parsed) {
          item.text = parsed.text;
          item.keyword = parsed.keyword;
          doc.tags.push({ group: 'PNG text', key: parsed.keyword, value: parsed.text });
          if (looksLikeAiPrompt(parsed.keyword) || looksLikeAiPrompt(parsed.text)) doc.aiText = true;
        }
      } else if (type === 'eXIf') {
        item.kind = 'metadata';
        var pngExif = parseTiff(data);
        item.note = pngExif ? 'EXIF block embedded in PNG' : 'EXIF block (unreadable)';
        doc.exif = pngExif || doc.exif;
      } else if (type === 'iCCP') {
        item.kind = 'color';
        var z = data.indexOf(0);
        item.note = 'Embedded ICC colour profile' + (z > 0 ? ' (' + ascii(data, 0, z) + ')' : '');
        doc.hasIcc = true;
      } else if (type === 'acTL') {
        item.note = 'Animated PNG control (animation kept intact)';
        doc.animated = true;
      } else if (type === 'fcTL') {
        item.note = 'Animated PNG frame control';
        doc.animated = true;
      } else if (type === 'fdAT') {
        item.note = 'Animated PNG frame data';
        doc.animated = true;
      } else if (type === 'tRNS') {
        item.note = 'Transparency table';
      } else if (type === 'pHYs') {
        item.note = 'Physical pixel dimensions (DPI)';
      } else if (type === 'gAMA' || type === 'cHRM' || type === 'sRGB' || type === 'cICP') {
        item.note = 'Colour space information';
      }

      doc.items.push(item);
      o = dataEnd + 4;
      if (type === 'IEND') {
        if (o < bytes.length) doc.trailer = bytes.subarray(o);
        break;
      }
    }

    doc.pixelHash = pixelSeed;
    if (doc.width) doc.tags.unshift({ group: 'Image', key: 'Dimensions', value: doc.width + ' \u00d7 ' + doc.height });
    return doc;
  }

  function pngRemoval(item, mode) {
    var type = item.type;
    if (mode === 'tag') return false;
    if (PNG_TEXT[type] || type === 'eXIf') return true;
    if (type === 'iCCP') return mode === 'strict';
    if (PNG_KEEP[type]) return false;
    if (type === 'IEND') return false;
    // Unknown chunk: critical chunks must be preserved or the file breaks.
    var critical = type.charCodeAt(0) < 0x61;
    return !critical;
  }

  function pngChunk(type, data) {
    var out = new Uint8Array(12 + data.length);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, data.length, false);
    out.set(toAsciiBytes(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
    return out;
  }

  function pngTextChunk(keyword, text) {
    return pngChunk('iTXt', cat([
      toAsciiBytes(keyword), new Uint8Array([0, 0, 0]), new Uint8Array([0, 0]), utf8(text)
    ]));
  }

  function buildPng(doc, opts) {
    var mode = opts.mode || 'smart';
    var out = [doc.items.length ? doc.items[0].raw.subarray(0, 0) : new Uint8Array(0)];
    out = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
    var chunks = [];
    var removedBytes = 0;
    var removedNames = [];
    var injected = [];
    var added = [];

    if (mode !== 'tag') {
      if (opts.author) added.push(pngTextChunk('Author', opts.author));
      if (opts.copyright) added.push(pngTextChunk('Copyright', opts.copyright));
      if (opts.description) added.push(pngTextChunk('Description', opts.description));
      if (added.length) {
        injected.push('iTXt (' + [opts.author && 'Author', opts.copyright && 'Copyright', opts.description && 'Description'].filter(Boolean).join(', ') + ')');
      }
    } else {
      if (opts.author) added.push(pngTextChunk('Author', opts.author));
      if (opts.copyright) added.push(pngTextChunk('Copyright', opts.copyright));
      if (opts.description) added.push(pngTextChunk('Description', opts.description));
      if (added.length) injected.push('iTXt (' + added.length + ' tag' + (added.length > 1 ? 's' : '') + ')');
    }

    var insertedBeforeIend = false;
    doc.items.forEach(function (item) {
      if (pngRemoval(item, mode)) {
        removedBytes += item.size;
        removedNames.push(item.type);
        chunks.push({ name: item.type, size: item.size, status: 'removed', note: item.note || '' });
        return;
      }
      if (item.type === 'IEND' && added.length && !insertedBeforeIend) {
        added.forEach(function (c, i) {
          out.push(c);
          chunks.push({ name: 'iTXt', size: c.length, status: 'added', note: 'Written by MetaShield' });
          insertedBeforeIend = true;
        });
      }
      out.push(item.raw);
      chunks.push({ name: item.type, size: item.size, status: 'kept', note: item.note || '' });
    });

    var trailerRemoved = 0;
    if (doc.trailer && doc.trailer.length) {
      if (opts.stripTrailer !== false) {
        trailerRemoved = doc.trailer.length;
        removedBytes += trailerRemoved;
        chunks.push({ name: 'Data after IEND', size: trailerRemoved, status: 'removed', note: 'Appended data outside the PNG stream' });
        removedNames.push('trailing data');
      } else {
        out.push(doc.trailer);
      }
    }

    return {
      bytes: cat(out), chunks: chunks, removedBytes: removedBytes,
      removedNames: removedNames, injected: injected, pixelsIdentical: true
    };
  }

  /* ------------------------------------------------------------------ *
   *  WebP
   * ------------------------------------------------------------------ */

  var WEBP_IMAGE = { VP8: 1, VP8L: 1, ALPH: 1, ANMF: 1, ANIM: 1 };
  var WEBP_META = { EXIF: 1, 'XMP ': 1, ICCP: 1, JUMBF: 1, C2PA: 1 };

  function parseWebp(bytes) {
    var doc = {
      format: 'webp', mime: 'image/webp', bytes: bytes, items: [], tags: [],
      warnings: [], width: 0, height: 0, flags: {}, trailer: null,
      pixelHash: 0x811c9dc5, hasIcc: false
    };
    var riffSize = u32le(bytes, 4);
    var riffEnd = Math.min(8 + riffSize, bytes.length);
    var o = 12;
    var pixelSeed = 0x811c9dc5;

    while (o + 8 <= riffEnd) {
      var fourcc = ascii(bytes, o, 4);
      var size = u32le(bytes, o + 4);
      var dataStart = o + 8;
      var dataEnd = dataStart + size;
      if (dataEnd > riffEnd) {
        doc.warnings.push('Truncated "' + fourcc + '" chunk.');
        break;
      }
      var data = bytes.subarray(dataStart, dataEnd);
      var total = 8 + size + (size & 1);
      var item = {
        kind: 'struct', type: fourcc, name: fourcc.trim() || fourcc, payload: data,
        raw: bytes.subarray(o, Math.min(o + total, bytes.length)), size: total, note: ''
      };

      if (WEBP_IMAGE[fourcc]) {
        item.kind = 'pixels';
        pixelSeed = fnv(data, pixelSeed);
      } else if (fourcc === 'VP8X') {
        var flags = data[0];
        doc.vp8x = true;
        doc.width = 1 + (data[4] | (data[5] << 8) | (data[6] << 16));
        doc.height = 1 + (data[7] | (data[8] << 8) | (data[9] << 16));
        var fl = [];
        if (flags & 0x20) { fl.push('ICC'); doc.hasIcc = true; }
        if (flags & 0x10) fl.push('alpha');
        if (flags & 0x08) fl.push('EXIF');
        if (flags & 0x04) fl.push('XMP');
        if (flags & 0x02) fl.push('animation');
        item.note = 'Canvas ' + doc.width + ' \u00d7 ' + doc.height + (fl.length ? ' \u00b7 ' + fl.join(', ') : '');
      } else if (fourcc === 'VP8 ') {
        if (data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
          doc.width = (data[6] | (data[7] << 8)) & 0x3fff;
          doc.height = (data[8] | (data[9] << 8)) & 0x3fff;
        }
        item.note = 'Lossy VP8 image data';
      } else if (fourcc === 'VP8L') {
        if (data[0] === 0x2f) {
          var b1 = data[1], b2 = data[2], b3 = data[3], b4 = data[4];
          doc.width = 1 + (((b2 & 0x3f) << 8) | b1);
          doc.height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
        }
        item.note = 'Lossless VP8L image data';
      } else if (fourcc === 'EXIF') {
        item.kind = 'metadata';
        var webpExif = parseTiff(data);
        item.note = webpExif ? 'EXIF block' : 'EXIF block (unreadable)';
        doc.exif = webpExif || doc.exif;
        if (webpExif) {
          var bits = [];
          if (webpExif.make || webpExif.model) bits.push([webpExif.make, webpExif.model].filter(Boolean).join(' '));
          if (webpExif.gps) bits.push('GPS');
          if (webpExif.dateTaken) bits.push(String(webpExif.dateTaken));
          if (bits.length) item.note = bits.join(' \u00b7 ');
          doc.orientation = webpExif.orientation || 1;
        }
      } else if (fourcc === 'XMP ') {
        item.kind = 'metadata';
        var xmp = new TextDecoder('utf-8', { fatal: false }).decode(data);
        doc.xmp = xmp;
        item.note = 'XMP metadata (' + xmp.length + ' chars)';
        item.text = xmp;
        if (looksLikeAiPrompt(xmp)) doc.aiText = true;
      } else if (fourcc === 'ICCP') {
        item.kind = 'color';
        item.note = 'Embedded ICC colour profile';
        doc.hasIcc = true;
      } else if (fourcc === 'ANIM' || fourcc === 'ANMF') {
        item.note = 'Animation data';
      }

      doc.items.push(item);
      o = dataEnd + (size & 1);
    }

    doc.pixelHash = pixelSeed;
    if (doc.trailer === null && o < bytes.length && o < bytes.length) {
      // bytes beyond the declared RIFF size
      if (bytes.length > riffEnd) doc.trailer = bytes.subarray(riffEnd);
    }
    if (doc.width) doc.tags.unshift({ group: 'Image', key: 'Dimensions', value: doc.width + ' \u00d7 ' + doc.height });
    if (doc.exif) {
      jpegTagList(doc.exif, []).forEach(function (t) { doc.tags.push(t); });
    }
    return doc;
  }

  function webpRemoval(item, mode) {
    if (mode === 'tag') return false;
    if (item.type === 'EXIF' || item.type === 'XMP ' || item.type === 'JUMBF' || item.type === 'C2PA') return true;
    if (item.type === 'ICCP') return mode === 'strict';
    return false;
  }

  function webpChunk(fourcc, data) {
    var padded = data.length + (data.length & 1);
    var out = new Uint8Array(8 + padded);
    out.set(toAsciiBytes(fourcc), 0);
    var dv = new DataView(out.buffer);
    dv.setUint32(4, data.length, true);
    out.set(data, 8);
    return out;
  }

  function buildXmp(opts) {
    var esc = function (s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    var body = '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n';
    if (opts.author) body += '<dc:creator><rdf:Seq><rdf:li>' + esc(opts.author) + '</rdf:li></rdf:Seq></dc:creator>\n';
    if (opts.copyright) body += '<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">' + esc(opts.copyright) + '</rdf:li></rdf:Alt></dc:rights>\n';
    if (opts.description) body += '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">' + esc(opts.description) + '</rdf:li></rdf:Alt></dc:description>\n';
    body += '<xmp:CreatorTool>Antigle MetaShield</xmp:CreatorTool>\n';
    body += '</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>';
    return body;
  }

  function buildWebp(doc, opts) {
    var mode = opts.mode || 'smart';
    var chunks = [];
    var removedBytes = 0;
    var removedNames = [];
    var injected = [];
    var parts = [];
    var keptTypes = {};

    var stripExif = mode !== 'tag';
    var stripXmp = mode !== 'tag';
    var stripIcc = mode === 'strict';

    doc.items.forEach(function (item) {
      var remove = webpRemoval(item, mode);
      if (remove) {
        removedBytes += item.size;
        removedNames.push(item.type);
        chunks.push({ name: item.type, size: item.size, status: 'removed', note: item.note || '' });
        return;
      }
      keptTypes[item.type] = 1;
      parts.push(item.raw.subarray(0, item.size));
      chunks.push({ name: item.type, size: item.size, status: 'kept', note: item.note || '' });
    });

    // relationship between requested metadata and VP8X flags
    var addExif = false;
    var addXmp = false;
    var wantsTags = !!(opts.author || opts.copyright || opts.description);

    if (mode === 'tag' && wantsTags) addXmp = true;
    if (mode !== 'tag' && wantsTags) addXmp = true;

    if (addXmp) {
      parts.push(webpChunk('XMP ', utf8(buildXmp(opts))));
      keptTypes['XMP '] = 1;
      injected.push('XMP');
      chunks.push({ name: 'XMP ', size: 0, status: 'added', note: 'Written by MetaShield' });
    }

    // Keep VP8X flags truthful.
    var vp8xIndex = -1;
    for (var i = 0; i < parts.length; i++) {
      if (ascii(parts[i], 0, 4) === 'VP8X') { vp8xIndex = i; break; }
    }

    var needVp8x = !!(keptTypes['ICCP'] || keptTypes['EXIF'] || keptTypes['XMP '] || keptTypes.ANIM || doc.vp8x);
    if (vp8xIndex === -1 && needVp8x && doc.width && doc.height) {
      var vp8x = new Uint8Array(10);
      vp8x[4] = (doc.width - 1) & 0xff;
      vp8x[5] = ((doc.width - 1) >> 8) & 0xff;
      vp8x[6] = ((doc.width - 1) >> 16) & 0xff;
      vp8x[7] = (doc.height - 1) & 0xff;
      vp8x[8] = ((doc.height - 1) >> 8) & 0xff;
      vp8x[9] = ((doc.height - 1) >> 16) & 0xff;
      if (keptTypes.ANIM) vp8x[0] |= 0x02;
      if (keptTypes.ALPH) vp8x[0] |= 0x10;
      if (keptTypes['ICCP']) vp8x[0] |= 0x20;
      if (keptTypes.EXIF) vp8x[0] |= 0x08;
      if (keptTypes['XMP ']) vp8x[0] |= 0x04;
      var vp8xChunk = webpChunk('VP8X', vp8x);
      parts.unshift(vp8xChunk);
      vp8xIndex = 0;
      chunks.push({ name: 'VP8X', size: vp8xChunk.length, status: 'added', note: 'Canvas header for added metadata' });
    } else if (vp8xIndex !== -1) {
      var copy = parts[vp8xIndex].slice(0);
      var flagByte = copy[8];
      if (stripIcc) flagByte &= ~0x20;
      if (stripExif) flagByte &= ~0x08;
      if (stripXmp) flagByte &= ~0x04;
      if (keptTypes['ICCP']) flagByte |= 0x20;
      if (keptTypes.EXIF) flagByte |= 0x08;
      if (keptTypes['XMP ']) flagByte |= 0x04;
      copy[8] = flagByte;
      parts[vp8xIndex] = copy;
    }

    var body = cat(parts);
    var header = new Uint8Array(12);
    header.set(toAsciiBytes('RIFF'), 0);
    new DataView(header.buffer).setUint32(4, body.length + 4, true);
    header.set(toAsciiBytes('WEBP'), 8);

    var out = [header, body];

    var trailerRemoved = 0;
    if (doc.trailer && doc.trailer.length) {
      if (opts.stripTrailer !== false) {
        trailerRemoved = doc.trailer.length;
        removedBytes += trailerRemoved;
        chunks.push({ name: 'Data after RIFF', size: trailerRemoved, status: 'removed', note: 'Appended data outside the WebP stream' });
        removedNames.push('trailing data');
      } else {
        out.push(doc.trailer);
      }
    }

    return {
      bytes: cat(out), chunks: chunks, removedBytes: removedBytes,
      removedNames: removedNames, injected: injected, pixelsIdentical: true
    };
  }

  /* ------------------------------------------------------------------ *
   *  public API
   * ------------------------------------------------------------------ */

  function detect(bytes) {
    if (!bytes || bytes.length < 12) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
    return null;
  }

  function analyze(bytes) {
    var fmt = detect(bytes);
    if (!fmt) return null;
    var doc = fmt === 'jpeg' ? parseJpeg(bytes) : fmt === 'png' ? parsePng(bytes) : parseWebp(bytes);

    var flags = {
      gps: false, camera: false, ai: false, author: false,
      dates: false, icc: !!doc.hasIcc, xmp: !!doc.xmp,
      iptc: !!doc.hasIptc, comment: !!doc.comment, trailer: !!(doc.trailer && doc.trailer.length)
    };

    if (doc.exif) {
      if (doc.exif.gps) flags.gps = true;
      if (doc.exif.make || doc.exif.model) flags.camera = true;
      if (doc.exif.artist || doc.exif.copyright) flags.author = true;
      if (doc.exif.dateTaken || (doc.exif.entries || []).some(function (e) { return e.tag === 0x0132; })) flags.dates = true;
      if (looksLikeAiPrompt(String(doc.exif.software || '')) ||
          looksLikeAiPrompt(String(doc.exif.userComment || '')) ||
          looksLikeAiPrompt(String(doc.exif.description || ''))) flags.ai = true;
    }
    if (doc.aiText) flags.ai = true;
    doc.tags.forEach(function (t) {
      if (looksLikeAiPrompt(t.key + ' ' + t.value)) flags.ai = true;
    });
    if (doc.xmp) {
      if (/dc:creator|photoshop:credit/i.test(doc.xmp)) flags.author = true;
      if (/GPS|exif:GPS/i.test(doc.xmp)) flags.gps = true;
      if (looksLikeAiPrompt(doc.xmp)) flags.ai = true;
    }

    doc.flags = flags;
    doc.risk = riskScore(flags);
    return doc;
  }

  function riskScore(flags) {
    var s = 0;
    if (flags.gps) s += 45;
    if (flags.camera) s += 15;
    if (flags.dates) s += 10;
    if (flags.author) s += 10;
    if (flags.ai) s += 12;
    if (flags.iptc || flags.xmp) s += 5;
    if (flags.comment) s += 3;
    if (flags.trailer) s += 5;
    return Math.min(100, s);
  }

  function riskLabel(score) {
    if (score === 0) return 'no hidden data';
    if (score <= 20) return 'low risk';
    if (score <= 50) return 'medium risk';
    return 'high risk';
  }

  function process(bytes, options) {
    var opts = options || {};
    var doc;
    try {
      doc = analyze(bytes);
    } catch (e) {
      return { ok: false, error: 'This file could not be parsed: ' + e.message };
    }
    if (!doc) {
      return { ok: false, error: 'Only JPG, PNG and WebP images are supported.' };
    }

    var built;
    try {
      if (doc.format === 'jpeg') built = buildJpeg(doc, opts);
      else if (doc.format === 'png') built = buildPng(doc, opts);
      else built = buildWebp(doc, opts);
    } catch (e) {
      return { ok: false, error: 'Cleaning failed: ' + e.message };
    }

    // Re-parse the output and confirm the pixel data survived untouched.
    var check = analyze(built.bytes);
    var pixelsIdentical = !!(check && check.pixelHash === doc.pixelHash);

    var meta = {
      format: doc.format,
      mime: doc.mime,
      width: doc.width,
      height: doc.height,
      originalSize: bytes.length,
      cleanedSize: built.bytes.length,
      tags: doc.tags,
      chunks: built.chunks,
      flags: doc.flags,
      risk: doc.risk,
      riskLabel: riskLabel(doc.risk),
      warnings: doc.warnings.slice(),
      removedBytes: built.removedBytes,
      removedNames: built.removedNames,
      injected: built.injected,
      pixelsIdentical: pixelsIdentical,
      animated: !!doc.animated
    };

    if (!pixelsIdentical && check) {
      meta.warnings.push('Pixel data check did not match \u2014 this file may use an unusual layout.');
    }
    if (check && check.width && doc.width && check.width !== doc.width) {
      meta.warnings.push('Output dimensions differ from the input \u2014 please verify the result.');
    }

    return { ok: true, bytes: built.bytes, meta: meta };
  }

  var api = {
    version: VERSION,
    detect: detect,
    analyze: analyze,
    process: process,
    riskLabel: riskLabel,
    orientationName: function (v) { return ORIENTATION_NAMES[v] || 'Unknown'; }
  };

  g.MetaShield = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
