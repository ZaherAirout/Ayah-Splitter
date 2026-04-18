"""Align Whisper-transcribed words to canonical Quran text and derive ayah boundaries.

Pipeline:
  1. Build a flat reference word list: [(ayah_num, normalized_word), ...] covering
     the full surah (with basmallah as ayah 0 when applicable).
  2. Use difflib.SequenceMatcher on normalized token sequences to align the
     hypothesis (Whisper output) to the reference.
  3. For each ayah, pick the start time from the first aligned hypothesis word
     belonging to that ayah. Interpolate for unmatched ayahs.
  4. Optionally snap each boundary to the nearest silence midpoint (done in the
     audio_analyzer layer, not here).
"""

from __future__ import annotations

import logging
import re
from difflib import SequenceMatcher

from quran_metadata import AYAH_COUNTS, NO_BASMALLAH
from quran_text import get_surah_text

logger = logging.getLogger(__name__)

_DIACRITICS_RE = re.compile(r"[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]")
_ARABIC_WORD_CHARS = re.compile(r"[^\u0621-\u063a\u0641-\u064a]+")

BASMALLAH_TEXT = "بسم الله الرحمن الرحيم"


def normalize_word(word: str) -> str:
    if not word:
        return ""
    w = word.lower().replace("اللّه", "الله")
    w = _DIACRITICS_RE.sub("", w)
    w = (
        w.replace("أ", "ا")
        .replace("إ", "ا")
        .replace("آ", "ا")
        .replace("ٱ", "ا")
        .replace("ؤ", "و")
        .replace("ئ", "ي")
        .replace("ى", "ي")
        .replace("ة", "ه")
        .replace("ـ", "")
    )
    w = _ARABIC_WORD_CHARS.sub("", w)
    return w


def tokenize(text: str) -> list[str]:
    return [n for n in (normalize_word(w) for w in (text or "").split()) if n]


def build_reference(surah_number: int) -> list[tuple[int, str]]:
    """Return [(ayah_num, normalized_word)] covering the full surah.

    Basmallah words get ayah_num=0 for surahs that recite it separately
    (everything except surah 1 which includes it as ayah 1, and surah 9).
    """
    text = get_surah_text(surah_number) or {}
    num_ayahs = AYAH_COUNTS[surah_number]
    tokens: list[tuple[int, str]] = []

    if surah_number != 1 and surah_number not in NO_BASMALLAH:
        for w in tokenize(BASMALLAH_TEXT):
            tokens.append((0, w))

    for ayah in range(1, num_ayahs + 1):
        for w in tokenize(text.get(ayah, "")):
            tokens.append((ayah, w))

    return tokens


def align(
    reference: list[tuple[int, str]],
    hypothesis_words: list[str],
) -> list[int | None]:
    """Return a list `alignment` where alignment[i] is the hypothesis index
    matched to reference[i], or None if unmatched.
    """
    ref_words = [r[1] for r in reference]
    sm = SequenceMatcher(a=ref_words, b=hypothesis_words, autojunk=False)
    alignment: list[int | None] = [None] * len(reference)
    for m in sm.get_matching_blocks():
        for k in range(m.size):
            alignment[m.a + k] = m.b + k
    return alignment


def _interpolate_gaps(
    boundaries_ms: dict[int, int],
    num_ayahs: int,
    content_start_ms: int,
    content_end_ms: int,
    has_basmallah: bool,
    weights: list[float] | None = None,
) -> dict[int, int]:
    """Fill missing ayah start times via proportional interpolation."""
    result = dict(boundaries_ms)

    expected_ayahs = list(range(0 if has_basmallah else 1, num_ayahs + 1))

    # Anchor endpoints
    result.setdefault(expected_ayahs[0], content_start_ms)

    total_duration = max(1, content_end_ms - content_start_ms)

    # Build cumulative ref-word positions per ayah to proportion gaps
    # Fallback to equal spacing when weights aren't provided
    def proportional_cursor(ayah_list: list[int]) -> list[float]:
        if weights and len(weights) >= num_ayahs:
            # weights indexed by ayah - 1
            cursors = [0.0]
            cum = 0.0
            for a in ayah_list[:-1]:
                if a == 0:
                    cum += 0.05  # basmallah allotment relative to surah
                else:
                    cum += weights[a - 1]
                cursors.append(cum)
            total = cursors[-1] if cursors[-1] > 0 else 1.0
            return [c / total for c in cursors]
        n = max(1, len(ayah_list) - 1)
        return [i / n for i in range(len(ayah_list))]

    cursors = proportional_cursor(expected_ayahs)

    # Linear interpolation between known anchors
    known = [
        (i, result[a])
        for i, a in enumerate(expected_ayahs)
        if a in result
    ]
    if not known:
        return result
    if known[0][0] != 0:
        known.insert(0, (0, content_start_ms))
        result[expected_ayahs[0]] = content_start_ms
    if known[-1][0] != len(expected_ayahs) - 1:
        known.append((len(expected_ayahs) - 1, content_end_ms))

    for seg_start, seg_end in zip(known, known[1:]):
        (i0, t0), (i1, t1) = seg_start, seg_end
        if i1 - i0 <= 1:
            continue
        c0, c1 = cursors[i0], cursors[i1]
        cur_span = max(1e-9, c1 - c0)
        t_span = t1 - t0
        for k in range(i0 + 1, i1):
            frac = (cursors[k] - c0) / cur_span
            result[expected_ayahs[k]] = int(round(t0 + frac * t_span))

    return result


def compute_boundaries(
    surah_number: int,
    hypothesis: list[dict],
    content_start_ms: int,
    content_end_ms: int,
    weights: list[float] | None = None,
) -> dict:
    """Align whisper output against reference and compute per-ayah start times.

    Returns:
        {
          "ayah_starts": {ayah_num -> start_ms},
          "alignment_quality": float (0-1),
          "matched_ref": int,
          "ref_size": int,
          "hyp_size": int,
          "basmallah_detected": bool,
          "alignment_debug": list[{ref_ayah, ref_word, hyp_word, hyp_idx, start_ms, end_ms}],
        }
    """
    reference = build_reference(surah_number)
    hyp_normalized = [normalize_word(h["word"]) for h in hypothesis]
    alignment = align(reference, hyp_normalized)

    matched_ref = sum(1 for a in alignment if a is not None)
    quality = matched_ref / len(reference) if reference else 0.0

    # First aligned hypothesis word per ayah (= ayah start)
    ayah_first_hyp: dict[int, int] = {}
    for ref_idx, (ayah_num, _) in enumerate(reference):
        hyp_idx = alignment[ref_idx]
        if hyp_idx is None:
            continue
        if ayah_num not in ayah_first_hyp:
            ayah_first_hyp[ayah_num] = hyp_idx

    ayah_starts: dict[int, int] = {}
    for ayah, hyp_idx in ayah_first_hyp.items():
        ayah_starts[ayah] = hypothesis[hyp_idx]["start_ms"]

    # Basmallah present if any of its reference words matched
    has_basmallah_ref = any(a == 0 for a, _ in reference)
    basmallah_detected = has_basmallah_ref and 0 in ayah_starts

    # If basmallah wasn't recited but we expected it, drop ayah 0 and shift
    include_basmallah = basmallah_detected

    num_ayahs = AYAH_COUNTS[surah_number]
    if not include_basmallah and 0 in ayah_starts:
        ayah_starts.pop(0, None)

    ayah_starts = _interpolate_gaps(
        ayah_starts,
        num_ayahs=num_ayahs,
        content_start_ms=content_start_ms,
        content_end_ms=content_end_ms,
        has_basmallah=include_basmallah,
        weights=weights,
    )

    alignment_debug = []
    for ref_idx, (ayah_num, ref_word) in enumerate(reference):
        hyp_idx = alignment[ref_idx]
        if hyp_idx is not None:
            h = hypothesis[hyp_idx]
            alignment_debug.append({
                "ref_ayah": ayah_num,
                "ref_word": ref_word,
                "hyp_idx": hyp_idx,
                "hyp_word": h["word"],
                "start_ms": h["start_ms"],
                "end_ms": h["end_ms"],
            })

    return {
        "ayah_starts": ayah_starts,
        "alignment_quality": round(quality, 4),
        "matched_ref": matched_ref,
        "ref_size": len(reference),
        "hyp_size": len(hypothesis),
        "basmallah_detected": basmallah_detected,
        "alignment_debug": alignment_debug,
        "include_basmallah": include_basmallah,
    }
