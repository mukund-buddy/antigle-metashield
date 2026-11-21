/*!
 * Antigle MetaShield — minimal ZIP writer (STORE only, no dependencies)
 * Images are already compressed, so storing them costs nothing extra and
 * keeps the app fully offline: no CDN, no third-party library.
 */
(function (g) {
  'use strict';

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

  function dosTime(d) {
    return ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  }

  function u16(view, off, v) { view.setUint16(off, v, true); }
  function u32(view, off, v) { view.setUint32(off, v, true); }

  /**
   * files: [{ name: 'photo_clean.jpg', data: Uint8Array }]
   * returns Uint8Array of a valid .zip
   */
  function build(files) {
    var encoder = new TextEncoder();
    var now = new Date();
    var time = dosTime(now);
    var date = dosDate(now);
    var parts = [];
    var central = [];
    var offset = 0;

    files.forEach(function (f) {
      var nameBytes = encoder.encode(f.name);
      var data = f.data;
      var crc = crc32(data);

      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      u32(lv, 0, 0x04034b50);
      u16(lv, 4, 20);
      u16(lv, 6, 0x0800);          // UTF-8 names
      u16(lv, 8, 0);               // stored
      u16(lv, 10, time);
      u16(lv, 12, date);
      u32(lv, 14, crc);
      u32(lv, 18, data.length);
      u32(lv, 22, data.length);
      u16(lv, 26, nameBytes.length);
      u16(lv, 28, 0);
      local.set(nameBytes, 30);

      parts.push(local, data);

      var cd = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cd.buffer);
      u32(cv, 0, 0x02014b50);
      u16(cv, 4, 20);
      u16(cv, 6, 20);
      u16(cv, 8, 0x0800);
      u16(cv, 10, 0);
      u16(cv, 12, time);
      u16(cv, 14, date);
      u32(cv, 16, crc);
      u32(cv, 20, data.length);
      u32(cv, 24, data.length);
      u16(cv, 28, nameBytes.length);
      u16(cv, 30, 0);
      u16(cv, 32, 0);
      u16(cv, 34, 0);
      u16(cv, 36, 0);
      u32(cv, 38, 0);
      u32(cv, 42, offset);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + data.length;
    });

    var centralSize = 0;
    central.forEach(function (c) { centralSize += c.length; });

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    u32(ev, 0, 0x06054b50);
    u16(ev, 4, 0);
    u16(ev, 6, 0);
    u16(ev, 8, files.length);
    u16(ev, 10, files.length);
    u32(ev, 12, centralSize);
    u32(ev, 16, offset);
    u16(ev, 20, 0);

    var all = parts.concat(central, [eocd]);
    var total = 0;
    all.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total);
    var at = 0;
    all.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  g.MetaShieldZip = { build: build, crc32: crc32 };
  if (typeof module === 'object' && module.exports) module.exports = g.MetaShieldZip;
})(typeof globalThis !== 'undefined' ? globalThis : this);
