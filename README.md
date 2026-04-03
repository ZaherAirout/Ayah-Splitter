# Ayah Splitter

Audio ayah timing tool for [quran_android](https://github.com/quran/quran_android). Automatically detects silence-based splitting points in surah MP3 files and generates compatible SQLite timing databases.

## Features

- **Automatic silence detection** to estimate ayah boundaries
- **Waveform visualization** with draggable markers for manual adjustment
- **Audio playback** with seek-to-ayah and speed control
- **SQLite export** in quran_android's gapless timing format (`.db.zip`)
- **Batch processing** for all 114 surahs
- **Docker-ready** for easy deployment

## Quick Start (Docker)

```bash
# 1. Place MP3 files in audio_input/ (named 001.mp3 to 114.mp3)
mkdir -p audio_input output

# 2. Build and run
docker compose up --build

# 3. Open browser
open http://localhost:8080
```

## Usage

1. **Upload** - Drag & drop your surah MP3 files (named `1.mp3`/`001.mp3` to `114.mp3`)
2. **Analyze** - Click "Analyze All Surahs" to auto-detect splitting points via silence detection
3. **Review** - Select a surah to see the waveform with ayah markers. Drag markers to adjust.
4. **Export** - Click "Export .db.zip" to generate the quran_android compatible timing database

## Output Format

The exported `.db` file contains:

| Table | Columns | Description |
|-------|---------|-------------|
| `timings` | `sura`, `ayah`, `time` | Ayah timestamps in milliseconds |
| `properties` | `property`, `value` | Schema version metadata |

Special ayah values:
- `ayah=0`: Basmallah start position
- `ayah=1..N`: Ayah start positions
- `ayah=999`: End-of-surah marker

## Development (without Docker)

```bash
cd backend
pip install -r requirements.txt
UPLOAD_DIR=../audio_input OUTPUT_DIR=../output python app.py
```

## MP3 File Naming

Files should be named by surah number: `1.mp3`, `2.mp3`, ... `114.mp3` (or zero-padded: `001.mp3`).
