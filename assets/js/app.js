(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var els = {
    dropzone: $('#dropzone'),
    browseBtn: $('#browseBtn'),
    folderBtn: $('#folderBtn'),
    fileInput: $('#fileInput'),
    folderInput: $('#folderInput'),
    modeGroup: $('#modeGroup'),
    author: $('#author'),
    copyright: $('#copyright'),
    description: $('#description'),
    naming: $('#naming'),
    keepOrientation: $('#keepOrientation'),
    stripTrailer: $('#stripTrailer'),
    applyBtn: $('#applyBtn'),
    results: $('#results'),
    sumFiles: $('#sumFiles'),
    sumRemoved: $('#sumRemoved'),
    sumSaved: $('#sumSaved'),
    sumVerified: $('#sumVerified'),
    zipBtn: $('#zipBtn'),
    shareBtn: $('#shareBtn'),
    clearBtn: $('#clearBtn'),
    progress: $('#progress'),
    progressFill: $('#progressFill'),
    progressText: $('#progressText'),
    fileList: $('#fileList'),
    inspector: $('#inspector'),
    inspectorKind: $('#inspectorKind'),
    inspectorTitle: $('#inspectorTitle'),
    inspectorBody: $('#inspectorBody'),
    inspectorClose: $('#inspectorClose'),
    toast: $('#toast'),
    netPill: $('#netPill'),
    netText: $('#netText'),
    installBtn: $('#installBtn')
  };

  var state = {
    files: [],
    busy: false,
    runId: 0,
    deferredPrompt: null,
    toastTimer: 0
  };

  var SUPPORTED = /\.(jpe?g|png|webp)$/i;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function human(bytes) {
    bytes = Math.max(0, Math.round(bytes || 0));
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function toast(msg, kind) {
    clearTimeout(state.toastTimer);
    els.toast.textContent = msg;
    els.toast.className = 'toast show' + (kind ? ' ' + kind : '');
    state.toastTimer = setTimeout(function () { els.toast.className = 'toast'; }, 3200);
  }

  function readSettings() {
    var modeEl = $('input[name="mode"]:checked', els.modeGroup);
    return {
      mode: modeEl ? modeEl.value : 'smart',
      author: els.author.value.trim(),
      copyright: els.copyright.value.trim(),
      description: els.description.value.trim(),
      naming: els.naming.value,
      keepOrientation: els.keepOrientation.checked,
      stripTrailer: els.stripTrailer.checked
    };
  }

  function outputName(name, naming, used) {
    var dot = name.lastIndexOf('.');
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '';
    if (naming === 'clean') base += '_clean';
    var candidate = base + ext;
    var n = 2;
    while (used[candidate.toLowerCase()]) {
      candidate = base + '-' + n + ext;
      n++;
    }
    used[candidate.toLowerCase()] = true;
    return candidate;
  }

  function readEntryAsync(entry) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(function (f) { resolve([f]); }, function () { resolve([]); });
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var all = [];
        function next() {
          reader.readEntries(function (list) {
            if (!list.length) {
              Promise.all(all.map(readEntryAsync)).then(function (groups) {
                resolve(groups.reduce(function (a, g) { return a.concat(g); }, []));
              });
            } else {
              all = all.concat(Array.prototype.slice.call(list));
              next();
            }
          }, function () { resolve([]); });
        }
        next();
      } else {
        resolve([]);
      }
    });
  }

  function filesFromDrop(dt) {
    var items = dt && dt.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      var entries = [];
      for (var i = 0; i < items.length; i++) {
        var e = items[i].webkitGetAsEntry();
        if (e) entries.push(e);
      }
      if (entries.length) {
        return Promise.all(entries.map(readEntryAsync)).then(function (groups) {
          return groups.reduce(function (a, g) { return a.concat(g); }, []);
        });
      }
    }
    return Promise.resolve(dt ? Array.prototype.slice.call(dt.files || []) : []);
  }

  function addFiles(list) {
    var added = 0;
    var skipped = 0;
    var incoming = Array.prototype.slice.call(list || []);

    incoming.forEach(function (file) {
      if (!file || (!SUPPORTED.test(file.name) && !/^image\/(jpeg|png|webp)$/i.test(file.type))) {
        skipped++;
        return;
      }
      var key = file.name + '|' + file.size + '|' + file.lastModified;
      if (state.files.some(function (r) { return r.key === key; })) return;
      state.files.push({
        id: 'f' + Date.now() + Math.random().toString(36).slice(2, 7),
        key: key,
        file: file,
        name: file.name,
        outName: file.name,
        meta: null,
        result: null,
        error: '',
        thumb: null,
        status: 'pending'
      });
      added++;
    });

    if (added) {
      els.results.hidden = false;
      renderList();
      processAll();
    }
    if (skipped) toast(skipped + (skipped === 1 ? ' file skipped' : ' files skipped') + ' — only JPG, PNG and WebP are supported.', skipped && !added ? 'err' : null);
  }

  function makeThumb(rec) {
    if (!/^image\/(jpeg|png|webp)$/i.test(rec.file.type) && !SUPPORTED.test(rec.name)) return null;
    try { return URL.createObjectURL(rec.file); } catch (e) { return null; }
  }

  function riskClass(score) {
    if (score > 50) return 'high';
    if (score > 20) return 'med';
    return '';
  }

  function renderList() {
    els.fileList.innerHTML = '';
    state.files.forEach(function (rec) {
      var li = document.createElement('li');
      li.className = 'file-item' + (rec.error ? ' error' : '');
      li.dataset.id = rec.id;

      var thumb = document.createElement('div');
      thumb.className = 'file-thumb';
      if (rec.thumb) {
        var img = document.createElement('img');
        img.src = rec.thumb;
        img.alt = '';
        thumb.appendChild(img);
      } else {
        thumb.innerHTML = '<svg class="ico"><use href="#i-image"/></svg>';
      }

      var info = document.createElement('div');
      info.className = 'file-info';
      var name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = rec.name;
      var sub = document.createElement('div');
      sub.className = 'file-sub';

      if (rec.error) {
        sub.innerHTML = '<span class="file-error">' + esc(rec.error) + '</span>';
      } else if (rec.meta) {
        var rc = riskClass(rec.meta.risk);
        var saved = rec.meta.originalSize - rec.meta.cleanedSize;
        sub.innerHTML =
          '<span>' + esc(rec.meta.format.toUpperCase()) + '</span>' +
          '<span class="dotsep"></span>' +
          '<span>' + esc(human(rec.meta.originalSize)) + '</span>' +
          '<span class="dotsep"></span>' +
          '<span class="risk-mini ' + rc + '"><i></i>' + esc(rec.meta.riskLabel) + '</span>' +
          '<span class="dotsep"></span>' +
          '<span>' + (saved >= 0 ? '\u2212' : '+') + esc(human(Math.abs(saved))) + '</span>';
      } else {
        sub.innerHTML = '<span>Queued</span>';
      }
      info.appendChild(name);
      info.appendChild(sub);

      var actions = document.createElement('div');
      actions.className = 'file-actions';
      if (rec.result && rec.meta) {
        actions.innerHTML =
          '<button class="btn btn-ghost btn-sm" data-act="inspect" type="button"><svg class="ico"><use href="#i-eye"/></svg>Inspect</button>' +
          '<button class="btn btn-primary btn-sm" data-act="download" type="button"><svg class="ico"><use href="#i-download"/></svg>Save</button>';
      } else {
        actions.innerHTML = '<span class="pill pill-warn">Processing</span>';
      }

      li.appendChild(thumb);
      li.appendChild(info);
      li.appendChild(actions);
      els.fileList.appendChild(li);
    });
  }

  function refreshSummary() {
    var done = state.files.filter(function (r) { return r.result && r.meta; });
    var totalIn = 0, totalOut = 0, removed = 0, verified = 0;
    done.forEach(function (r) {
      totalIn += r.meta.originalSize;
      totalOut += r.meta.cleanedSize;
      removed += r.meta.removedBytes || 0;
      if (r.meta.pixelsIdentical) verified++;
    });
    els.sumFiles.textContent = state.files.length;
    els.sumRemoved.textContent = human(removed);
    var pct = totalIn ? ((totalIn - totalOut) / totalIn) * 100 : 0;
    els.sumSaved.textContent = (pct >= 0 ? '' : '+') + Math.abs(pct).toFixed(1) + '%';
    var ok = done.length > 0 && verified === done.length;
    els.sumVerified.parentElement.classList.toggle('bad', !ok);
    els.sumVerified.textContent = ok ? 'Pixel check passed' : (done.length ? 'Check some files' : 'Awaiting files');
    els.zipBtn.disabled = done.length === 0;
    els.shareBtn.disabled = done.length === 0;
  }

  function updateProgress(done, total) {
    els.progress.hidden = false;
    els.progressFill.style.width = (total ? (done / total) * 100 : 0) + '%';
    els.progressText.textContent = done + ' / ' + total;
  }

  function processAll() {
    if (state.busy) return;
    var opts = readSettings();
    var run = ++state.runId;
    var used = {};

    state.files.forEach(function (rec) {
      rec.outName = outputName(rec.name, opts.naming, used);
      rec.result = null;
      rec.meta = null;
      rec.error = '';
      rec.status = 'pending';
      if (!rec.thumb) rec.thumb = makeThumb(rec);
    });

    state.busy = true;
    els.applyBtn.disabled = true;
    renderList();
    refreshSummary();
    updateProgress(0, state.files.length);

    (async function () {
      for (var i = 0; i < state.files.length; i++) {
        if (run !== state.runId) return;
        var rec = state.files[i];
        try {
          var buf = await rec.file.arrayBuffer();
          var res = MetaShield.process(new Uint8Array(buf), opts);
          if (!res.ok) throw new Error(res.error || 'Could not clean this file.');
          rec.result = res;
          rec.meta = res.meta;
          rec.status = 'done';
        } catch (err) {
          rec.error = err && err.message ? err.message : String(err);
          rec.status = 'error';
        }
        renderList();
        refreshSummary();
        updateProgress(i + 1, state.files.length);
        await new Promise(function (r) { setTimeout(r, 0); });
      }
      state.busy = false;
      els.applyBtn.disabled = false;
      if (run === state.runId) {
        var failed = state.files.filter(function (r) { return r.error; }).length;
        if (failed) toast('Done — ' + failed + ' file' + (failed === 1 ? '' : 's') + ' could not be cleaned.', 'err');
        else toast('All ' + state.files.length + ' file' + (state.files.length === 1 ? '' : 's') + ' cleaned.', 'ok');
      }
    })();
  }

  function clearedFiles() {
    return state.files.filter(function (r) { return r.result && r.meta; });
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function downloadOne(rec) {
    if (!rec.result) return;
    var blob = new Blob([rec.result.bytes], { type: rec.meta.mime || 'application/octet-stream' });
    downloadBlob(blob, rec.outName);
    toast('Saved ' + rec.outName, 'ok');
  }

  function downloadZip() {
    var ready = clearedFiles();
    if (!ready.length) return;
    if (!window.MetaShieldZip) { toast('ZIP writer is not available.', 'err'); return; }
    var data = ready.map(function (r) { return { name: r.outName, data: r.result.bytes }; });
    try {
      var zip = MetaShieldZip.build(data);
      downloadBlob(new Blob([zip], { type: 'application/zip' }), 'metashield-cleaned.zip');
      toast('Downloaded ' + ready.length + ' cleaned files as a ZIP.', 'ok');
    } catch (e) {
      toast('Could not build the ZIP: ' + e.message, 'err');
    }
  }

  async function shareAll() {
    var ready = clearedFiles();
    if (!ready.length) return;
    if (!navigator.share) { toast('Sharing is not supported in this browser — use Download all instead.', 'err'); return; }
    try {
      var files = ready.map(function (r) {
        return new File([r.result.bytes], r.outName, { type: r.meta.mime || 'application/octet-stream' });
      });
      var payload = { files: files, title: 'Cleaned images', text: 'Metadata stripped with Antigle MetaShield' };
      if (navigator.canShare && !navigator.canShare(payload)) {
        toast('This browser cannot share these files.', 'err');
        return;
      }
      await navigator.share(payload);
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Share failed: ' + (e.message || 'unknown error'), 'err');
    }
  }

  function buildReport(rec) {
    var m = rec.meta;
    var lines = [];
    lines.push('ANTIGLE METASHIELD — CLEANING REPORT');
    lines.push('File: ' + rec.name);
    lines.push('Saved as: ' + rec.outName);
    lines.push('Format: ' + String(m.format).toUpperCase() + (m.width ? '  ' + m.width + ' \u00d7 ' + m.height : ''));
    lines.push('Privacy risk: ' + m.risk + '/100 (' + m.riskLabel + ')');
    lines.push('Original size: ' + human(m.originalSize));
    lines.push('Cleaned size: ' + human(m.cleanedSize));
    lines.push('Metadata removed: ' + human(m.removedBytes || 0));
    lines.push('Pixels identical: ' + (m.pixelsIdentical ? 'YES' : 'NO'));
    if (m.removedNames && m.removedNames.length) lines.push('Removed: ' + m.removedNames.join(', '));
    if (m.injected && m.injected.length) lines.push('Written: ' + m.injected.join(', '));
    lines.push('');
    lines.push('TAGS / VALUES');
    if (m.tags && m.tags.length) {
      m.tags.forEach(function (t) { lines.push('[' + t.group + '] ' + t.key + ': ' + t.value); });
    } else lines.push('(none found)');
    lines.push('');
    lines.push('SEGMENTS / CHUNKS');
    if (m.chunks && m.chunks.length) {
      m.chunks.forEach(function (c) {
        lines.push(c.status.toUpperCase() + '  ' + c.name + '  ' + human(c.size) + (c.note ? '  — ' + c.note : ''));
      });
    } else lines.push('(none)');
    if (m.warnings && m.warnings.length) {
      lines.push('');
      lines.push('WARNINGS');
      m.warnings.forEach(function (w) { lines.push('! ' + w); });
    }
    return lines.join('\n');
  }

  function copyReport(rec) {
    var text = buildReport(rec);
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Report copied to clipboard.', 'ok'); }
      catch (e) { toast('Could not copy the report.', 'err'); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('Report copied to clipboard.', 'ok');
      }, fallback);
    } else fallback();
  }

  function openInspector(rec) {
    var m = rec.meta;
    if (!m) return;
    els.inspectorKind.textContent = 'Inspector · ' + String(m.format).toUpperCase();
    els.inspectorTitle.textContent = rec.name;

    var html = '';
    html += '<div class="insp-block"><div class="insp-risk">' +
      '<div class="big">' + esc(m.risk) + '<span>/100</span></div>' +
      '<div style="flex:1"><div style="font-size:.8rem;font-weight:600;margin-bottom:7px">Privacy risk — ' + esc(m.riskLabel) + '</div>' +
      '<div class="risk-bar"><span style="width:' + Math.max(0, Math.min(100, m.risk)) + '%"></span></div></div></div></div>';

    html += '<div class="insp-block"><h4>File</h4><div class="insp-grid">' +
      '<div class="insp-stat"><b>' + esc(m.format.toUpperCase()) + '</b><span>Format</span></div>' +
      '<div class="insp-stat"><b>' + esc(m.width ? m.width + ' \u00d7 ' + m.height : '\u2014') + '</b><span>Dimensions</span></div>' +
      '<div class="insp-stat"><b>' + esc(human(m.originalSize)) + '</b><span>Original size</span></div>' +
      '<div class="insp-stat"><b>' + esc(human(m.cleanedSize)) + '</b><span>Cleaned size</span></div>' +
      '</div></div>';

    if (m.warnings && m.warnings.length) {
      html += '<div class="insp-block"><h4>Warnings</h4>';
      m.warnings.forEach(function (w) {
        html += '<div class="insp-warn"><svg class="ico"><use href="#i-warn"/></svg><span>' + esc(w) + '</span></div>';
      });
      html += '</div>';
    }

    html += '<div class="insp-block"><h4>Metadata tags (' + (m.tags ? m.tags.length : 0) + ')</h4>';
    if (m.tags && m.tags.length) {
      html += '<table class="insp-table"><thead><tr><th>Group</th><th>Tag</th><th>Value</th></tr></thead><tbody>';
      m.tags.forEach(function (t) {
        html += '<tr><td class="g">' + esc(t.group) + '</td><td>' + esc(t.key) + '</td><td class="v">' + esc(t.value) + '</td></tr>';
      });
      html += '</tbody></table>';
    } else html += '<div class="insp-empty">No readable metadata tags were found.</div>';
    html += '</div>';

    html += '<div class="insp-block"><h4>Segments &amp; chunks</h4>';
    if (m.chunks && m.chunks.length) {
      html += '<table class="insp-table"><thead><tr><th>Segment</th><th>Status</th><th>Size</th><th>Note</th></tr></thead><tbody>';
      m.chunks.forEach(function (c) {
        html += '<tr><td>' + esc(c.name) + '</td><td><span class="status-tag ' + esc(c.status) + '">' + esc(c.status) + '</span></td>' +
          '<td>' + esc(human(c.size)) + '</td><td class="v">' + esc(c.note || '') + '</td></tr>';
      });
      html += '</tbody></table>';
    } else html += '<div class="insp-empty">No segment details available.</div>';
    html += '</div>';

    html += '<div class="insp-block"><div class="insp-verified' + (m.pixelsIdentical ? '' : ' bad') + '">' +
      '<svg class="ico"><use href="#i-' + (m.pixelsIdentical ? 'check' : 'warn') + '"/></svg>' +
      esc(m.pixelsIdentical ? 'Pixel data verified byte-identical to the original' : 'Pixel check did not match — please verify this file') +
      '</div></div>';

    html += '<div class="insp-actions">' +
      '<button class="btn btn-primary btn-sm" type="button" data-ins="download"><svg class="ico"><use href="#i-download"/></svg>Save cleaned file</button>' +
      '<button class="btn btn-soft btn-sm" type="button" data-ins="copy"><svg class="ico"><use href="#i-tag"/></svg>Copy report</button>' +
      '</div>';

    els.inspectorBody.innerHTML = html;
    els.inspectorBody._rec = rec;
    els.inspector.hidden = false;
    els.inspector.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    els.inspectorClose.focus();
  }

  function closeInspector() {
    els.inspector.hidden = true;
    els.inspector.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  function clearAll() {
    state.files.forEach(function (r) { if (r.thumb) URL.revokeObjectURL(r.thumb); });
    state.files = [];
    state.runId++;
    els.fileList.innerHTML = '';
    els.results.hidden = true;
    els.progress.hidden = true;
    refreshSummary();
    toast('Cleared. Nothing was uploaded or stored.', 'ok');
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      clearTimeout(t);
      var args = arguments;
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  var rerun = debounce(function () { if (state.files.length) processAll(); }, 450);

  function updateNetPill() {
    var online = navigator.onLine !== false;
    els.netPill.classList.toggle('offline', !online);
    els.netText.textContent = online ? 'On-device' : 'Offline ready';
  }

  els.browseBtn.addEventListener('click', function (e) { e.stopPropagation(); els.fileInput.click(); });
  els.folderBtn.addEventListener('click', function (e) { e.stopPropagation(); els.folderInput.click(); });
  els.dropzone.addEventListener('click', function () { els.fileInput.click(); });
  els.dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
  });

  ['dragenter', 'dragover'].forEach(function (evt) {
    els.dropzone.addEventListener(evt, function (e) { e.preventDefault(); e.stopPropagation(); els.dropzone.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    els.dropzone.addEventListener(evt, function (e) { e.preventDefault(); e.stopPropagation(); els.dropzone.classList.remove('drag'); });
  });
  els.dropzone.addEventListener('drop', function (e) {
    filesFromDrop(e.dataTransfer).then(addFiles);
  });

  els.fileInput.addEventListener('change', function () { addFiles(els.fileInput.files); els.fileInput.value = ''; });
  els.folderInput.addEventListener('change', function () { addFiles(els.folderInput.files); els.folderInput.value = ''; });
  els.applyBtn.addEventListener('click', function () { if (state.files.length) processAll(); else toast('Add some images first.'); });

  [els.author, els.copyright, els.description].forEach(function (el) { el.addEventListener('input', rerun); });
  [els.naming, els.keepOrientation, els.stripTrailer].forEach(function (el) { el.addEventListener('change', rerun); });
  $$('input[name="mode"]', els.modeGroup).forEach(function (el) { el.addEventListener('change', rerun); });

  els.fileList.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var id = btn.closest('.file-item').dataset.id;
    var rec = state.files.filter(function (r) { return r.id === id; })[0];
    if (!rec) return;
    if (btn.dataset.act === 'inspect') openInspector(rec);
    if (btn.dataset.act === 'download') downloadOne(rec);
  });

  els.zipBtn.addEventListener('click', downloadZip);
  els.shareBtn.addEventListener('click', shareAll);
  els.clearBtn.addEventListener('click', clearAll);
  els.inspectorClose.addEventListener('click', closeInspector);
  $('.modal-backdrop', els.inspector).addEventListener('click', closeInspector);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !els.inspector.hidden) closeInspector();
  });
  els.inspectorBody.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-ins]');
    if (!btn) return;
    var rec = els.inspectorBody._rec;
    if (!rec) return;
    if (btn.dataset.ins === 'download') downloadOne(rec);
    if (btn.dataset.ins === 'copy') copyReport(rec);
  });

  window.addEventListener('online', updateNetPill);
  window.addEventListener('offline', updateNetPill);

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    state.deferredPrompt = e;
    els.installBtn.hidden = false;
  });
  els.installBtn.addEventListener('click', function () {
    if (!state.deferredPrompt) return;
    state.deferredPrompt.prompt();
    state.deferredPrompt.userChoice.then(function () {
      state.deferredPrompt = null;
      els.installBtn.hidden = true;
    });
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  updateNetPill();
  refreshSummary();
})();
