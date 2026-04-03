/* Ayah Splitter - Frontend Application */

const API = '';  // Same origin

// State
let currentSurah = null;
let currentTimings = [];
let currentSilences = [];
let currentAyahText = {};  // {ayah_num: "arabic text"}
let waveformData = [];
let durationMs = 0;
let surahs = [];
let dragMarker = null;

// DOM elements
const audioPlayer = document.getElementById('audio-player');
const waveformCanvas = document.getElementById('waveform-canvas');
const markersOverlay = document.getElementById('markers-overlay');
const playhead = document.getElementById('playhead');
const ctx = waveformCanvas.getContext('2d');

// ── Initialize ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadMetadata();
  setupDropZone();
  setupAudioEvents();
  setupWaveformInteraction();
});

async function loadMetadata() {
  const res = await fetch(`${API}/api/metadata`);
  const data = await res.json();
  surahs = data.surahs;

  const select = document.getElementById('surah-select');
  surahs.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.number;
    opt.textContent = `${s.number}. ${s.name} (${s.ayah_count} ayahs)`;
    select.appendChild(opt);
  });
}

// ── Preferences Toggle ──────────────────────────────────────────────
function togglePreferences() {
  const panel = document.getElementById('preferences-panel');
  panel.classList.toggle('hidden');
}

// ── File Upload ─────────────────────────────────────────────────────
function setupDropZone() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });
}

async function handleFiles(files) {
  const formData = new FormData();
  let count = 0;

  for (const file of files) {
    if (file.name.endsWith('.mp3')) {
      formData.append('files', file);
      count++;
    }
  }

  if (count === 0) {
    showToast('No MP3 files found', 'error');
    return;
  }

  showToast(`Uploading ${count} file(s)...`, 'info');

  const res = await fetch(`${API}/api/upload-folder`, {
    method: 'POST',
    body: formData,
  });

  const data = await res.json();
  if (data.success) {
    showToast(`Uploaded ${data.uploaded_surahs.length} surah(s)`, 'success');
    document.getElementById('upload-status').classList.remove('hidden');
    document.getElementById('upload-count').textContent =
      `${data.uploaded_surahs.length} files uploaded`;
    listUploaded();
  } else {
    showToast(data.error || 'Upload failed', 'error');
  }
}

async function listUploaded() {
  const res = await fetch(`${API}/api/uploaded-surahs`);
  const data = await res.json();

  const listEl = document.getElementById('uploaded-list');
  if (data.surahs.length === 0) {
    listEl.classList.add('hidden');
    return;
  }

  listEl.classList.remove('hidden');
  document.getElementById('upload-status').classList.remove('hidden');
  document.getElementById('upload-count').textContent =
    `${data.surahs.length} files uploaded`;

  listEl.innerHTML = data.surahs.map(s => `
    <div class="file-item">
      <span>${s.surah}. ${s.name} (${s.size_mb} MB)</span>
      <span class="${s.analyzed ? 'analyzed' : 'pending'}">
        ${s.analyzed ? 'Analyzed' : 'Pending'}
      </span>
    </div>
  `).join('');
}

// ── Analysis ────────────────────────────────────────────────────────
async function analyzeAll() {
  const btn = document.getElementById('btn-analyze-all');
  btn.disabled = true;
  btn.textContent = 'Analyzing...';

  const progressEl = document.getElementById('analysis-progress');
  progressEl.classList.remove('hidden');

  try {
    const res = await fetch(`${API}/api/analyze-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();

    document.getElementById('analysis-fill').style.width = '100%';
    document.getElementById('analysis-status-text').textContent =
      `Analyzed ${data.analyzed} surahs. ${data.errors.length} errors.`;

    if (data.errors.length > 0) {
      showToast(`${data.errors.length} errors during analysis`, 'error');
    } else {
      showToast(`All ${data.analyzed} surahs analyzed`, 'success');
    }

    listUploaded();
  } catch (e) {
    showToast('Analysis failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyze All Surahs';
  }
}

// ── Surah Editor ────────────────────────────────────────────────────
async function loadSurah(surahNum) {
  if (!surahNum) {
    document.getElementById('editor-content').classList.add('hidden');
    document.getElementById('btn-analyze-surah').disabled = true;
    return;
  }

  surahNum = parseInt(surahNum);
  currentSurah = surahNum;
  currentTimings = [];
  currentSilences = [];
  currentAyahText = {};

  // Load waveform
  const waveRes = await fetch(`${API}/api/waveform/${surahNum}?points=2000`);
  if (!waveRes.ok) {
    showToast('Audio not found. Upload the file first.', 'error');
    return;
  }
  const waveData = await waveRes.json();
  waveformData = waveData.waveform;
  durationMs = waveData.duration_ms;

  // Setup audio
  audioPlayer.src = `${API}/api/audio/${surahNum}`;

  // Update UI
  const surahInfo = surahs.find(s => s.number === surahNum);
  document.getElementById('editor-surah-name').textContent =
    `${surahNum}. ${surahInfo.name}`;
  document.getElementById('editor-ayah-count').textContent =
    `${surahInfo.ayah_count} ayahs`;
  document.getElementById('editor-duration').textContent =
    formatTime(durationMs);

  // Clear basmallah badge
  const bsmBadge = document.getElementById('editor-basmallah');
  bsmBadge.textContent = '';
  bsmBadge.className = 'basmallah-badge';

  // Enable analyze button
  document.getElementById('btn-analyze-surah').disabled = false;

  // Show editor with waveform but empty table
  document.getElementById('editor-content').classList.remove('hidden');
  document.getElementById('timing-tbody').innerHTML =
    '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:2rem">Click "Analyze" to detect ayah boundaries</td></tr>';
  markersOverlay.innerHTML = '';

  renderWaveform();
}

async function analyzeCurrent() {
  if (!currentSurah) return;

  const btn = document.getElementById('btn-analyze-surah');
  btn.disabled = true;
  btn.textContent = 'Analyzing...';

  try {
    const analyzeRes = await fetch(`${API}/api/analyze/${currentSurah}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!analyzeRes.ok) {
      showToast('Analysis failed', 'error');
      return;
    }

    const analyzeData = await analyzeRes.json();
    currentTimings = analyzeData.timings;
    currentSilences = analyzeData.silences || [];
    currentAyahText = analyzeData.ayah_text || {};

    // Show basmallah detection result
    if (analyzeData.basmallah_detected !== null && analyzeData.basmallah_detected !== undefined) {
      const bsmStatus = analyzeData.basmallah_detected
        ? 'Basmallah detected'
        : 'No Basmallah detected (reciter starts with ayah 1)';
      showToast(bsmStatus, analyzeData.basmallah_detected ? 'success' : 'info');
    }

    // Fetch ayah text if not included
    if (Object.keys(currentAyahText).length === 0) {
      const textRes = await fetch(`${API}/api/text/${currentSurah}`);
      if (textRes.ok) {
        const textData = await textRes.json();
        if (textData.available) {
          currentAyahText = textData.ayahs;
        }
      }
    }

    // Show basmallah badge
    const bsmBadge = document.getElementById('editor-basmallah');
    if (analyzeData.basmallah_detected === true) {
      bsmBadge.textContent = 'Basmallah detected';
      bsmBadge.className = 'basmallah-badge detected';
    } else if (analyzeData.basmallah_detected === false) {
      bsmBadge.textContent = 'No Basmallah';
      bsmBadge.className = 'basmallah-badge not-detected';
    } else {
      bsmBadge.textContent = '';
      bsmBadge.className = 'basmallah-badge';
    }

    renderWaveform();
    renderMarkers();
    renderTimingTable();
  } catch (e) {
    showToast('Analysis failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyze';
  }
}

async function reanalyze() {
  await analyzeCurrent();
}

// ── Waveform Rendering ──────────────────────────────────────────────
function renderWaveform() {
  const container = document.getElementById('waveform-container');
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  waveformCanvas.width = rect.width * dpr;
  waveformCanvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const mid = h / 2;
  const barWidth = w / waveformData.length;

  // Background
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, w, h);

  // Draw silence regions
  ctx.fillStyle = 'rgba(56, 217, 169, 0.08)';
  for (const [start, end] of currentSilences) {
    const x1 = (start / durationMs) * w;
    const x2 = (end / durationMs) * w;
    ctx.fillRect(x1, 0, x2 - x1, h);
  }

  // Draw waveform bars
  ctx.fillStyle = '#4f8cff';
  for (let i = 0; i < waveformData.length; i++) {
    const amp = waveformData[i];
    const barH = amp * (h * 0.8);
    const x = i * barWidth;
    ctx.fillRect(x, mid - barH / 2, Math.max(barWidth - 0.5, 0.5), barH);
  }

  // Center line
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
}

// ── Markers (draggable ayah boundaries) ─────────────────────────────
function renderMarkers() {
  markersOverlay.innerHTML = '';

  for (let i = 0; i < currentTimings.length; i++) {
    const t = currentTimings[i];
    if (t.ayah === 999) continue;

    const pct = (t.time / durationMs) * 100;
    const marker = document.createElement('div');
    marker.className = 'marker';
    marker.style.left = `${pct}%`;
    marker.dataset.index = i;

    const label = document.createElement('div');
    label.className = 'marker-label';
    label.textContent = t.ayah === 0 ? 'Bsm' : `${t.ayah}`;
    marker.appendChild(label);

    marker.addEventListener('mousedown', startDrag);
    marker.addEventListener('touchstart', startDragTouch, { passive: false });

    markersOverlay.appendChild(marker);
  }
}

function startDrag(e) {
  e.preventDefault();
  dragMarker = e.currentTarget;
  dragMarker.classList.add('dragging');
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);
}

function startDragTouch(e) {
  e.preventDefault();
  dragMarker = e.currentTarget;
  dragMarker.classList.add('dragging');
  document.addEventListener('touchmove', onDragTouch, { passive: false });
  document.addEventListener('touchend', endDragTouch);
}

function onDrag(e) {
  if (!dragMarker) return;
  updateMarkerPosition(e.clientX);
}

function onDragTouch(e) {
  if (!dragMarker) return;
  e.preventDefault();
  updateMarkerPosition(e.touches[0].clientX);
}

function updateMarkerPosition(clientX) {
  const container = document.getElementById('waveform-container');
  const rect = container.getBoundingClientRect();
  let pct = ((clientX - rect.left) / rect.width) * 100;
  pct = Math.max(0, Math.min(100, pct));

  dragMarker.style.left = `${pct}%`;

  const idx = parseInt(dragMarker.dataset.index);
  const newTime = Math.round((pct / 100) * durationMs);
  currentTimings[idx].time = newTime;

  updateTimingRow(idx, newTime);
}

function endDrag() {
  if (dragMarker) dragMarker.classList.remove('dragging');
  dragMarker = null;
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);
}

function endDragTouch() {
  if (dragMarker) dragMarker.classList.remove('dragging');
  dragMarker = null;
  document.removeEventListener('touchmove', onDragTouch);
  document.removeEventListener('touchend', endDragTouch);
}

// ── Waveform Click (seek audio) ─────────────────────────────────────
function setupWaveformInteraction() {
  const container = document.getElementById('waveform-container');

  container.addEventListener('click', (e) => {
    if (dragMarker) return;
    const rect = container.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const seekTime = pct * (durationMs / 1000);
    audioPlayer.currentTime = seekTime;
  });

  window.addEventListener('resize', () => {
    if (waveformData.length > 0) {
      renderWaveform();
      renderMarkers();
    }
  });
}

// ── Audio Player ────────────────────────────────────────────────────
function setupAudioEvents() {
  audioPlayer.addEventListener('timeupdate', () => {
    updatePlayhead();
    updateTimeDisplay();
    highlightActiveRow();
  });

  audioPlayer.addEventListener('play', () => {
    playhead.style.display = 'block';
    document.getElementById('btn-play').textContent = 'Pause';
  });

  audioPlayer.addEventListener('pause', () => {
    document.getElementById('btn-play').textContent = 'Play';
  });

  audioPlayer.addEventListener('ended', () => {
    playhead.style.display = 'none';
    document.getElementById('btn-play').textContent = 'Play';
  });
}

function togglePlay() {
  if (audioPlayer.paused) {
    audioPlayer.play();
  } else {
    audioPlayer.pause();
  }
}

function stopAudio() {
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  playhead.style.display = 'none';
  document.getElementById('btn-play').textContent = 'Play';
}

function setPlaybackSpeed(speed) {
  audioPlayer.playbackRate = parseFloat(speed);
}

function updatePlayhead() {
  const currentMs = audioPlayer.currentTime * 1000;
  const pct = (currentMs / durationMs) * 100;
  playhead.style.left = `${pct}%`;
}

function updateTimeDisplay() {
  const current = formatTime(audioPlayer.currentTime * 1000);
  const total = formatTime(durationMs);
  document.getElementById('audio-time').textContent = `${current} / ${total}`;
}

function highlightActiveRow() {
  const currentMs = audioPlayer.currentTime * 1000;
  const rows = document.querySelectorAll('#timing-tbody tr');
  let activeIdx = 0;

  for (let i = currentTimings.length - 1; i >= 0; i--) {
    if (currentTimings[i].ayah !== 999 && currentMs >= currentTimings[i].time) {
      activeIdx = i;
      break;
    }
  }

  rows.forEach((row, i) => {
    row.classList.toggle('active-row', i === activeIdx);
  });
}

// ── Timing Table ────────────────────────────────────────────────────
function renderTimingTable() {
  const tbody = document.getElementById('timing-tbody');
  tbody.innerHTML = '';

  currentTimings.forEach((t, idx) => {
    const tr = document.createElement('tr');
    if (t.ayah === 0 || t.ayah === 999) tr.className = 'special-row';

    const ayahLabel = t.ayah === 0 ? 'Basmallah' : t.ayah === 999 ? 'End' : t.ayah;

    // Get Arabic text for this ayah
    const ayahText = currentAyahText[String(t.ayah)] || '';
    const textHtml = ayahText
      ? `<span class="ayah-text">${escapeHtml(ayahText)}</span>`
      : '<span style="color:var(--text-dim);font-size:0.8rem">-</span>';

    tr.innerHTML = `
      <td>${ayahLabel}</td>
      <td>${textHtml}</td>
      <td>
        <input type="number" value="${t.time}" min="0" max="${durationMs}"
               data-index="${idx}" onchange="onTimingInput(this)">
      </td>
      <td>${formatTime(t.time)}</td>
      <td>
        <button class="btn btn-sm" onclick="seekTo(${t.time})">Seek</button>
        <button class="btn btn-sm" onclick="playFromAyah(${idx})">Play</button>
      </td>
    `;

    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      seekTo(t.time);
    });

    tbody.appendChild(tr);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function onTimingInput(input) {
  const idx = parseInt(input.dataset.index);
  const newTime = parseInt(input.value);
  currentTimings[idx].time = newTime;

  // Update formatted time in next sibling cell
  const cells = input.closest('tr').querySelectorAll('td');
  cells[3].textContent = formatTime(newTime);

  renderMarkers();
}

function updateTimingRow(idx, newTime) {
  const input = document.querySelector(`#timing-tbody input[data-index="${idx}"]`);
  if (input) {
    input.value = newTime;
    const cells = input.closest('tr').querySelectorAll('td');
    cells[3].textContent = formatTime(newTime);
  }
}

function seekTo(timeMs) {
  audioPlayer.currentTime = timeMs / 1000;
  if (audioPlayer.paused) {
    updatePlayhead();
    playhead.style.display = 'block';
  }
}

function playFromAyah(idx) {
  audioPlayer.currentTime = currentTimings[idx].time / 1000;
  audioPlayer.play();
}

// ── Save Timings ────────────────────────────────────────────────────
async function saveTiming() {
  if (!currentSurah) return;

  const res = await fetch(`${API}/api/timings/${currentSurah}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timings: currentTimings }),
  });

  if (res.ok) {
    showToast('Timings saved', 'success');
  } else {
    showToast('Failed to save timings', 'error');
  }
}

// ── Export ───────────────────────────────────────────────────────────
async function exportDb() {
  const dbName = document.getElementById('db-name').value || 'gapless_timing';
  const statusEl = document.getElementById('export-status');

  try {
    const res = await fetch(`${API}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db_name: dbName }),
    });

    const data = await res.json();

    if (data.success) {
      statusEl.className = 'success';
      statusEl.textContent = `Exported ${data.surahs_exported} surahs to ${dbName}.db.zip`;
      statusEl.classList.remove('hidden');
      document.getElementById('btn-download').disabled = false;
      showToast('Export complete', 'success');
    } else {
      statusEl.className = 'error';
      statusEl.textContent = data.error;
      statusEl.classList.remove('hidden');
    }
  } catch (e) {
    showToast('Export failed: ' + e.message, 'error');
  }
}

function downloadExport() {
  const dbName = document.getElementById('db-name').value || 'gapless_timing';
  window.open(`${API}/api/export/download?db_name=${dbName}`, '_blank');
}

// ── Utilities ───────────────────────────────────────────────────────
function formatTime(ms) {
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  const msRem = Math.floor(ms % 1000);
  return `${min}:${sec.toString().padStart(2, '0')}.${msRem.toString().padStart(3, '0')}`;
}

function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}
