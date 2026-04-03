"""Audio analysis module: silence-ranked splitting with Whisper Basmallah detection."""

import logging

import numpy as np
from pydub import AudioSegment
from pydub.silence import detect_silence
from quran_metadata import AYAH_COUNTS, NO_BASMALLAH

logger = logging.getLogger(__name__)


def load_audio(filepath: str) -> AudioSegment:
    """Load an MP3 file."""
    return AudioSegment.from_mp3(filepath)


def _auto_detect_silences(audio: AudioSegment, num_ayahs: int = 7) -> list[tuple[int, int]]:
    """
    Auto-detect silences by trying multiple threshold/length combinations.
    Uses the audio's own loudness to pick a relative threshold.
    Scales seek_step with audio duration for performance on long surahs.
    """
    duration_ms = len(audio)
    audio_dbfs = audio.dBFS

    # Scale seek_step with duration: 5ms for short, up to 20ms for very long
    if duration_ms < 120_000:       # < 2 min
        seek_step = 5
    elif duration_ms < 600_000:     # < 10 min
        seek_step = 10
    else:                           # 10+ min (Al-Baqarah etc.)
        seek_step = 15

    # For very long surahs, use fewer threshold combos to keep analysis fast
    if duration_ms > 600_000:
        thresholds = [audio_dbfs - 10, audio_dbfs - 8]
        min_lengths = [150, 120]
    else:
        thresholds = [audio_dbfs - 12, audio_dbfs - 10, audio_dbfs - 8, audio_dbfs - 6]
        min_lengths = [120, 100, 80]

    # Upper bound on inner silences scales with ayah count
    max_inner = max(60, num_ayahs * 3)

    best_silences = []
    best_score = -1

    for thresh in thresholds:
        for min_len in min_lengths:
            silences = detect_silence(
                audio,
                min_silence_len=min_len,
                silence_thresh=thresh,
                seek_step=seek_step,
            )

            inner = [
                (s, e) for s, e in silences
                if s > 300 and e < duration_ms - 300
            ]

            count = len(inner)
            if count < 3:
                continue

            if count <= max_inner:
                if count > best_score:
                    best_score = count
                    best_silences = silences

        # Early exit if we already found a good result
        if best_score >= num_ayahs:
            break

    if not best_silences:
        best_silences = detect_silence(
            audio, min_silence_len=80, silence_thresh=audio_dbfs - 5, seek_step=seek_step
        )

    return best_silences


def _pick_splits(
    silences: list[tuple[int, int]],
    audio_duration_ms: int,
    needed_splits: int,
) -> list[int]:
    """
    Pick the best N split points from detected silences using duration ranking.

    Returns sorted list of split timestamps (midpoints of selected silences).
    """
    edge_margin = 500
    inner_silences = []
    leading_end = 0
    trailing_start = audio_duration_ms

    for s, e in silences:
        if s < edge_margin:
            leading_end = max(leading_end, e)
        elif e > audio_duration_ms - edge_margin:
            trailing_start = min(trailing_start, s)
        else:
            inner_silences.append((s, e, e - s))

    ranked = sorted(inner_silences, key=lambda x: x[2], reverse=True)

    if len(ranked) >= needed_splits:
        selected = ranked[:needed_splits]
    else:
        selected = ranked[:]
        existing_times = sorted([((s + e) // 2) for s, e, _ in selected])
        content_start = leading_end if leading_end > 0 else 0
        content_end = trailing_start

        missing = needed_splits - len(selected)
        if missing > 0:
            all_boundaries = [content_start] + existing_times + [content_end]
            for _ in range(missing):
                max_gap = 0
                max_idx = 0
                for i in range(len(all_boundaries) - 1):
                    gap = all_boundaries[i + 1] - all_boundaries[i]
                    if gap > max_gap:
                        max_gap = gap
                        max_idx = i
                mid = (all_boundaries[max_idx] + all_boundaries[max_idx + 1]) // 2
                all_boundaries.insert(max_idx + 1, mid)
                selected.append((mid - 25, mid + 25, 50))

    selected_sorted = sorted(selected, key=lambda x: x[0])
    return [((s + e) // 2) for s, e, _ in selected_sorted]


def estimate_ayah_splits(
    surah_number: int,
    audio_duration_ms: int,
    silences: list[tuple[int, int]],
    basmallah_info: dict | None = None,
) -> list[dict]:
    """
    Estimate ayah splitting points using silence-ranking + Basmallah detection.

    basmallah_info: result from basmallah_detector.detect_basmallah() or None.
      - has_basmallah: whether Whisper detected Basmallah at the start
      - basmallah_end_ms: where the Basmallah recitation ends

    Logic:
      Al-Fatiha (surah 1):
        Basmallah IS ayah 1. Always ayah 0=0, ayah 1=0.
        Need num_ayahs-1 inter-ayah splits.

      Surah 9 (At-Tawba):
        No basmallah ever. ayah 0=0, ayah 1=0.
        Need num_ayahs-1 inter-ayah splits.

      Other surahs WITH detected Basmallah:
        Reciter says Basmallah before ayah 1. ayah 0=0.
        Ayah 1 starts AFTER Basmallah (at basmallah_end_ms or first big silence).
        Need num_ayahs-1 inter-ayah splits AFTER that point.

      Other surahs WITHOUT detected Basmallah:
        Reciter skips Basmallah, goes straight to ayah 1. ayah 0=0, ayah 1=0.
        Need num_ayahs-1 inter-ayah splits.
    """
    num_ayahs = AYAH_COUNTS[surah_number]

    has_bsm_detected = False
    bsm_end_ms = None
    if basmallah_info and basmallah_info.get("has_basmallah"):
        has_bsm_detected = True
        bsm_end_ms = basmallah_info.get("basmallah_end_ms")

    timings = []
    timings.append({"ayah": 0, "time": 0})

    if surah_number == 1:
        # Al-Fatiha: Basmallah IS ayah 1
        # Need 6 splits between ayahs 1-7
        split_points = _pick_splits(silences, audio_duration_ms, num_ayahs - 1)
        timings.append({"ayah": 1, "time": 0})
        for i, t in enumerate(split_points):
            timings.append({"ayah": i + 2, "time": t})

    elif surah_number in NO_BASMALLAH:
        # Surah 9: no basmallah
        split_points = _pick_splits(silences, audio_duration_ms, num_ayahs - 1)
        timings.append({"ayah": 1, "time": 0})
        for i, t in enumerate(split_points):
            timings.append({"ayah": i + 2, "time": t})

    elif has_bsm_detected:
        # Reciter says Basmallah. We need to find where it ends to start ayah 1.
        #
        # Use Whisper's basmallah_end_ms if available, otherwise find the first
        # major silence after the start as the basmallah/ayah1 boundary.
        if bsm_end_ms and bsm_end_ms > 500:
            ayah1_start = bsm_end_ms
        else:
            # Fallback: use the first significant inner silence as boundary
            edge_margin = 500
            inner = [(s, e, e - s) for s, e in silences
                     if s > edge_margin and e < audio_duration_ms - edge_margin]
            if inner:
                # First significant silence (sorted by time)
                first_by_time = sorted(inner, key=lambda x: x[0])
                ayah1_start = (first_by_time[0][0] + first_by_time[0][1]) // 2
            else:
                ayah1_start = 0

        # Snap ayah1_start to the nearest silence midpoint
        ayah1_start = _snap_to_silence(silences, ayah1_start, search_range=3000)

        # Now split the rest of the audio (after ayah1_start) into num_ayahs-1 parts
        # Filter silences to only those AFTER ayah1_start
        remaining_silences = [(s, e) for s, e in silences if s > ayah1_start]
        inter_ayah_splits = _pick_splits(
            remaining_silences,
            audio_duration_ms,
            num_ayahs - 1,
        )

        timings.append({"ayah": 1, "time": ayah1_start})
        for i, t in enumerate(inter_ayah_splits):
            timings.append({"ayah": i + 2, "time": t})

    else:
        # No basmallah detected: reciter starts with ayah 1 directly
        split_points = _pick_splits(silences, audio_duration_ms, num_ayahs - 1)
        timings.append({"ayah": 1, "time": 0})
        for i, t in enumerate(split_points):
            timings.append({"ayah": i + 2, "time": t})

    timings.append({"ayah": 999, "time": audio_duration_ms})
    return timings


def _snap_to_silence(
    silences: list[tuple[int, int]], target_ms: int, search_range: int = 3000
) -> int:
    """Snap a timestamp to the nearest silence midpoint within range."""
    candidates = []
    for s, e in silences:
        mid = (s + e) // 2
        if abs(mid - target_ms) <= search_range:
            candidates.append(mid)
    if candidates:
        return min(candidates, key=lambda m: abs(m - target_ms))
    return target_ms


def analyze_surah(filepath: str, surah_number: int, **kwargs) -> dict:
    """
    Full analysis of a surah audio file.

    1. Load audio and detect silences
    2. Run Whisper on the first 10s to detect Basmallah
    3. Use detection result to inform splitting strategy
    """
    audio = load_audio(filepath)
    duration_ms = len(audio)
    num_ayahs = AYAH_COUNTS[surah_number]

    silences = _auto_detect_silences(audio, num_ayahs=num_ayahs)

    # Detect basmallah with Whisper (skip for surah 9 which never has it)
    basmallah_info = None
    if surah_number not in NO_BASMALLAH:
        try:
            from basmallah_detector import detect_basmallah
            basmallah_info = detect_basmallah(audio)
            logger.info(
                f"Surah {surah_number}: basmallah={'YES' if basmallah_info['has_basmallah'] else 'NO'}"
                f" | end={basmallah_info.get('basmallah_end_ms')}ms"
                f" | text={basmallah_info['transcription'][:80]}"
            )
        except Exception as e:
            logger.warning(f"Whisper basmallah detection failed for surah {surah_number}: {e}")
            basmallah_info = None

    timings = estimate_ayah_splits(surah_number, duration_ms, silences, basmallah_info)

    return {
        "surah": surah_number,
        "duration_ms": duration_ms,
        "silences": silences,
        "timings": timings,
        "num_ayahs": AYAH_COUNTS[surah_number],
        "basmallah_detected": basmallah_info["has_basmallah"] if basmallah_info else None,
        "basmallah_transcription": basmallah_info["transcription"] if basmallah_info else None,
    }


def get_waveform_data(filepath: str, num_points: int = 2000) -> list[float]:
    """
    Extract waveform amplitude data for visualization.
    Returns normalized amplitude values (0.0 to 1.0).
    """
    audio = load_audio(filepath)
    samples = np.array(audio.get_array_of_samples(), dtype=np.float64)

    if audio.channels == 2:
        samples = samples[::2]

    chunk_size = max(1, len(samples) // num_points)
    amplitudes = []
    for i in range(0, len(samples), chunk_size):
        chunk = samples[i : i + chunk_size]
        amplitudes.append(float(np.abs(chunk).mean()))

    max_amp = max(amplitudes) if amplitudes else 1.0
    if max_amp > 0:
        amplitudes = [a / max_amp for a in amplitudes]

    return amplitudes[:num_points]
