"""
Audio analysis module: Enhanced ayah splitting algorithm.

Strategy (in order of priority):
1. Whisper detects Basmallah at the start (first 15s only)
2. Silence detection finds all candidate split points
3. Ayah word-counts provide proportional time estimates
4. Each estimated boundary is snapped to the nearest silence
5. Constraints enforced: Basmallah only at 0, ayahs strictly sequential
"""

import logging
import re
import numpy as np
from pydub import AudioSegment
from pydub.silence import detect_silence
from quran_metadata import AYAH_COUNTS, NO_BASMALLAH
from quran_text import get_surah_text

logger = logging.getLogger(__name__)


# ── Approximate word counts per ayah for key surahs ─────────────────
# Used for proportional time estimation. Maps surah -> list of per-ayah
# word counts (index 0 = ayah 1). For surahs not listed, we use the
# global average from SURAH_AVG_WORDS_PER_AYAH.
_AYAH_WORD_COUNTS: dict[int, list[int]] = {
    1: [4, 4, 2, 2, 4, 3, 9],  # Al-Fatiha
}

_WORD_RE = re.compile(r"[0-9A-Za-z\u0621-\u063a\u0641-\u064a]+")


def load_audio(filepath: str) -> AudioSegment:
    return AudioSegment.from_mp3(filepath)


def _safe_dbfs(audio: AudioSegment) -> float:
    dbfs = audio.dBFS
    if len(audio) == 0 or dbfs == float("-inf"):
        return -120.0
    return dbfs


def _merge_close_silences(
    audio: AudioSegment,
    silences: list[tuple[int, int]],
    max_gap_ms: int = 120,
) -> list[tuple[int, int]]:
    """Merge silence spans that are only split by a tiny, low-energy bridge."""
    if not silences:
        return []

    merged = [[silences[0][0], silences[0][1]]]
    audio_dbfs = _safe_dbfs(audio)

    for start, end in silences[1:]:
        prev = merged[-1]
        gap = start - prev[1]
        if gap <= max_gap_ms:
            bridge = audio[prev[1]:start]
            if gap <= 35 or _safe_dbfs(bridge) <= audio_dbfs + 3:
                prev[1] = max(prev[1], end)
                continue
        merged.append([start, end])

    return [(start, end) for start, end in merged]


def _detect_silences(audio: AudioSegment, num_ayahs: int) -> tuple[list, list]:
    """Returns (raw_silences, merged_silences). Auto-detects using scaled thresholds."""
    duration_ms = len(audio)
    audio_dbfs = audio.dBFS

    if duration_ms < 120_000:
        seek_step = 5
    elif duration_ms < 600_000:
        seek_step = 10
    else:
        seek_step = 15

    if duration_ms > 600_000:
        thresholds = [audio_dbfs - 10, audio_dbfs - 8]
        min_lengths = [150, 120]
    else:
        thresholds = [audio_dbfs - 12, audio_dbfs - 10, audio_dbfs - 8, audio_dbfs - 6]
        min_lengths = [120, 100, 80]

    max_inner = max(60, num_ayahs * 3)
    best_silences = []
    best_score = -1

    for thresh in thresholds:
        for min_len in min_lengths:
            silences = detect_silence(
                audio, min_silence_len=min_len, silence_thresh=thresh, seek_step=seek_step
            )
            inner = [(s, e) for s, e in silences if s > 300 and e < duration_ms - 300]
            count = len(inner)
            if count < 3:
                continue
            if count <= max_inner and count > best_score:
                best_score = count
                best_silences = silences
        if best_score >= num_ayahs:
            break

    if not best_silences:
        best_silences = detect_silence(
            audio, min_silence_len=80, silence_thresh=audio_dbfs - 5, seek_step=seek_step
        )

    merged = _merge_close_silences(audio, best_silences)
    return best_silences, merged


def _count_ayah_words(text: str) -> int:
    return len(_WORD_RE.findall(text or ""))


def _get_text_word_counts(surah_number: int) -> list[int] | None:
    """Use actual ayah text when available so long ayahs get proportionally more time."""
    num_ayahs = AYAH_COUNTS[surah_number]
    text = get_surah_text(surah_number)

    if not text or len(text) != num_ayahs:
        return None

    counts = [max(1, _count_ayah_words(text.get(ayah, ""))) for ayah in range(1, num_ayahs + 1)]
    if sum(counts) <= num_ayahs:
        return None

    return counts


def _get_ayah_weights(surah_number: int) -> list[float]:
    """
    Return relative weights for each ayah based on approximate word counts.
    Longer ayahs get proportionally more audio time.
    """
    num_ayahs = AYAH_COUNTS[surah_number]

    text_counts = _get_text_word_counts(surah_number)
    if text_counts:
        total = sum(text_counts)
        return [count / total for count in text_counts]

    if surah_number in _AYAH_WORD_COUNTS:
        words = _AYAH_WORD_COUNTS[surah_number]
        # Ensure list length matches
        if len(words) == num_ayahs:
            total = sum(words)
            return [w / total for w in words]

    # Fallback: use equal weights (each ayah gets same proportion)
    # This is a reasonable default since we don't have per-ayah word counts
    # for all surahs, and the silence-snapping will refine positions anyway.
    return [1.0 / num_ayahs] * num_ayahs


def _get_segment_weights(
    surah_number: int,
    start_ayah: int,
    end_ayah: int,
) -> list[float]:
    """Return normalized weights for an inclusive ayah slice."""
    all_weights = _get_ayah_weights(surah_number)
    segment = all_weights[start_ayah - 1:end_ayah]
    total = sum(segment)
    if not segment or total <= 0:
        return []
    return [weight / total for weight in segment]


def _estimate_positions(
    num_splits: int,
    content_start_ms: int,
    content_end_ms: int,
    weights: list[float] | None = None,
) -> list[int]:
    """
    Estimate split positions using proportional weights.
    Returns `num_splits` timestamps between content_start and content_end.
    """
    duration = content_end_ms - content_start_ms
    if weights and len(weights) >= num_splits:
        # Cumulative sum of weights gives split positions
        positions = []
        cumsum = 0.0
        for i in range(num_splits):
            cumsum += weights[i]
            positions.append(content_start_ms + int(cumsum * duration))
        return positions
    else:
        # Equal spacing fallback
        step = duration / (num_splits + 1)
        return [content_start_ms + int(step * (i + 1)) for i in range(num_splits)]


def _get_boundary_search_range(
    content_start_ms: int,
    content_end_ms: int,
    num_ayahs: int,
) -> int:
    span_ms = max(1, content_end_ms - content_start_ms)
    avg_ayah_ms = span_ms / max(1, num_ayahs)
    return int(max(900, min(3500, avg_ayah_ms * 0.45)))


def _find_opening_boundary_candidate(
    silences: list[tuple[int, int]],
    effective_start_ms: int,
    effective_end_ms: int,
) -> int | None:
    """Fallback for manually-forced basmallah mode when the model cannot place ayah 1."""
    window_end = min(effective_end_ms - 300, effective_start_ms + 8000)
    candidates = []

    for start, end in silences:
        duration = end - start
        midpoint = (start + end) // 2
        if start < effective_start_ms + 1200 or end > window_end or duration < 120:
            continue

        score = (duration * 1.6) - max(0, midpoint - (effective_start_ms + 4500)) * 0.04
        candidates.append((score, midpoint))

    if not candidates:
        return None

    candidates.sort(reverse=True)
    return candidates[0][1]


def _snap_to_silences(
    estimates: list[int],
    silences: list[tuple[int, int]],
    search_range_ms: int = 5000,
) -> list[int]:
    """
    Snap each estimated position to the nearest silence midpoint.
    Ensures no two estimates snap to the same silence (greedy assignment).
    Returns strictly ascending list of positions.
    """
    midpoints = [((s + e) // 2, e - s) for s, e in silences]
    used = set()
    result = []

    for est in estimates:
        # Find candidates within range, sorted by distance
        candidates = [
            (i, mid, dur)
            for i, (mid, dur) in enumerate(midpoints)
            if abs(mid - est) <= search_range_ms and i not in used
        ]
        # Prefer closer, but give bonus to longer silences
        if candidates:
            candidates.sort(key=lambda c: abs(c[1] - est) - c[2] * 0.3)
            best_idx, best_mid, _ = candidates[0]
            used.add(best_idx)
            result.append(best_mid)
        else:
            result.append(est)

    # Enforce strictly ascending order
    for i in range(1, len(result)):
        if result[i] <= result[i - 1]:
            result[i] = result[i - 1] + 100  # Push forward by 100ms minimum

    return result


def estimate_ayah_splits(
    surah_number: int,
    audio_duration_ms: int,
    silences: list[tuple[int, int]],
    basmallah_info: dict | None = None,
    trim_start_ms: int = 0,
    trim_end_ms: int = 0,
) -> tuple[list[dict], dict]:
    """
    Estimate ayah splitting points.

    Rules:
    - Basmallah (ayah 0) is ALWAYS at time 0 (or absent for surah 9)
    - If Basmallah is detected AND surah != 1: ayah 1 starts after Basmallah
    - Ayahs are ALWAYS in sequential order with increasing timestamps
    - ayah 999 marks end of surah

    Args:
        trim_start_ms: Skip this many ms from the start
        trim_end_ms: Skip this many ms from the end
    """
    num_ayahs = AYAH_COUNTS[surah_number]
    effective_start = trim_start_ms
    effective_end = audio_duration_ms - trim_end_ms

    has_bsm = False
    bsm_end_ms = None
    bsm_method = None
    if basmallah_info and basmallah_info.get("has_basmallah"):
        has_bsm = True
        bsm_end_ms = basmallah_info.get("basmallah_end_ms")
        bsm_method = basmallah_info.get("method")

    # Filter silences to effective range
    eff_silences = [
        (s, e) for s, e in silences
        if s >= effective_start and e <= effective_end
    ]

    timings = []
    timings.append({"ayah": 0, "time": effective_start})

    weights = _get_ayah_weights(surah_number)
    boundary_search_range_ms = _get_boundary_search_range(
        effective_start, effective_end, num_ayahs
    )
    _dbg_estimates: list[int] = []

    if surah_number == 1:
        # Al-Fatiha: Basmallah IS ayah 1
        timings.append({"ayah": 1, "time": effective_start})
        estimates = _estimate_positions(
            num_ayahs - 1, effective_start, effective_end, weights
        )
        snapped = _snap_to_silences(
            estimates, eff_silences, search_range_ms=boundary_search_range_ms
        )
        _dbg_estimates = estimates
        # Enforce: each split > previous
        prev = effective_start
        for i, t in enumerate(snapped):
            t = max(t, prev + 100)
            timings.append({"ayah": i + 2, "time": t})
            prev = t

    elif surah_number in NO_BASMALLAH:
        # Surah 9: no Basmallah
        timings.append({"ayah": 1, "time": effective_start})
        estimates = _estimate_positions(
            num_ayahs - 1, effective_start, effective_end, weights
        )
        snapped = _snap_to_silences(
            estimates, eff_silences, search_range_ms=boundary_search_range_ms
        )
        _dbg_estimates = estimates
        prev = effective_start
        for i, t in enumerate(snapped):
            t = max(t, prev + 100)
            timings.append({"ayah": i + 2, "time": t})
            prev = t

    elif has_bsm:
        # Reciter says Basmallah before ayah 1
        ayah1_start = bsm_end_ms or effective_start
        ayah1_start = max(ayah1_start, effective_start)
        # Snap AI-estimated boundaries to the nearest silence, but keep manual values exact.
        candidates = [
            (s, e) for s, e in eff_silences
            if s > effective_start + 600 and abs(((s + e) // 2) - ayah1_start) <= boundary_search_range_ms
        ]
        if candidates and bsm_method != "manual":
            mids = [((s + e) // 2, e - s) for s, e in candidates]
            # Find closest to estimated basmallah end
            mids.sort(key=lambda m: abs(m[0] - ayah1_start) - m[1] * 0.2)
            ayah1_start = mids[0][0]

        timings.append({"ayah": 1, "time": ayah1_start})

        # Split remaining audio into num_ayahs-1 inter-ayah boundaries
        remaining_silences = [(s, e) for s, e in eff_silences if s > ayah1_start]
        estimates = _estimate_positions(
            num_ayahs - 1, ayah1_start, effective_end, weights
        )
        snapped = _snap_to_silences(
            estimates, remaining_silences, search_range_ms=boundary_search_range_ms
        )
        _dbg_estimates = estimates
        prev = ayah1_start
        for i, t in enumerate(snapped):
            t = max(t, prev + 100)
            timings.append({"ayah": i + 2, "time": t})
            prev = t

    else:
        # No Basmallah detected
        timings.append({"ayah": 1, "time": effective_start})
        estimates = _estimate_positions(
            num_ayahs - 1, effective_start, effective_end, weights
        )
        snapped = _snap_to_silences(
            estimates, eff_silences, search_range_ms=boundary_search_range_ms
        )
        _dbg_estimates = estimates
        prev = effective_start
        for i, t in enumerate(snapped):
            t = max(t, prev + 100)
            timings.append({"ayah": i + 2, "time": t})
            prev = t

    timings.append({"ayah": 999, "time": effective_end})

    # Final validation: ensure strict ordering
    _enforce_ordering(timings)

    _debug = {
        "weights": weights,
        "effective_start_ms": effective_start,
        "effective_end_ms": effective_end,
        "boundary_search_range_ms": boundary_search_range_ms,
        "estimated_positions": _dbg_estimates,
    }
    return timings, _debug


def _enforce_ordering(timings: list[dict]):
    """Ensure all timing entries are in strict ascending order by ayah and time."""
    # Sort by ayah number
    timings.sort(key=lambda t: (t["ayah"] if t["ayah"] != 999 else 99999))
    # Ensure times are non-decreasing (ayah 0 and 1 can share time 0)
    for i in range(2, len(timings)):
        if timings[i]["time"] <= timings[i - 1]["time"]:
            timings[i]["time"] = timings[i - 1]["time"] + 100


def reflow_timings_from_anchor(
    surah_number: int,
    timings: list[dict],
    silences: list[list[int] | tuple[int, int]],
    anchor_ayah: int,
    next_fixed_ayah: int = 999,
) -> list[dict]:
    """
    Re-estimate ayah starts after a manually moved anchor.

    Keeps ayahs up to `anchor_ayah` fixed and recomputes later ayahs until
    `next_fixed_ayah` (or the end marker 999) using the existing weighting
    and silence snapping logic.
    """
    num_ayahs = AYAH_COUNTS[surah_number]
    if anchor_ayah < 1 or anchor_ayah > num_ayahs:
        raise ValueError("anchor_ayah must be between 1 and the last ayah")
    if next_fixed_ayah != 999 and (next_fixed_ayah <= anchor_ayah or next_fixed_ayah > num_ayahs):
        raise ValueError("next_fixed_ayah must be greater than anchor_ayah or 999")

    entries = [dict(entry) for entry in timings]
    entries.sort(key=lambda t: (t["ayah"] if t["ayah"] != 999 else 99999))
    by_ayah = {entry["ayah"]: entry for entry in entries}

    if anchor_ayah not in by_ayah or 999 not in by_ayah:
        raise ValueError("timings must include the anchor ayah and 999 end marker")
    if next_fixed_ayah != 999 and next_fixed_ayah not in by_ayah:
        raise ValueError("timings must include the requested next_fixed_ayah")

    anchor_time_ms = int(by_ayah[anchor_ayah]["time"])
    segment_end_ms = int(by_ayah[next_fixed_ayah]["time"] if next_fixed_ayah != 999 else by_ayah[999]["time"])
    last_segment_ayah = num_ayahs if next_fixed_ayah == 999 else next_fixed_ayah - 1
    remaining_boundaries = max(0, last_segment_ayah - anchor_ayah)

    min_required_gap = 100 * (remaining_boundaries + 1)
    if segment_end_ms - anchor_time_ms < min_required_gap:
        raise ValueError("Not enough room after the moved ayah to reflow later ayahs")

    clean_silences = [(int(s), int(e)) for s, e in silences]
    eff_silences = [
        (s, e) for s, e in clean_silences
        if s >= anchor_time_ms and e <= segment_end_ms
    ]

    if remaining_boundaries > 0:
        segment_weights = _get_segment_weights(surah_number, anchor_ayah, last_segment_ayah)
        estimates = _estimate_positions(
            remaining_boundaries,
            anchor_time_ms,
            segment_end_ms,
            segment_weights,
        )
        search_range_ms = _get_boundary_search_range(
            anchor_time_ms,
            segment_end_ms,
            len(segment_weights) or (remaining_boundaries + 1),
        )
        snapped = _snap_to_silences(
            estimates,
            eff_silences,
            search_range_ms=search_range_ms,
        )

        prev = anchor_time_ms
        for ayah, time_ms in zip(range(anchor_ayah + 1, last_segment_ayah + 1), snapped):
            by_ayah[ayah]["time"] = max(int(time_ms), prev + 100)
            prev = by_ayah[ayah]["time"]

    result = [by_ayah[ayah] for ayah in sorted(by_ayah, key=lambda ayah: ayah if ayah != 999 else 99999)]
    return result


def _snap_boundary_to_silence(
    t_ms: int,
    silences: list[tuple[int, int]],
    max_dist_ms: int = 800,
) -> tuple[int, int | None]:
    """Snap a boundary to the nearest silence midpoint within max_dist_ms.

    Returns (snapped_time_ms, silence_index_or_None).
    """
    best = None
    best_dist = max_dist_ms + 1
    for i, (s, e) in enumerate(silences):
        mid = (s + e) // 2
        dist = abs(mid - t_ms)
        duration = max(1, e - s)
        # Prefer closer silences, with a small bonus for longer gaps
        score = dist - min(duration, 400) * 0.25
        if dist <= max_dist_ms and score < best_dist:
            best_dist = score
            best = (mid, i)
    if best is None:
        return t_ms, None
    return best[0], best[1]


def analyze_surah(
    filepath: str,
    surah_number: int,
    trim_start_ms: int = 0,
    trim_end_ms: int = 0,
    basmallah_mode: str = "auto",
    manual_basmallah_end_ms: int | None = None,
    progress_cb=None,
    **kwargs,
) -> dict:
    """
    Full analysis pipeline:
    1. Load audio
    2. Detect silences (for boundary snapping)
    3. Transcribe full audio with tarteel-ai/whisper-base-ar-quran
       (word-level timestamps)
    4. Align whisper words to canonical Quran text
    5. Derive per-ayah start times from alignment
    6. Snap each boundary to the nearest silence for acoustic precision
    """
    from whisper_quran import transcribe_words, MODEL_NAME
    from ayah_aligner import compute_boundaries

    def _progress(pct: int, msg: str):
        if progress_cb:
            progress_cb(pct, msg)

    _progress(5, "Loading audio")
    audio = load_audio(filepath)
    duration_ms = len(audio)
    num_ayahs = AYAH_COUNTS[surah_number]
    effective_start = trim_start_ms
    effective_end = max(trim_start_ms, duration_ms - trim_end_ms)

    _progress(15, "Detecting silences")
    raw_silences, silences = _detect_silences(audio, num_ayahs=num_ayahs)

    # Limit transcription to the trimmed audio window for speed & accuracy.
    audio_clip = audio[effective_start:effective_end]
    logger.info(
        f"Surah {surah_number}: transcribing {len(audio_clip)/1000:.1f}s with {MODEL_NAME}"
    )
    _progress(25, "Transcribing audio with Whisper…")
    hypothesis = transcribe_words(audio_clip)
    _progress(75, "Aligning to reference text")
    # Shift timestamps back to absolute positions
    for w in hypothesis:
        w["start_ms"] = int(w["start_ms"]) + effective_start
        w["end_ms"] = int(w["end_ms"]) + effective_start

    weights = _get_ayah_weights(surah_number)
    alignment_result = compute_boundaries(
        surah_number,
        hypothesis,
        content_start_ms=effective_start,
        content_end_ms=effective_end,
        weights=weights,
    )

    ayah_starts = alignment_result["ayah_starts"]
    include_bsm = alignment_result["include_basmallah"]

    # Manual override for basmallah mode
    if basmallah_mode == "absent":
        include_bsm = False
        ayah_starts.pop(0, None)
        if surah_number == 1:
            # Fatiha: basmallah IS ayah 1, user can't "remove" it
            include_bsm = False
    elif basmallah_mode == "present" and surah_number not in NO_BASMALLAH and surah_number != 1:
        include_bsm = True
        if manual_basmallah_end_ms is not None:
            ayah_starts[0] = effective_start
            ayah_starts[1] = int(manual_basmallah_end_ms)

    # Snap each boundary to nearest silence for acoustic precision
    snapped_starts: dict[int, int] = {}
    snap_debug: list[dict] = []
    boundary_range_ms = _get_boundary_search_range(
        effective_start, effective_end, num_ayahs
    )
    snap_range = min(800, max(250, boundary_range_ms // 2))

    _progress(85, "Snapping boundaries to silences")
    for ayah, t in ayah_starts.items():
        # Never snap ayah-0 start (always at content_start) or ayah-1-start for Fatiha
        if ayah == 0 or (ayah == 1 and (surah_number == 1 or not include_bsm)):
            snapped_starts[ayah] = effective_start
            snap_debug.append({"ayah": ayah, "raw": t, "snapped": effective_start, "snap_dist": 0})
            continue
        snapped, idx = _snap_boundary_to_silence(t, silences, max_dist_ms=snap_range)
        snapped_starts[ayah] = snapped
        snap_debug.append({
            "ayah": ayah,
            "raw": t,
            "snapped": snapped,
            "snap_dist": abs(snapped - t),
            "silence_idx": idx,
        })

    # Build timings list (ayah 0, 1, 2, ..., N, 999)
    timings: list[dict] = []
    timings.append({"ayah": 0, "time": effective_start})

    if include_bsm:
        # ayah 1 starts after basmallah
        timings.append({"ayah": 1, "time": snapped_starts.get(1, effective_start)})
    else:
        timings.append({"ayah": 1, "time": effective_start})

    prev = timings[-1]["time"]
    for ayah in range(2, num_ayahs + 1):
        t = snapped_starts.get(ayah, prev + 100)
        t = max(t, prev + 100)
        timings.append({"ayah": ayah, "time": t})
        prev = t

    timings.append({"ayah": 999, "time": effective_end})
    _enforce_ordering(timings)

    basmallah_transcription = ""
    if include_bsm:
        basmallah_words = [
            h for h in hypothesis
            if h["end_ms"] <= snapped_starts.get(1, effective_end) + 100
        ]
        basmallah_transcription = " ".join(w["word"] for w in basmallah_words[:12])

    return {
        "surah": surah_number,
        "duration_ms": duration_ms,
        "silences": silences,
        "timings": timings,
        "num_ayahs": num_ayahs,
        "basmallah_detected": include_bsm if surah_number not in NO_BASMALLAH and surah_number != 1 else None,
        "basmallah_transcription": basmallah_transcription,
        "basmallah_method": "whisper-aligned",
        "basmallah_confidence": alignment_result["alignment_quality"],
        "debug": {
            "audio_dbfs": round(_safe_dbfs(audio), 2),
            "raw_silence_count": len(raw_silences),
            "merged_silence_count": len(silences),
            "weights": weights,
            "effective_start_ms": effective_start,
            "effective_end_ms": effective_end,
            "boundary_search_range_ms": snap_range,
            "model_name": MODEL_NAME,
            "whisper_words": hypothesis,
            "alignment_quality": alignment_result["alignment_quality"],
            "matched_ref": alignment_result["matched_ref"],
            "ref_size": alignment_result["ref_size"],
            "hyp_size": alignment_result["hyp_size"],
            "ayah_raw_starts": ayah_starts,
            "ayah_snapped_starts": snapped_starts,
            "snap_debug": snap_debug,
            "alignment_rows": alignment_result["alignment_debug"][:500],
        },
    }


def get_waveform_data(filepath: str, num_points: int = 2000) -> list[float]:
    audio = load_audio(filepath)
    samples = np.array(audio.get_array_of_samples(), dtype=np.float64)
    if audio.channels == 2:
        samples = samples[::2]
    chunk_size = max(1, len(samples) // num_points)
    amplitudes = []
    for i in range(0, len(samples), chunk_size):
        amplitudes.append(float(np.abs(samples[i:i + chunk_size]).mean()))
    max_amp = max(amplitudes) if amplitudes else 1.0
    if max_amp > 0:
        amplitudes = [a / max_amp for a in amplitudes]
    return amplitudes[:num_points]
