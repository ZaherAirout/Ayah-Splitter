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
let dragMarkerStartTime = null;
let dragTrimHandle = null;
let zoomLevel = 1;
let trimStartMs = 0;
let trimEndMs = 0;
let manualAnchorAyahs = new Set();
let reflowRequestId = 0;
let waveformCache = new Map();
let waveformFetchRequestId = 0;
let waveformDetailTimer = null;
let analyzeProgressTimer = null;
let analyzeProgressValue = 0;
let activeAnalyzeJobId = null;
let activeAnalyzeSurah = null;
let activeAnalyzeStatus = null;
let lastAnalyzeJobSnapshot = null;

const BASE_WAVEFORM_POINTS = 2000;
const WAVEFORM_DETAIL_LEVELS = [2000, 4000, 8000, 12000, 16000];
const WAVEFORM_DETAIL_DEBOUNCE_MS = 260;
const MAX_ZOOM_LEVEL = 60;

const audioPlayer = document.getElementById('audio-player');
const waveformCanvas = document.getElementById('waveform-canvas');
const markersOverlay = document.getElementById('markers-overlay');
const playhead = document.getElementById('playhead');
const ctx = waveformCanvas.getContext('2d');

function setPlayButtonState(isPlaying) {
  const btn = document.getElementById('btn-play');
  btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  btn.setAttribute('title', isPlaying ? 'Pause' : 'Play');
  btn.innerHTML = isPlaying
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6h4v12H7zM13 6h4v12h-4z"></path></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12l10-6z"></path></svg>';
}

function isReflowableAyah(ayah) {
  return ayah > 0 && ayah < 999;
}

function getTimingIndexByAyah(ayah) {
  return currentTimings.findIndex(t => t.ayah === ayah);
}

function getTimingEntryByAyah(ayah) {
  return currentTimings.find(t => t.ayah === ayah) || null;
}

function getLastAyahNumber() {
  return currentTimings.reduce((maxAyah, entry) => (
    entry.ayah !== 0 && entry.ayah !== 999 ? Math.max(maxAyah, entry.ayah) : maxAyah
  ), 0);
}

function getNextFixedAyah(anchorAyah) {
  const nextManual = [...manualAnchorAyahs]
    .filter(ayah => ayah > anchorAyah)
    .sort((a, b) => a - b)[0];
  return nextManual || 999;
}

function getMaxAnchorTime(anchorAyah, nextFixedAyah) {
  const nextEntry = getTimingEntryByAyah(nextFixedAyah);
  if (!nextEntry) return durationMs;
  const lastSegmentAyah = nextFixedAyah === 999 ? getLastAyahNumber() : nextFixedAyah - 1;
  const futureAyahs = Math.max(0, lastSegmentAyah - anchorAyah);
  return nextEntry.time - (futureAyahs + 1) * 100;
}

function clampMarkerTime(index, proposedTime) {
  const entry = currentTimings[index];
  if (!entry) return proposedTime;

  const prevEntry = currentTimings[index - 1];
  const minGap = prevEntry && prevEntry.ayah === 0 && entry.ayah === 1 ? 0 : 100;
  const minTime = prevEntry ? prevEntry.time + minGap : 0;

  let maxTime;
  if (isReflowableAyah(entry.ayah)) {
    maxTime = getMaxAnchorTime(entry.ayah, getNextFixedAyah(entry.ayah));
  } else {
    const nextEntry = currentTimings[index + 1];
    maxTime = nextEntry ? nextEntry.time - 100 : durationMs;
  }

  return Math.max(minTime, Math.min(proposedTime, Math.max(minTime, maxTime)));
}

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

function getWaveformCacheKey(surahNum, points) {
  return `${surahNum}:${points}`;
}

function normalizeWaveformPoints(points) {
  for (const level of WAVEFORM_DETAIL_LEVELS) {
    if (points <= level) return level;
  }
  return WAVEFORM_DETAIL_LEVELS[WAVEFORM_DETAIL_LEVELS.length - 1];
}

function getDesiredWaveformPoints() {
  if (zoomLevel <= 2) return 2000;
  if (zoomLevel <= 5) return 4000;
  if (zoomLevel <= 10) return 8000;
  if (zoomLevel <= 18) return 12000;
  return 16000;
}

async function fetchWaveformData(surahNum, points = BASE_WAVEFORM_POINTS) {
  const targetPoints = normalizeWaveformPoints(points);
  const cacheKey = getWaveformCacheKey(surahNum, targetPoints);
  if (waveformCache.has(cacheKey)) return waveformCache.get(cacheKey);

  const res = await fetch(`${API}/api/waveform/${surahNum}?points=${targetPoints}`);
  if (!res.ok) throw new Error('Audio not found. Upload first.');

  const data = await res.json();
  waveformCache.set(cacheKey, data);
  return data;
}

function scheduleWaveformDetailRefresh() {
  if (!currentSurah || !durationMs) return;

  const targetPoints = getDesiredWaveformPoints();
  if (waveformData.length >= targetPoints) return;

  clearTimeout(waveformDetailTimer);
  waveformDetailTimer = setTimeout(async () => {
    const surahAtRequest = currentSurah;
    const requestId = ++waveformFetchRequestId;

    try {
      const data = await fetchWaveformData(surahAtRequest, targetPoints);
      if (surahAtRequest !== currentSurah || requestId !== waveformFetchRequestId) return;
      if (data.waveform.length <= waveformData.length) return;

      waveformData = data.waveform;
      renderWaveform();
    } catch (e) {
      if (surahAtRequest === currentSurah) console.warn('Waveform detail refresh failed:', e);
    }
  }, WAVEFORM_DETAIL_DEBOUNCE_MS);
}

// ── Init ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadMetadata();
  setupDropZone();
  setupAudioEvents();
  setupWaveformInteraction();
  setupKeyboardShortcuts();
  onBasmallahModeChange();
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
      opt.textContent = `${s.number}. ${s.name}`;
      sel.appendChild(opt);
    });
  });
}

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
  uploadedFiles.push({ surah, name, size_mb, status: 'uploaded', progress: 0 });
  uploadedFiles.sort((a, b) => a.surah - b.surah);
  renderUploadedList();
}

async function refreshUploadedList() {
  const res = await fetch(`${API}/api/uploaded-surahs`);
  const data = await res.json();
  uploadedFiles = data.surahs.map(s => ({ surah: s.surah, name: s.name, size_mb: s.size_mb, status: s.analyzed ? 'analyzed' : 'uploaded', progress: 0 }));
  renderUploadedList();
}

function renderUploadedList() {
  const list = document.getElementById('uploaded-list');
  const bar = document.getElementById('upload-status');
  if (!uploadedFiles.length) { list.classList.add('hidden'); bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  document.getElementById('upload-count').textContent = `${uploadedFiles.length} files`;
  list.classList.remove('hidden');
  list.innerHTML = uploadedFiles.map(f => {
    const cls = f.status === 'analyzing' || f.status === 'canceling'
      ? f.status
      : f.status === 'analyzed'
        ? 'analyzed'
        : 'pending';
    const progress = Number.isFinite(f.progress) ? Math.round(f.progress) : 0;
    const txt = f.status === 'canceling'
      ? '<span class="spinner"></span> Canceling'
      : f.status === 'analyzing'
      ? `<span class="spinner"></span> ${progress}%`
      : f.status === 'analyzed'
        ? 'Ready'
        : 'Uploaded';
    const active = currentSurah === f.surah ? 'active' : '';
    return `<button type="button" class="file-item ${active}" onclick="openUploadedSurah(${f.surah})"><span class="file-main"><strong>${f.surah}</strong><span>${f.name}</span><small>${f.size_mb} MB</small></span><span class="file-status ${cls}">${txt}</span></button>`;
  }).join('');
}

function setFileStatus(s, st, progress = null) {
  const f = uploadedFiles.find(x => x.surah === s);
  if (f) {
    f.status = st;
    if (progress != null) f.progress = progress;
    else if (st !== 'analyzing') f.progress = 0;
    renderUploadedList();
  }
}

function updateAnalyzeButton(progress, message = 'Analyzing') {
  const btn = document.getElementById('btn-analyze-surah');
  if (btn.disabled) {
    btn.textContent = `${Math.round(progress)}%`;
    btn.title = message;
  }
}

function setAnalyzeProgress(progress, message = 'Analyzing', surahNum = currentSurah) {
  analyzeProgressValue = Math.max(0, Math.min(100, Math.round(progress)));
  updateAnalyzeButton(analyzeProgressValue, message);
  if (surahNum) setFileStatus(surahNum, 'analyzing', analyzeProgressValue);
}

function startAnalyzeProgress(surahNum = currentSurah) {
  clearInterval(analyzeProgressTimer);
  analyzeProgressTimer = null;
  setAnalyzeProgress(0, 'Queued', surahNum);
}

function stopAnalyzeProgress() {
  clearInterval(analyzeProgressTimer);
  analyzeProgressTimer = null;
  analyzeProgressValue = 0;
}

function getSurahName(surahNum) {
  return surahs.find(s => s.number === surahNum)?.name || `Surah ${surahNum}`;
}

function showAnalyzeModal(surahNum) {
  const modal = document.getElementById('analyze-modal');
  modal.classList.remove('hidden');
  document.getElementById('analyze-modal-title').textContent = `${surahNum}. ${getSurahName(surahNum)}`;
}

function closeAnalyzeModal(force = false) {
  const isActive = activeAnalyzeJobId && !['completed', 'failed', 'canceled'].includes(activeAnalyzeStatus || '');
  if (isActive && !force) return;
  document.getElementById('analyze-modal').classList.add('hidden');
}

function onAnalyzeModalBackdrop(event) {
  if (event.target === event.currentTarget) closeAnalyzeModal();
}

function formatAnalyzeEventTime(isoString) {
  if (!isoString) return '--:--:--';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function updateAnalyzeModal(job) {
  if (!job) return;
  lastAnalyzeJobSnapshot = job;
  const surahNum = job.surah_number || activeAnalyzeSurah || currentSurah || 0;
  if (surahNum) showAnalyzeModal(surahNum);

  const percent = Math.max(0, Math.min(100, Math.round(job.progress || 0)));
  const message = job.message || 'Analyzing';
  const status = job.status || 'queued';
  const statusLabel = status === 'canceling'
    ? 'Canceling'
    : status === 'completed'
      ? 'Done'
      : status === 'canceled'
        ? 'Canceled'
        : status.charAt(0).toUpperCase() + status.slice(1);

  const statusEl = document.getElementById('analyze-modal-status');
  statusEl.textContent = statusLabel;
  statusEl.className = `modal-status-pill ${status}`;

  document.getElementById('analyze-modal-percent').textContent = `${percent}%`;
  document.getElementById('analyze-modal-message').textContent = message;
  document.getElementById('analyze-modal-progress-bar').style.width = `${percent}%`;

  const feed = document.getElementById('analyze-modal-feed');
  const events = job.events || [];
  if (!events.length) {
    feed.innerHTML = '<div class="analyze-feed-empty">Waiting for updates…</div>';
  } else {
    feed.innerHTML = events.map(event => `
      <div class="analyze-feed-item">
        <div class="analyze-feed-meta">
          <span>${formatAnalyzeEventTime(event.at)}</span>
          <span class="analyze-feed-state">${esc(event.status || '')}</span>
          <span class="analyze-feed-progress">${Math.round(event.progress || 0)}%</span>
        </div>
        <div class="analyze-feed-message">${esc(event.message || '')}</div>
      </div>
    `).join('');
    feed.scrollTop = feed.scrollHeight;
  }

  const cancelBtn = document.getElementById('btn-cancel-analyze');
  const closeBtn = document.getElementById('btn-close-analyze-modal');
  const isTerminal = ['completed', 'failed', 'canceled'].includes(status);
  cancelBtn.disabled = !activeAnalyzeJobId || isTerminal || status === 'canceling';
  cancelBtn.textContent = status === 'canceling' ? 'Canceling…' : 'Cancel';
  closeBtn.classList.toggle('hidden', !isTerminal);
}

async function cancelAnalyzeCurrent() {
  if (!activeAnalyzeJobId) return;

  const cancelBtn = document.getElementById('btn-cancel-analyze');
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Canceling…';

  try {
    const res = await fetch(`${API}/api/analyze-jobs/${activeAnalyzeJobId}/cancel`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Cancel failed');

    activeAnalyzeStatus = data.status || 'canceling';
    if (activeAnalyzeSurah) {
      setFileStatus(activeAnalyzeSurah, 'canceling', analyzeProgressValue);
    }
    updateAnalyzeModal({
      ...(lastAnalyzeJobSnapshot || {}),
      surah_number: activeAnalyzeSurah,
      status: data.status || 'canceling',
      progress: analyzeProgressValue,
      message: data.message || 'Cancel requested',
    });
  } catch (e) {
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Cancel';
    showToast('Cancel failed: ' + e.message, 'error');
  }
}

function openUploadedSurah(surahNum) {
  document.getElementById('surah-select').value = surahNum;
  loadSurah(surahNum);
}

// ── Surah Editor ────────────────────────────────────────────────────
async function loadSurah(surahNum) {
  if (!surahNum) { document.getElementById('editor-content').classList.add('hidden'); return; }
  surahNum = parseInt(surahNum);
  currentSurah = surahNum;
  currentTimings = []; currentSilences = []; currentAyahText = {};
  manualAnchorAyahs = new Set();
  renderDebugPanel(null, null);
  switchTab('editor');
  waveformCache = new Map();
  clearTimeout(waveformDetailTimer);
  waveformFetchRequestId += 1;
  trimStartMs = 0; trimEndMs = 0;
  document.getElementById('trim-start-readout').textContent = '0:00.000';
  document.getElementById('trim-end-readout').textContent = '0:00.000';
  document.getElementById('basmallah-mode').value = 'auto';
  document.getElementById('manual-basmallah-end').value = '';
  onBasmallahModeChange();

  // Check if we have saved timings in localStorage
  const saved = loadAllTimingsFromLocal()[surahNum];

  let wd;
  try {
    wd = await fetchWaveformData(surahNum, BASE_WAVEFORM_POINTS);
  } catch (e) {
    showToast(e.message, 'error');
    return;
  }
  waveformData = wd.waveform; durationMs = wd.duration_ms;

  audioPlayer.src = `${API}/api/audio/${surahNum}`;

  const info = surahs.find(s => s.number === surahNum);
  document.getElementById('editor-surah-name').textContent = `${surahNum}. ${info.name}`;
  document.getElementById('editor-ayah-count').textContent = `${info.ayah_count} ayahs`;
  document.getElementById('editor-duration').textContent = formatTime(durationMs);

  const badge = document.getElementById('editor-basmallah');
  badge.textContent = ''; badge.className = 'basmallah-badge';

  zoomLevel = 1; document.getElementById('zoom-level').textContent = '100%';
  document.getElementById('btn-analyze-surah').disabled = Boolean(activeAnalyzeJobId);
  if (!activeAnalyzeJobId) {
    document.getElementById('btn-analyze-surah').textContent = 'Analyze';
    document.getElementById('btn-analyze-surah').title = 'Analyze';
  } else {
    updateAnalyzeButton(analyzeProgressValue, lastAnalyzeJobSnapshot?.message || 'Analyzing');
  }
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
    }
    renderWaveform(); renderMarkers(); renderTimingTable(); updateTrimOverlays();
  } else {
    si.classList.add('hidden');
    markersOverlay.innerHTML = '';
    document.getElementById('timing-tbody').innerHTML =
      '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:1.5rem">Analyze to place markers.</td></tr>';
    renderWaveform(); updateTrimOverlays();
  }
  scheduleWaveformDetailRefresh();
  renderUploadedList();
}

async function analyzeCurrent() {
  if (!currentSurah) return;
  if (activeAnalyzeJobId) {
    showAnalyzeModal(activeAnalyzeSurah || currentSurah);
    return;
  }

  const analyzingSurah = currentSurah;
  const btn = document.getElementById('btn-analyze-surah');
  btn.disabled = true;
  startAnalyzeProgress(analyzingSurah);
  activeAnalyzeSurah = analyzingSurah;
  activeAnalyzeStatus = 'queued';
  lastAnalyzeJobSnapshot = {
    surah_number: analyzingSurah,
    status: 'queued',
    progress: 0,
    message: 'Queued',
    events: [{ at: new Date().toISOString(), status: 'queued', progress: 0, message: 'Queued' }],
  };
  updateAnalyzeModal(lastAnalyzeJobSnapshot);

  const basmallahMode = document.getElementById('basmallah-mode').value || 'auto';
  const manualBasmallahValue = document.getElementById('manual-basmallah-end').value;
  const manualBasmallahEndMs = manualBasmallahValue === '' ? null : parseInt(manualBasmallahValue, 10);

  try {
    const startRes = await fetch(`${API}/api/analyze-jobs/${analyzingSurah}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trim_start_ms: trimStartMs,
        trim_end_ms: trimEndMs,
        basmallah_mode: basmallahMode,
        manual_basmallah_end_ms: manualBasmallahEndMs,
      }),
    });

    let startData = null;
    try {
      startData = await startRes.json();
    } catch {}

    if (!startRes.ok || !startData?.success || !startData?.job_id) {
      stopAnalyzeProgress();
      const message = startData?.error || 'Analysis failed';
      showToast(message, 'error');
      setFileStatus(analyzingSurah, 'uploaded');
      updateAnalyzeModal({
        ...lastAnalyzeJobSnapshot,
        status: 'failed',
        message,
        events: [...(lastAnalyzeJobSnapshot?.events || []), {
          at: new Date().toISOString(),
          status: 'failed',
          progress: analyzeProgressValue,
          message,
        }],
      });
      return;
    }

    const jobId = startData.job_id;
    activeAnalyzeJobId = jobId;
    let finalJob = null;

    while (true) {
      const jobRes = await fetch(`${API}/api/analyze-jobs/${jobId}`);
      const job = await jobRes.json();
      if (!jobRes.ok) throw new Error(job.error || 'Analysis failed');

      activeAnalyzeStatus = job.status;
      const progressMessage = job.message || 'Analyzing';
      if (job.status === 'canceling') {
        setFileStatus(analyzingSurah, 'canceling', job.progress || analyzeProgressValue);
      } else {
        setAnalyzeProgress(job.progress || 0, progressMessage, analyzingSurah);
      }
      updateAnalyzeModal(job);

      if (job.status === 'completed') {
        finalJob = job;
        break;
      }
      if (job.status === 'canceled') {
        finalJob = job;
        break;
      }
      if (job.status === 'failed') {
        throw new Error(job.error || 'Analysis failed');
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (finalJob.status === 'canceled') {
      setFileStatus(analyzingSurah, 'uploaded');
      showToast('Analysis canceled', 'info');
      return;
    }

    const d = finalJob.result;
    setAnalyzeProgress(100, 'Done', analyzingSurah);
    updateAnalyzeModal(finalJob);
    setFileStatus(analyzingSurah, 'analyzed');

    if (currentSurah === analyzingSurah) {
      currentTimings = d.timings;
      currentSilences = d.silences || [];
      currentAyahText = d.ayah_text || {};
      manualAnchorAyahs = new Set();
      if (d.debug) renderDebugPanel(d.debug, d);

      if (d.basmallah_detected != null) {
        showToast(d.basmallah_detected ? 'Basmallah detected' : 'No Basmallah detected', d.basmallah_detected ? 'success' : 'info');
      }

      if (!Object.keys(currentAyahText).length) {
        const tr = await fetch(`${API}/api/text/${analyzingSurah}`);
        if (tr.ok) { const td = await tr.json(); if (td.available) currentAyahText = td.ayahs; }
      }

      const badge = document.getElementById('editor-basmallah');
      if (d.basmallah_detected === true) {
        badge.textContent = d.basmallah_method && d.basmallah_method.startsWith('manual')
          ? 'Basmallah forced'
          : 'Basmallah detected';
        badge.className = 'basmallah-badge detected';
      } else if (d.basmallah_detected === false) {
        badge.textContent = d.basmallah_method === 'manual-absent'
          ? 'No Basmallah (manual)'
          : 'No Basmallah';
        badge.className = 'basmallah-badge not-detected';
      }

      renderWaveform(); renderMarkers(); renderTimingTable(); updateTrimOverlays(); highlightActiveRow();
    } else {
      showToast(`Surah ${analyzingSurah} analysis complete`, 'success');
    }
  } catch (e) {
    stopAnalyzeProgress();
    activeAnalyzeStatus = 'failed';
    showToast('Error: ' + e.message, 'error');
    setFileStatus(analyzingSurah, 'uploaded');
    updateAnalyzeModal({
      ...(lastAnalyzeJobSnapshot || {}),
      surah_number: analyzingSurah,
      status: 'failed',
      progress: analyzeProgressValue,
      message: e.message,
      events: [...(lastAnalyzeJobSnapshot?.events || []), {
        at: new Date().toISOString(),
        status: 'failed',
        progress: analyzeProgressValue,
        message: e.message,
      }],
    });
  }
  finally {
    activeAnalyzeJobId = null;
    activeAnalyzeSurah = null;
    stopAnalyzeProgress();
    btn.disabled = false;
    btn.textContent = 'Analyze';
    btn.title = 'Analyze';
  }
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
  if (!saved.length) { el.innerHTML = '<span style="color:var(--text-dim)">Nothing saved yet.</span>'; return; }
  el.innerHTML = `<strong>${saved.length}</strong> saved ` +
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
  trimStartMs = Math.max(0, trimStartMs || 0);
  trimEndMs = Math.max(0, trimEndMs || 0);
  if (durationMs > 0) {
    const maxStart = Math.max(0, durationMs - trimEndMs - 100);
    trimStartMs = Math.min(trimStartMs, maxStart);
    const maxEnd = Math.max(0, durationMs - trimStartMs - 100);
    trimEndMs = Math.min(trimEndMs, maxEnd);
  }
  updateTrimOverlays();
}

function setTrimFromPlayhead(side) {
  if (!durationMs) return;
  const playheadMs = Math.round(audioPlayer.currentTime * 1000);
  if (side === 'start') {
    const maxStart = Math.max(0, durationMs - trimEndMs - 100);
    trimStartMs = Math.min(playheadMs, maxStart);
  } else {
    const minOutPoint = trimStartMs + 100;
    const outPoint = Math.max(minOutPoint, Math.min(playheadMs, durationMs));
    trimEndMs = Math.max(0, durationMs - outPoint);
  }
  onTrimChange();
}

function resetTrim() {
  trimStartMs = 0;
  trimEndMs = 0;
  onTrimChange();
}

function onBasmallahModeChange() {
  const mode = document.getElementById('basmallah-mode').value || 'auto';
  const wrap = document.getElementById('manual-basmallah-wrap');
  const input = document.getElementById('manual-basmallah-end');
  const playheadBtn = document.getElementById('btn-use-playhead');
  const clearBtn = document.getElementById('btn-clear-basmallah');
  const manual = mode === 'present';

  wrap.classList.toggle('hidden', !manual);
  playheadBtn.disabled = !manual;
  clearBtn.classList.toggle('hidden', !manual);
  input.disabled = !manual;
  if (!manual) input.value = '';
}

function usePlayheadForBasmallah() {
  const input = document.getElementById('manual-basmallah-end');
  input.value = Math.round(audioPlayer.currentTime * 1000);
}

function clearBasmallahManual() {
  document.getElementById('manual-basmallah-end').value = '';
}

function updateTrimOverlays() {
  if (!durationMs) return;
  const sl = document.getElementById('trim-start-overlay');
  const sr = document.getElementById('trim-end-overlay');
  const sh = document.getElementById('trim-start-handle');
  const eh = document.getElementById('trim-end-handle');
  const trimEndPointMs = Math.max(trimStartMs + 100, durationMs - trimEndMs);
  sl.style.width = `${(trimStartMs / durationMs) * 100}%`;
  sr.style.width = `${(trimEndMs / durationMs) * 100}%`;
  sh.style.left = `${(trimStartMs / durationMs) * 100}%`;
  eh.style.left = `${(trimEndPointMs / durationMs) * 100}%`;
  document.getElementById('trim-start-readout').textContent = `In ${formatTime(trimStartMs)}`;
  document.getElementById('trim-end-readout').textContent = `Out ${formatTime(trimEndPointMs)}`;
}

// ── Zoom ────────────────────────────────────────────────────────────
function zoomIn() { setZoom(Math.min(zoomLevel * 1.5, MAX_ZOOM_LEVEL)); }
function zoomOut() { setZoom(Math.max(zoomLevel / 1.5, 1)); }
function zoomReset() { setZoom(1); }
function setZoom(l) {
  zoomLevel = l;
  document.getElementById('zoom-level').textContent = `${Math.round(l * 100)}%`;
  renderWaveform();
  renderMarkers();
  updateTrimOverlays();
  scrollToPlayhead();
  scheduleWaveformDetailRefresh();
}
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
  if (!waveformData.length) return;
  const vw = sc.clientWidth;
  const tw = vw * zoomLevel;
  ct.style.width = `${tw}px`;
  const deviceDpr = window.devicePixelRatio || 1;
  const dpr = tw > 24000 ? 1 : tw > 12000 ? Math.min(deviceDpr, 1.5) : deviceDpr;
  const h = ct.clientHeight || 220;
  waveformCanvas.width = tw * dpr; waveformCanvas.height = h * dpr;
  waveformCanvas.style.width = `${tw}px`; waveformCanvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const mid = h / 2, bw = tw / waveformData.length;
  ctx.fillStyle = '#0f1117'; ctx.fillRect(0, 0, tw, h);
  ctx.fillStyle = 'rgba(56,217,169,0.08)';
  for (const [s, e] of currentSilences) { ctx.fillRect((s/durationMs)*tw, 0, ((e-s)/durationMs)*tw, h); }
  ctx.fillStyle = '#4f8cff';
  for (let i = 0; i < waveformData.length; i++) {
    const bh = waveformData[i] * (h * 0.8);
    ctx.fillRect(i * bw, mid - bh / 2, Math.max(bw - 0.35, 0.75), bh);
  }
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
function startDrag(e) { e.preventDefault(); dragMarker = e.currentTarget; dragMarkerStartTime = currentTimings[parseInt(dragMarker.dataset.index)]?.time ?? null; dragMarker.classList.add('dragging'); document.addEventListener('mousemove', onDrag); document.addEventListener('mouseup', endDrag); }
function startDragTouch(e) { e.preventDefault(); dragMarker = e.currentTarget; dragMarkerStartTime = currentTimings[parseInt(dragMarker.dataset.index)]?.time ?? null; dragMarker.classList.add('dragging'); document.addEventListener('touchmove', onDragTouch, {passive:false}); document.addEventListener('touchend', endDragTouch); }
function onDrag(e) { if (dragMarker) updateMarkerPos(e.clientX); }
function onDragTouch(e) { if (dragMarker) { e.preventDefault(); updateMarkerPos(e.touches[0].clientX); } }
function updateMarkerPos(cx) {
  const ct = document.getElementById('waveform-container');
  const r = ct.getBoundingClientRect();
  let pct = Math.max(0, Math.min(100, ((cx - r.left) / ct.offsetWidth) * 100));
  dragMarker.style.left = `${pct}%`;
  const idx = parseInt(dragMarker.dataset.index);
  currentTimings[idx].time = clampMarkerTime(idx, Math.round((pct / 100) * durationMs));
  dragMarker.style.left = `${(currentTimings[idx].time / durationMs) * 100}%`;
  updateTimingRow(idx, currentTimings[idx].time);
}
async function endDrag() {
  const idx = dragMarker ? parseInt(dragMarker.dataset.index) : null;
  const moved = idx != null && dragMarkerStartTime != null && currentTimings[idx]?.time !== dragMarkerStartTime;
  if (dragMarker) dragMarker.classList.remove('dragging');
  dragMarker = null;
  dragMarkerStartTime = null;
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);
  if (moved) await reflowFromManualAdjustment(idx);
}
async function endDragTouch() {
  const idx = dragMarker ? parseInt(dragMarker.dataset.index) : null;
  const moved = idx != null && dragMarkerStartTime != null && currentTimings[idx]?.time !== dragMarkerStartTime;
  if (dragMarker) dragMarker.classList.remove('dragging');
  dragMarker = null;
  dragMarkerStartTime = null;
  document.removeEventListener('touchmove', onDragTouch);
  document.removeEventListener('touchend', endDragTouch);
  if (moved) await reflowFromManualAdjustment(idx);
}

function startTrimDrag(e, side) {
  e.preventDefault();
  e.stopPropagation();
  dragTrimHandle = side;
  document.addEventListener('mousemove', onTrimDrag);
  document.addEventListener('mouseup', endTrimDrag);
}

function startTrimDragTouch(e, side) {
  e.preventDefault();
  e.stopPropagation();
  dragTrimHandle = side;
  document.addEventListener('touchmove', onTrimDragTouch, { passive: false });
  document.addEventListener('touchend', endTrimDragTouch);
}

function onTrimDrag(e) {
  if (!dragTrimHandle) return;
  updateTrimHandlePos(e.clientX);
}

function onTrimDragTouch(e) {
  if (!dragTrimHandle) return;
  e.preventDefault();
  updateTrimHandlePos(e.touches[0].clientX);
}

function updateTrimHandlePos(clientX) {
  const ct = document.getElementById('waveform-container');
  const rect = ct.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / ct.offsetWidth));
  const ms = Math.round(pct * durationMs);

  if (dragTrimHandle === 'start') {
    const maxStart = Math.max(0, durationMs - trimEndMs - 100);
    trimStartMs = Math.min(ms, maxStart);
  } else {
    const minOut = trimStartMs + 100;
    const outPoint = Math.max(minOut, Math.min(ms, durationMs));
    trimEndMs = Math.max(0, durationMs - outPoint);
  }

  onTrimChange();
}

function endTrimDrag() {
  dragTrimHandle = null;
  document.removeEventListener('mousemove', onTrimDrag);
  document.removeEventListener('mouseup', endTrimDrag);
}

function endTrimDragTouch() {
  dragTrimHandle = null;
  document.removeEventListener('touchmove', onTrimDragTouch);
  document.removeEventListener('touchend', endTrimDragTouch);
}

// ── Waveform Click + Wheel ──────────────────────────────────────────
function setupWaveformInteraction() {
  const ct = document.getElementById('waveform-container');
  const sc = document.getElementById('waveform-scroll');
  const sh = document.getElementById('trim-start-handle');
  const eh = document.getElementById('trim-end-handle');
  sh.addEventListener('mousedown', e => startTrimDrag(e, 'start'));
  eh.addEventListener('mousedown', e => startTrimDrag(e, 'end'));
  sh.addEventListener('touchstart', e => startTrimDragTouch(e, 'start'), { passive: false });
  eh.addEventListener('touchstart', e => startTrimDragTouch(e, 'end'), { passive: false });
  ct.addEventListener('click', e => {
    if (dragMarker || dragTrimHandle || e.target.closest('.marker, .trim-handle')) return;
    audioPlayer.currentTime = ((e.clientX - ct.getBoundingClientRect().left) / ct.offsetWidth) * (durationMs/1000);
  });
  sc.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(Math.max(1, Math.min(MAX_ZOOM_LEVEL, zoomLevel * (e.deltaY > 0 ? 0.8 : 1.25)))); } }, { passive: false });
  window.addEventListener('resize', () => {
    if (waveformData.length) {
      renderWaveform();
      renderMarkers();
      updateTrimOverlays();
      scheduleWaveformDetailRefresh();
    }
  });
}

async function reflowFromManualAdjustment(index) {
  const entry = currentTimings[index];
  if (!entry || !isReflowableAyah(entry.ayah)) {
    renderMarkers();
    renderTimingTable();
    highlightActiveRow();
    return;
  }

  manualAnchorAyahs.add(entry.ayah);
  const nextFixedAyah = getNextFixedAyah(entry.ayah);
  const requestId = ++reflowRequestId;

  try {
    const res = await fetch(`${API}/api/reflow/${currentSurah}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timings: currentTimings,
        silences: currentSilences,
        anchor_ayah: entry.ayah,
        next_fixed_ayah: nextFixedAyah,
      }),
    });
    const data = await res.json();
    if (requestId !== reflowRequestId) return;
    if (!res.ok || !data.success) throw new Error(data.error || 'Reflow failed');

    currentTimings = data.timings;
    renderMarkers();
    renderTimingTable();
    highlightActiveRow();
  } catch (e) {
    showToast(`Reflow failed: ${e.message}`, 'error');
    renderMarkers();
    renderTimingTable();
    highlightActiveRow();
  }
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    if (!currentSurah && !(e.metaKey || e.ctrlKey)) return;
    if (isTypingTarget(e.target)) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveToLocal();
      }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveToLocal();
      return;
    }

    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prevAyah();
      return;
    }

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      nextAyah();
      return;
    }

    if (e.key === '[') {
      e.preventDefault();
      setTrimFromPlayhead('start');
      return;
    }

    if (e.key === ']') {
      e.preventDefault();
      setTrimFromPlayhead('end');
      return;
    }

    if (e.key === '\\') {
      e.preventDefault();
      resetTrim();
      return;
    }

    if (e.key.toLowerCase() === 'a') {
      e.preventDefault();
      analyzeCurrent();
      return;
    }

    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomIn();
      return;
    }

    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomOut();
      return;
    }

    if (e.key === '0') {
      e.preventDefault();
      zoomReset();
    }
  });
}

function isTypingTarget(target) {
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

// ── Audio ───────────────────────────────────────────────────────────
function setupAudioEvents() {
  audioPlayer.addEventListener('timeupdate', () => { updatePlayhead(); updateTimeDisplay(); highlightActiveRow(); });
  audioPlayer.addEventListener('play', () => { playhead.style.display = 'block'; setPlayButtonState(true); });
  audioPlayer.addEventListener('pause', () => { setPlayButtonState(false); });
  audioPlayer.addEventListener('ended', () => { playhead.style.display = 'none'; setPlayButtonState(false); });
  setPlayButtonState(false);
}
function togglePlay() { audioPlayer.paused ? audioPlayer.play() : audioPlayer.pause(); }
function stopAudio() { audioPlayer.pause(); audioPlayer.currentTime = 0; playhead.style.display = 'none'; setPlayButtonState(false); document.getElementById('current-ayah-label').textContent = ''; }
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
    tr.innerHTML = `<td>${lbl}</td><td>${th}</td><td><input type="number" value="${t.time}" min="0" max="${durationMs}" data-index="${idx}" onchange="onTimingInput(this)"></td><td>${formatTime(t.time)}</td><td><button class="btn btn-sm" onclick="seekTo(${t.time})">Go</button> <button class="btn btn-sm" onclick="playFrom(${idx})">Play</button></td>`;
    tr.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') seekTo(t.time); });
    tb.appendChild(tr);
  });
}
function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
async function onTimingInput(inp) {
  const i = parseInt(inp.dataset.index, 10);
  const proposedTime = parseInt(inp.value, 10);
  const safeTime = Number.isFinite(proposedTime) ? proposedTime : currentTimings[i].time;
  currentTimings[i].time = clampMarkerTime(i, safeTime);
  inp.value = currentTimings[i].time;
  inp.closest('tr').querySelectorAll('td')[3].textContent = formatTime(currentTimings[i].time);
  renderMarkers();
  await reflowFromManualAdjustment(i);
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

// ── Debug Tab ────────────────────────────────────────────────────────
let lastDebugInfo = null;

function dbgTime(ms) {
  if (ms == null) return '—';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${m}:${String(s).padStart(2,'0')}.${String(r).padStart(3,'0')}`;
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.classList.toggle('tab-active', btn.dataset.tab === tab)
  );
  document.getElementById('editor-tab-panel').classList.toggle('hidden', tab !== 'editor');
  document.getElementById('debug-tab-panel').classList.toggle('hidden', tab !== 'debug');
  if (tab === 'editor') renderWaveform();
}

function renderDebugPanel(debugInfo, d) {
  lastDebugInfo = debugInfo;
  const steps = document.getElementById('debug-steps');
  const empty = document.getElementById('debug-empty');
  if (!debugInfo || !d) {
    steps.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  steps.classList.remove('hidden');
  const tag = document.getElementById('dbg-model-tag');
  if (tag && debugInfo.model_name) tag.textContent = debugInfo.model_name;
  renderDbgAudio(d, debugInfo);
  renderDbgSilences(d, debugInfo);
  renderDbgWhisper(d, debugInfo);
  renderDbgAlignment(d, debugInfo);
  renderDbgBoundaries(d, debugInfo);
}

function renderDbgAudio(d, dbg) {
  document.getElementById('dbg-audio').innerHTML = `
    <div class="dbg-kv">
      <span class="dbg-key">Duration</span>
      <span class="dbg-val">${dbgTime(d.duration_ms)} <span class="dbg-dim">(${d.duration_ms.toLocaleString()} ms)</span></span>
    </div>
    <div class="dbg-kv">
      <span class="dbg-key">dBFS</span>
      <span class="dbg-val">${dbg.audio_dbfs} dB</span>
    </div>
    <div class="dbg-kv">
      <span class="dbg-key">Ayahs</span>
      <span class="dbg-val">${d.num_ayahs}</span>
    </div>
    <div class="dbg-kv">
      <span class="dbg-key">Surah</span>
      <span class="dbg-val">${d.surah_name}</span>
    </div>`;
}

function renderDbgSilences(d, dbg) {
  const silences = d.silences || [];
  const raw = dbg.raw_silence_count ?? silences.length;
  const merged = dbg.merged_silence_count ?? silences.length;
  const rows = silences.slice(0, 120).map((s, i) => {
    const [st, en] = s;
    return `<tr><td>${i+1}</td><td>${dbgTime(st)}</td><td>${dbgTime(en)}</td><td>${(en-st).toLocaleString()} ms</td></tr>`;
  }).join('');
  document.getElementById('dbg-silences').innerHTML = `
    <div class="dbg-kv-row">
      <div class="dbg-kv"><span class="dbg-key">Detected (raw)</span><span class="dbg-val">${raw}</span></div>
      <div class="dbg-kv"><span class="dbg-key">After merge</span><span class="dbg-val">${merged}</span></div>
      <div class="dbg-kv"><span class="dbg-key">Removed</span><span class="dbg-val">${raw - merged}</span></div>
    </div>
    <div class="dbg-table-wrap">
      <table class="dbg-table">
        <thead><tr><th>#</th><th>Start</th><th>End</th><th>Duration</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${silences.length > 120 ? `<p class="dbg-note">Showing first 120 of ${silences.length}</p>` : ''}
    </div>`;
}

function renderDbgWhisper(d, dbg) {
  const words = dbg.whisper_words || [];
  const fullText = words.map(w => w.word).join(' ').trim();
  const rows = words.slice(0, 300).map((w, i) =>
    `<tr><td>${i+1}</td><td class="dbg-arabic-cell" dir="rtl">${esc(w.word)}</td><td>${dbgTime(w.start_ms)}</td><td>${dbgTime(w.end_ms)}</td><td>${(w.end_ms - w.start_ms)} ms</td></tr>`
  ).join('');
  document.getElementById('dbg-whisper').innerHTML = `
    <div class="dbg-kv-row">
      <div class="dbg-kv"><span class="dbg-key">Words</span><span class="dbg-val">${words.length}</span></div>
      <div class="dbg-kv"><span class="dbg-key">Ref size</span><span class="dbg-val">${dbg.ref_size ?? '—'}</span></div>
    </div>
    <div class="dbg-transcription">
      <span class="dbg-key">Full transcription</span>
      ${fullText
        ? `<p class="dbg-arabic" dir="rtl">${esc(fullText)}</p>`
        : `<p class="dbg-dim">No words transcribed</p>`}
    </div>
    <div class="dbg-table-wrap">
      <table class="dbg-table">
        <thead><tr><th>#</th><th>Word</th><th>Start</th><th>End</th><th>Duration</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${words.length > 300 ? `<p class="dbg-note">Showing first 300 of ${words.length}</p>` : ''}
    </div>`;
}

function renderDbgAlignment(d, dbg) {
  const rows = dbg.alignment_rows || [];
  const quality = dbg.alignment_quality != null ? (dbg.alignment_quality * 100).toFixed(1) + '%' : '—';
  const matched = dbg.matched_ref ?? 0;
  const refSize = dbg.ref_size ?? 0;
  const hypSize = dbg.hyp_size ?? 0;
  const qualNum = (dbg.alignment_quality ?? 0);
  const qualCls = qualNum >= 0.8 ? 'dbg-badge-yes' : qualNum >= 0.5 ? 'dbg-badge-warn' : 'dbg-badge-no';

  const trs = rows.slice(0, 200).map(r =>
    `<tr>
      <td>${r.ref_ayah === 0 ? 'bsm' : r.ref_ayah}</td>
      <td class="dbg-arabic-cell" dir="rtl">${esc(r.ref_word)}</td>
      <td class="dbg-arabic-cell" dir="rtl">${esc(r.hyp_word)}</td>
      <td>${dbgTime(r.start_ms)}</td>
      <td>${dbgTime(r.end_ms)}</td>
     </tr>`
  ).join('');

  document.getElementById('dbg-alignment').innerHTML = `
    <div class="dbg-kv-row">
      <div class="dbg-kv"><span class="dbg-key">Alignment quality</span><span class="dbg-badge ${qualCls}">${quality}</span></div>
      <div class="dbg-kv"><span class="dbg-key">Matched</span><span class="dbg-val">${matched} / ${refSize}</span></div>
      <div class="dbg-kv"><span class="dbg-key">Hypothesis words</span><span class="dbg-val">${hypSize}</span></div>
      <div class="dbg-kv"><span class="dbg-key">Missed</span><span class="dbg-val">${refSize - matched}</span></div>
    </div>
    <div class="dbg-table-wrap">
      <table class="dbg-table">
        <thead><tr><th>Ayah</th><th>Reference</th><th>Whisper</th><th>Start</th><th>End</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>
      ${rows.length > 200 ? `<p class="dbg-note">Showing first 200 matched pairs of ${rows.length}</p>` : ''}
    </div>`;
}

function renderDbgBoundaries(d, dbg) {
  const snap = dbg.snap_debug || [];
  const raw = dbg.ayah_raw_starts || {};
  const snapRange = dbg.boundary_search_range_ms;
  const effStart = dbg.effective_start_ms ?? 0;
  const effEnd = dbg.effective_end_ms ?? d.duration_ms;

  const rows = snap.map(r => {
    const ayah = r.ayah;
    const rawT = r.raw;
    const snapped = r.snapped;
    const dist = r.snap_dist;
    const snappedFlag = r.silence_idx != null;
    return `<tr>
      <td>${ayah === 0 ? 'bsm' : ayah}</td>
      <td>${dbgTime(rawT)}</td>
      <td>${dbgTime(snapped)}</td>
      <td class="w-r ${dist > 500 ? 'drift-hi' : ''}">${dist.toLocaleString()} ms</td>
      <td>${snappedFlag ? `#${r.silence_idx}` : '<span class="dbg-dim">—</span>'}</td>
     </tr>`;
  }).join('');

  document.getElementById('dbg-boundaries').innerHTML = `
    <div class="dbg-kv-row">
      <div class="dbg-kv"><span class="dbg-key">Content start</span><span class="dbg-val">${dbgTime(effStart)}</span></div>
      <div class="dbg-kv"><span class="dbg-key">Content end</span><span class="dbg-val">${dbgTime(effEnd)}</span></div>
      ${snapRange != null ? `<div class="dbg-kv"><span class="dbg-key">Snap range</span><span class="dbg-val">±${snapRange.toLocaleString()} ms</span></div>` : ''}
    </div>
    <div class="dbg-table-wrap">
      <table class="dbg-table">
        <thead><tr><th>Ayah</th><th>Whisper time</th><th>Snapped time</th><th>Drift</th><th>Silence</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}
