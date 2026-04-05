# Ayah Splitter

Audio ayah timing tool for [quran_android](https://github.com/quran/quran_android). Automatically detects ayah boundaries in surah MP3 files and generates compatible SQLite timing databases.

## Quick Start

```bash
docker compose up --build
open http://localhost:8080
```

## How It Works

### Splitting Algorithm

The tool uses a multi-stage pipeline to detect ayah boundaries:

1. **Basmallah Detection** (Whisper AI + Heuristic)
   - Extracts first 15 seconds of audio
   - Runs `faster-whisper` (small model, offline) to transcribe and check for "بسم الله" patterns
   - Falls back to silence-pattern heuristic: detects audio content followed by a significant gap (150ms+) in the 1.5-10s range after content starts
   - **Rules**: Basmallah can only appear at position 0 (start of file), never in the middle. Al-Fatiha's Basmallah IS ayah 1. Surah 9 (At-Tawba) never has Basmallah.

2. **Silence Detection** (auto-tuned)
   - Scans audio with multiple threshold/min-length combinations relative to the audio's own loudness (dBFS)
   - Seek step scales with duration: 5ms for short surahs, 15ms for long ones (Al-Baqarah = 2+ hours)
   - Produces a ranked list of silence candidates

3. **Proportional Estimation**
   - Uses per-ayah word counts (where available) or equal-weight distribution
   - Computes expected timestamp for each ayah boundary based on proportional duration

4. **Silence Snapping**
   - Each estimated boundary is snapped to the nearest detected silence midpoint
   - Scoring: prefers closer silences, with a bonus for longer silence gaps
   - Greedy assignment ensures no two ayahs share the same silence

5. **Constraint Enforcement**
   - All ayah times are strictly ascending (ayah 1 < ayah 2 < ... < ayah N)
   - Minimum 100ms gap between consecutive ayahs
   - ayah 0 = Basmallah marker (always at 0 or at effective trim start)
   - ayah 999 = end-of-surah marker

### Output Format

SQLite `.db` file matching quran_android's gapless timing schema:

| Table | Columns | Description |
|-------|---------|-------------|
| `timings` | `sura`, `ayah`, `time` | Timestamps in milliseconds |
| `properties` | `property`, `value` | `version`, `schema_version` |

Special ayah values: `0` = Basmallah, `1..N` = ayahs, `999` = end marker.

## Usage

1. **Upload** — Select a surah number, then upload any MP3 file. Or drag & drop files named `1.mp3`-`114.mp3`.

2. **Analyze** — Click "Analyze" to run the detection pipeline. The tool will:
   - Auto-detect Basmallah using Whisper AI
   - Find silence gaps and snap ayah boundaries to them
   - Display results on a zoomable waveform with draggable markers

3. **Review** — Use the waveform to verify:
   - **Zoom**: Ctrl+Scroll or buttons to zoom in/out
   - **Navigate**: Prev/Next buttons jump between ayahs
   - **Trim**: Cut silence from start/end of recording
   - **Drag**: Move ayah markers on the waveform
   - **Edit**: Type exact ms values in the timing table

4. **Save** — Click "Save Surah" to store timings in browser localStorage (persists across sessions). Audio files are cached in IndexedDB.

5. **Export** — Click "Export .db.zip" to generate the quran_android compatible database from all saved surahs.

## Architecture

```
ayah-splitter/
├── backend/
│   ├── app.py                 # Flask API
│   ├── audio_analyzer.py      # Core splitting algorithm
│   ├── basmallah_detector.py  # Whisper + heuristic detection
│   ├── db_export.py           # SQLite export
│   ├── quran_metadata.py      # 114 surahs, ayah counts
│   ├── quran_text.py          # Arabic ayah text
│   └── download_quran_text.py # Fetch full Quran text from API
├── frontend/
│   ├── index.html
│   └── static/
│       ├── app.js             # UI + localStorage + IndexedDB
│       └── style.css
├── Dockerfile
├── docker-compose.yml
└── audio_input/               # Mounted volume for MP3 files
```

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `WHISPER_MODEL` | `small` | Whisper model size (`tiny`, `base`, `small`, `medium`) |
| `PORT` | `8080` | Server port |

Larger Whisper models improve Basmallah detection accuracy but are slower. The `small` model is a good balance.

## Development (without Docker)

```bash
# Install ffmpeg (required)
brew install ffmpeg  # macOS

cd backend
pip install -r requirements.txt
python download_quran_text.py  # Optional: fetch full Arabic text
UPLOAD_DIR=../audio_input OUTPUT_DIR=../output python app.py
```
