/* Ayah Splitter */
const API = '';

// ── State ───────────────────────────────────────────────────────────
let currentSurah = null;
let currentTimings = [];
let currentSilences = [];
let currentAyahText = {};
let waveformData = [];
let durationMs = 0;
let surahs = [];
let uploadedFiles = [];
let dragMarker = null;
let zoomLevel = 1;
let trimStartMs = 0;
let trimEndMs = 0;

const audioPlayer = document.getElementById('audio-player');
const waveformCanvas = document.getElementById('waveform-canvas');
const markersOverlay = document.getElementById('markers-overlay');
const playhead = document.getElementById('playhead');
const ctx = waveformCanvas.getContext('2d');

// ── IndexedDB for audio blobs ───────────────────────────────────────
const DB_NAME = 'AyahSplitterDB';
const DB_VERSION = 1;
const AUDIO_STORE = 'audioFiles';

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveAudioBlob(surahNum, blob) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).put(blob, surahNum);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAudioBlob(surahNum) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readonly');
    const req = tx.objectStore(AUDIO_STORE).get(surahNum);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteAudioBlob(surahNum) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).delete(surahNum);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAllAudioBlobs() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── localStorage helpers ────────────────────────────────────────────
const LS_KEY = 'ayahSplitter_timings';

function loadAllTimingsFromLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
  catch { return {}; }
}

function saveTimingsToLocal(surahNum, timings, trim) {
  const all = loadAllTimingsFromLocal();
  all[surahNum] = { timings, trim: trim || { start: 0, end: 0 }, savedAt: Date.now() };
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}

function getSavedSurahs() {
  return Object.keys(loadAllTimingsFromLocal()).map(Number).sort((a, b) => a - b);
}

function clearAllTimingsLocal() {
  localStorage.removeItem(LS_KEY);
}

// ── Init ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadMetadata();
  setupDropZone();
  setupAudioEvents();
  setupWaveformInteraction();
  updateSavedSummary();
});

async function loadMetadata() {
  const res = await fetch(`${API}/api/metadata`);
  const data = await res.json();
  surahs = data.surahs;
  ['surah-select', 'upload-surah-select'].forEach(id => {
    const sel = document.getElementById(id);
    surahs.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.number;
      opt.textContent = `${s.number}. ${s.name} (${s.ayah_count} ayahs)`;
      sel.appendChild(opt);
    });
  });
}

function togglePreferences() { document.getElementById('preferences-panel').classList.toggle('hidden'); }

// ── Upload ──────────────────────────────────────────────────────────
function setupDropZone() {
  const dz = document.getElementById('drop-zone');
  const fi = document.getElementById('file-input');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });
  fi.addEventListener('change', () => { handleFiles(fi.files); fi.value = ''; });
  document.getElementById('single-file-input').addEventListener('change', function() { handleSingleFile(this.files[0]); this.value = ''; });
}

async function handleSingleFile(file) {
  if (!file) return;
  const surahNum = parseInt(document.getElementById('upload-surah-select').value);
  if (!surahNum) { showToast('Select a surah first', 'error'); return; }

  // Save to IndexedDB
  const blob = new Blob([await file.arrayBuffer()], { type: 'audio/mpeg' });
  await saveAudioBlob(surahNum, blob);

  // Upload to server
  const fd = new FormData();
  fd.append('file', file);
  fd.append('surah_number', surahNum);
  const res = await fetch(`${API}/api/upload`, { method: 'POST', body: fd });
  const data = await res.json();
  if (data.success) {
    addUploadedFile(surahNum, data.surah_name, data.size_mb);
    showToast(`Uploaded ${data.surah_name}`, 'success');
    // Auto-select in editor
    document.getElementById('surah-select').value = surahNum;
    loadSurah(surahNum);
  } else { showToast(data.error || 'Upload failed', 'error'); }
}

async function handleFiles(files) {
  const fd = new FormData(); let n = 0;
  for (const f of files) {
    if (!f.name.endsWith('.mp3')) continue;
    fd.append('files', f);
    // Also cache in IndexedDB
    const base = f.name.replace('.mp3', '');
    const num = parseInt(base);
    if (num >= 1 && num <= 114) {
      const blob = new Blob([await f.arrayBuffer()], { type: 'audio/mpeg' });
      await saveAudioBlob(num, blob);
    }
    n++;
  }
  if (!n) { showToast('No MP3 files', 'error'); return; }
  showToast(`Uploading ${n} file(s)...`, 'info');
  const res = await fetch(`${API}/api/upload-folder`, { method: 'POST', body: fd });
  const data = await res.json();
  if (data.success) { showToast(`Uploaded ${data.uploaded_surahs.length} surah(s)`, 'success'); await refreshUploadedList(); }
}

function addUploadedFile(surah, name, size_mb) {
  uploadedFiles = uploadedFiles.filter(f => f.surah !== surah);
  uploadedFiles.push({ surah, name, size_mb, status: 'uploaded' });
  uploadedFiles.sort((a, b) => a.surah - b.surah);
  renderUploadedList();
}

async function refreshUploadedList() {
  const res = await fetch(`${API}/api/uploaded-surahs`);
  const data = await res.json();
  uploadedFiles = data.surahs.map(s => ({ surah: s.surah, name: s.name, size_mb: s.size_mb, status: s.analyzed ? 'analyzed' : 'uploaded' }));
  renderUploadedList();
}

function renderUploadedList() {
  const list = document.getElementById('uploaded-list');
  const bar = document.getElementById('upload-status');
  if (!uploadedFiles.length) { list.classList.add('hidden'); bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  document.getElementById('upload-count').textContent = `${uploadedFiles.length} file(s)`;
  list.classList.remove('hidden');
  list.innerHTML = uploadedFiles.map(f => {
    const cls = f.status === 'analyzing' ? 'analyzing' : f.status === 'analyzed' ? 'analyzed' : 'pending';
    const txt = f.status === 'analyzing' ? '<span class="spinner"></span> Analyzing...' : f.status === 'analyzed' ? 'Analyzed' : 'Ready';
    return `<div class="file-item"><span>${f.surah}. ${f.name} (${f.size_mb} MB)</span><span class="file-status ${cls}">${txt}</span></div>`;
  }).join('');
}

function setFileStatus(s, st) { const f = uploadedFiles.find(x => x.surah === s); if (f) { f.status = st; renderUploadedList(); } }

// ── Surah Editor ────────────────────────────────────────────────────
async function loadSurah(surahNum) {
  if (!surahNum) { document.getElementById('editor-content').classList.add('hidden'); return; }
  surahNum = parseInt(surahNum);
  currentSurah = surahNum;
  currentTimings = []; currentSilences = []; currentAyahText = {};
  trimStartMs = 0; trimEndMs = 0;
  document.getElementById('trim-start').value = 0;
  document.getElementById('trim-end').value = 0;

  // Check if we have saved timings in localStorage
  const saved = loadAllTimingsFromLocal()[surahNum];

  const waveRes = await fetch(`${API}/api/waveform/${surahNum}?points=2000`);
  if (!waveRes.ok) { showToast('Audio not found. Upload first.', 'error'); return; }
  const wd = await waveRes.json();
  waveformData = wd.waveform; durationMs = wd.duration_ms;

  audioPlayer.src = `${API}/api/audio/${surahNum}`;

  const info = surahs.find(s => s.number === surahNum);
  document.getElementById('editor-surah-name').textContent = `${surahNum}. ${info.name}`;
  document.getElementById('editor-ayah-count').textContent = `${info.ayah_count} ayahs`;
  document.getElementById('editor-duration').textContent = formatTime(durationMs);

  const badge = document.getElementById('editor-basmallah');
  badge.textContent = ''; badge.className = 'basmallah-badge';

  zoomLevel = 1; document.getElementById('zoom-level').textContent = '100%';
  document.getElementById('btn-analyze-surah').disabled = false;
  document.getElementById('editor-content').classList.remove('hidden');

  // Show saved indicator
  const si = document.getElementById('saved-indicator');
  if (saved) {
    si.classList.remove('hidden');
    // Load saved timings + trim
    currentTimings = saved.timings;
    if (saved.trim) {
      trimStartMs = saved.trim.start || 0;
      trimEndMs = saved.trim.end || 0;
      document.getElementById('trim-start').value = trimStartMs;
      document.getElementById('trim-end').value = trimEndMs;
    }
    renderWaveform(); renderMarkers(); renderTimingTable(); updateTrimOverlays();
  } else {
    si.classList.add('hidden');
    markersOverlay.innerHTML = '';
    document.getElementById('timing-tbody').innerHTML =
      '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:1.5rem">Click "Analyze" to detect ayah boundaries</td></tr>';
    renderWaveform(); updateTrimOverlays();
  }
}

async function analyzeCurrent() {
  if (!currentSurah) return;
  const btn = document.getElementById('btn-analyze-surah');
  btn.disabled = true; btn.textContent = 'Analyzing...';
  setFileStatus(currentSurah, 'analyzing');

  try {
    const res = await fetch(`${API}/api/analyze/${currentSurah}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trim_start_ms: trimStartMs, trim_end_ms: trimEndMs }),
    });
    if (!res.ok) { showToast('Analysis failed', 'error'); setFileStatus(currentSurah, 'uploaded'); return; }

    const d = await res.json();
    currentTimings = d.timings; currentSilences = d.silences || []; currentAyahText = d.ayah_text || {};

    if (d.basmallah_detected != null) {
      showToast(d.basmallah_detected ? 'Basmallah detected' : 'No Basmallah detected', d.basmallah_detected ? 'success' : 'info');
    }

    if (!Object.keys(currentAyahText).length) {
      const tr = await fetch(`${API}/api/text/${currentSurah}`);
      if (tr.ok) { const td = await tr.json(); if (td.available) currentAyahText = td.ayahs; }
    }

    const badge = document.getElementById('editor-basmallah');
    if (d.basmallah_detected === true) { badge.textContent = 'Basmallah detected'; badge.className = 'basmallah-badge detected'; }
    else if (d.basmallah_detected === false) { badge.textContent = 'No Basmallah'; badge.className = 'basmallah-badge not-detected'; }

    setFileStatus(currentSurah, 'analyzed');
    renderWaveform(); renderMarkers(); renderTimingTable(); updateTrimOverlays();
  } catch (e) { showToast('Error: ' + e.message, 'error'); setFileStatus(currentSurah, 'uploaded'); }
  finally { btn.disabled = false; btn.textContent = 'Analyze'; }
}

// ── Save to localStorage ────────────────────────────────────────────
function saveToLocal() {
  if (!currentSurah || !currentTimings.length) { showToast('Nothing to save', 'error'); return; }
  saveTimingsToLocal(currentSurah, currentTimings, { start: trimStartMs, end: trimEndMs });
  document.getElementById('saved-indicator').classList.remove('hidden');
  updateSavedSummary();
  showToast(`Surah ${currentSurah} saved`, 'success');
}

function updateSavedSummary() {
  const saved = getSavedSurahs();
  const el = document.getElementById('saved-surahs-summary');
  if (!saved.length) { el.innerHTML = '<span style="color:var(--text-dim)">No surahs saved yet. Analyze and save surahs above.</span>'; return; }
  el.innerHTML = `<strong>${saved.length}</strong> surah(s) ready to export: ` +
    saved.map(n => `<span class="surah-chip">${n}. ${surahs.find(s=>s.number===n)?.name||n}</span>`).join('');
}

function clearAllLocal() {
  if (!confirm('Clear all saved timings and cached audio?')) return;
  clearAllTimingsLocal();
  clearAllAudioBlobs();
  updateSavedSummary();
  document.getElementById('saved-indicator').classList.add('hidden');
  showToast('All data cleared', 'info');
}

// ── Trim ────────────────────────────────────────────────────────────
function onTrimChange() {
  trimStartMs = parseInt(document.getElementById('trim-start').value) || 0;
  trimEndMs = parseInt(document.getElementById('trim-end').value) || 0;
  updateTrimOverlays();
}

function updateTrimOverlays() {
  if (!durationMs) return;
  const sl = document.getElementById('trim-start-overlay');
  const sr = document.getElementById('trim-end-overlay');
  sl.style.width = `${(trimStartMs / durationMs) * 100}%`;
  sr.style.width = `${(trimEndMs / durationMs) * 100}%`;
}

// ── Zoom ────────────────────────────────────────────────────────────
function zoomIn() { setZoom(Math.min(zoomLevel * 1.5, 30)); }
function zoomOut() { setZoom(Math.max(zoomLevel / 1.5, 1)); }
function zoomReset() { setZoom(1); }
function setZoom(l) { zoomLevel = l; document.getElementById('zoom-level').textContent = `${Math.round(l*100)}%`; renderWaveform(); renderMarkers(); updateTrimOverlays(); scrollToPlayhead(); }
function scrollToPlayhead() {
  const sc = document.getElementById('waveform-scroll');
  const ct = document.getElementById('waveform-container');
  if (!sc || !ct) return;
  const px = (audioPlayer.currentTime * 1000 / durationMs) * ct.offsetWidth;
  sc.scrollLeft = px - sc.clientWidth / 2;
}

// ── Waveform ────────────────────────────────────────────────────────
function renderWaveform() {
  const sc = document.getElementById('waveform-scroll');
  const ct = document.getElementById('waveform-container');
  const vw = sc.clientWidth;
  const tw = vw * zoomLevel;
  ct.style.width = `${tw}px`;
  const dpr = window.devicePixelRatio || 1;
  const h = 170;
  waveformCanvas.width = tw * dpr; waveformCanvas.height = h * dpr;
  waveformCanvas.style.width = `${tw}px`; waveformCanvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const mid = h / 2, bw = tw / waveformData.length;
  ctx.fillStyle = '#0f1117'; ctx.fillRect(0, 0, tw, h);
  ctx.fillStyle = 'rgba(56,217,169,0.08)';
  for (const [s, e] of currentSilences) { ctx.fillRect((s/durationMs)*tw, 0, ((e-s)/durationMs)*tw, h); }
  ctx.fillStyle = '#4f8cff';
  for (let i = 0; i < waveformData.length; i++) { const bh = waveformData[i]*(h*0.8); ctx.fillRect(i*bw, mid-bh/2, Math.max(bw-0.5,0.5), bh); }
}

// ── Markers ─────────────────────────────────────────────────────────
function renderMarkers() {
  markersOverlay.innerHTML = '';
  for (let i = 0; i < currentTimings.length; i++) {
    const t = currentTimings[i]; if (t.ayah === 999) continue;
    const mk = document.createElement('div'); mk.className = 'marker';
    mk.style.left = `${(t.time/durationMs)*100}%`; mk.dataset.index = i;
    const lb = document.createElement('div'); lb.className = 'marker-label';
    lb.textContent = t.ayah === 0 ? 'Bsm' : `${t.ayah}`; mk.appendChild(lb);
    mk.addEventListener('mousedown', startDrag);
    mk.addEventListener('touchstart', startDragTouch, { passive: false });
    markersOverlay.appendChild(mk);
  }
}
function startDrag(e) { e.preventDefault(); dragMarker = e.currentTarget; dragMarker.classList.add('dragging'); document.addEventListener('mousemove', onDrag); document.addEventListener('mouseup', endDrag); }
function startDragTouch(e) { e.preventDefault(); dragMarker = e.currentTarget; dragMarker.classList.add('dragging'); document.addEventListener('touchmove', onDragTouch, {passive:false}); document.addEventListener('touchend', endDragTouch); }
function onDrag(e) { if (dragMarker) updateMarkerPos(e.clientX); }
function onDragTouch(e) { if (dragMarker) { e.preventDefault(); updateMarkerPos(e.touches[0].clientX); } }
function updateMarkerPos(cx) {
  const ct = document.getElementById('waveform-container');
  const r = ct.getBoundingClientRect();
  let pct = Math.max(0, Math.min(100, ((cx - r.left) / ct.offsetWidth) * 100));
  dragMarker.style.left = `${pct}%`;
  const idx = parseInt(dragMarker.dataset.index);
  currentTimings[idx].time = Math.round((pct/100)*durationMs);
  updateTimingRow(idx, currentTimings[idx].time);
}
function endDrag() { if (dragMarker) dragMarker.classList.remove('dragging'); dragMarker = null; document.removeEventListener('mousemove', onDrag); document.removeEventListener('mouseup', endDrag); }
function endDragTouch() { if (dragMarker) dragMarker.classList.remove('dragging'); dragMarker = null; document.removeEventListener('touchmove', onDragTouch); document.removeEventListener('touchend', endDragTouch); }

// ── Waveform Click + Wheel ──────────────────────────────────────────
function setupWaveformInteraction() {
  const ct = document.getElementById('waveform-container');
  const sc = document.getElementById('waveform-scroll');
  ct.addEventListener('click', e => { if (dragMarker) return; audioPlayer.currentTime = ((e.clientX - ct.getBoundingClientRect().left) / ct.offsetWidth) * (durationMs/1000); });
  sc.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(Math.max(1, Math.min(30, zoomLevel * (e.deltaY > 0 ? 0.8 : 1.25)))); } }, { passive: false });
  window.addEventListener('resize', () => { if (waveformData.length) { renderWaveform(); renderMarkers(); updateTrimOverlays(); } });
}

// ── Audio ───────────────────────────────────────────────────────────
function setupAudioEvents() {
  audioPlayer.addEventListener('timeupdate', () => { updatePlayhead(); updateTimeDisplay(); highlightActiveRow(); });
  audioPlayer.addEventListener('play', () => { playhead.style.display = 'block'; document.getElementById('btn-play').textContent = 'Pause'; });
  audioPlayer.addEventListener('pause', () => { document.getElementById('btn-play').textContent = 'Play'; });
  audioPlayer.addEventListener('ended', () => { playhead.style.display = 'none'; document.getElementById('btn-play').textContent = 'Play'; });
}
function togglePlay() { audioPlayer.paused ? audioPlayer.play() : audioPlayer.pause(); }
function stopAudio() { audioPlayer.pause(); audioPlayer.currentTime = 0; playhead.style.display = 'none'; document.getElementById('btn-play').textContent = 'Play'; document.getElementById('current-ayah-label').textContent = ''; }
function setPlaybackSpeed(v) { audioPlayer.playbackRate = parseFloat(v); }

function prevAyah() {
  if (!currentTimings.length) return;
  const ms = audioPlayer.currentTime * 1000;
  for (let i = currentTimings.length - 1; i >= 0; i--) {
    if (currentTimings[i].ayah !== 999 && currentTimings[i].time < ms - 500) {
      audioPlayer.currentTime = currentTimings[i].time / 1000; scrollToPlayhead(); return;
    }
  }
  audioPlayer.currentTime = 0;
}
function nextAyah() {
  if (!currentTimings.length) return;
  const ms = audioPlayer.currentTime * 1000;
  for (let i = 0; i < currentTimings.length; i++) {
    if (currentTimings[i].ayah !== 999 && currentTimings[i].time > ms + 200) {
      audioPlayer.currentTime = currentTimings[i].time / 1000; scrollToPlayhead(); return;
    }
  }
}

function updatePlayhead() {
  const pct = (audioPlayer.currentTime * 1000 / durationMs) * 100;
  playhead.style.left = `${pct}%`;
  if (!audioPlayer.paused && zoomLevel > 1) {
    const sc = document.getElementById('waveform-scroll');
    const ct = document.getElementById('waveform-container');
    const px = (pct/100) * ct.offsetWidth;
    if (px < sc.scrollLeft + 40 || px > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = px - sc.clientWidth / 2;
  }
}
function updateTimeDisplay() { document.getElementById('audio-time').textContent = `${formatTime(audioPlayer.currentTime*1000)} / ${formatTime(durationMs)}`; }
function highlightActiveRow() {
  const ms = audioPlayer.currentTime * 1000;
  const rows = document.querySelectorAll('#timing-tbody tr');
  let ai = 0;
  for (let i = currentTimings.length-1; i >= 0; i--) { if (currentTimings[i].ayah !== 999 && ms >= currentTimings[i].time) { ai = i; break; } }
  rows.forEach((r, i) => r.classList.toggle('active-row', i === ai));
  const a = currentTimings[ai]?.ayah;
  document.getElementById('current-ayah-label').textContent = a != null && a !== 999 ? (a === 0 ? 'Basmallah' : `Ayah ${a}`) : '';
}

// ── Timing Table ────────────────────────────────────────────────────
function renderTimingTable() {
  const tb = document.getElementById('timing-tbody'); tb.innerHTML = '';
  currentTimings.forEach((t, idx) => {
    const tr = document.createElement('tr');
    if (t.ayah === 0 || t.ayah === 999) tr.className = 'special-row';
    const lbl = t.ayah === 0 ? 'Basmallah' : t.ayah === 999 ? 'End' : t.ayah;
    const txt = currentAyahText[String(t.ayah)] || '';
    const th = txt ? `<span class="ayah-text">${esc(txt)}</span>` : '<span style="color:var(--text-dim)">-</span>';
    tr.innerHTML = `<td>${lbl}</td><td>${th}</td><td><input type="number" value="${t.time}" min="0" max="${durationMs}" data-index="${idx}" onchange="onTimingInput(this)"></td><td>${formatTime(t.time)}</td><td><button class="btn btn-sm" onclick="seekTo(${t.time})">Seek</button> <button class="btn btn-sm" onclick="playFrom(${idx})">Play</button></td>`;
    tr.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') seekTo(t.time); });
    tb.appendChild(tr);
  });
}
function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
function onTimingInput(inp) {
  const i = parseInt(inp.dataset.index); currentTimings[i].time = parseInt(inp.value);
  inp.closest('tr').querySelectorAll('td')[3].textContent = formatTime(currentTimings[i].time);
  renderMarkers();
}
function updateTimingRow(i, v) {
  const inp = document.querySelector(`#timing-tbody input[data-index="${i}"]`);
  if (inp) { inp.value = v; inp.closest('tr').querySelectorAll('td')[3].textContent = formatTime(v); }
}
function seekTo(ms) { audioPlayer.currentTime = ms/1000; if (audioPlayer.paused) { updatePlayhead(); playhead.style.display = 'block'; } }
function playFrom(i) { audioPlayer.currentTime = currentTimings[i].time/1000; audioPlayer.play(); }

// ── Export ───────────────────────────────────────────────────────────
async function exportDb() {
  const all = loadAllTimingsFromLocal();
  const allTimings = {};
  for (const [k, v] of Object.entries(all)) allTimings[k] = v.timings;

  if (!Object.keys(allTimings).length) { showToast('No saved surahs to export', 'error'); return; }

  const dbName = document.getElementById('db-name').value || 'gapless_timing';
  try {
    const res = await fetch(`${API}/api/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db_name: dbName, all_timings: allTimings }),
    });
    const d = await res.json();
    const st = document.getElementById('export-status');
    if (d.success) {
      st.className = 'success'; st.textContent = `Exported ${d.surahs_exported} surahs to ${dbName}.db.zip`;
      st.classList.remove('hidden'); document.getElementById('btn-download').disabled = false;
      showToast('Export complete', 'success');
    } else { st.className = 'error'; st.textContent = d.error; st.classList.remove('hidden'); }
  } catch (e) { showToast('Export failed: ' + e.message, 'error'); }
}
function downloadExport() { window.open(`${API}/api/export/download?db_name=${document.getElementById('db-name').value || 'gapless_timing'}`, '_blank'); }

// ── Utilities ───────────────────────────────────────────────────────
function formatTime(ms) { const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000), r = Math.floor(ms%1000); return `${m}:${s.toString().padStart(2,'0')}.${r.toString().padStart(3,'0')}`; }
function showToast(msg, type='info') { const t = document.createElement('div'); t.className = `toast ${type}`; t.textContent = msg; document.body.appendChild(t); setTimeout(()=>t.remove(), 3500); }
