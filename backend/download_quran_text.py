#!/usr/bin/env python3
"""Download full Quran Arabic text and save as quran_text.json.

Uses the Alquran.cloud API (free, no auth required).
Run this once to populate the text for all 114 surahs.

Usage:
    python download_quran_text.py
"""

import json
import os
import sys
import urllib.request
import urllib.error

API_BASE = "https://api.alquran.cloud/v1"
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "quran_text.json")


def download_quran():
    """Download complete Quran text from Alquran.cloud API."""
    print("Downloading complete Quran text (quran-uthmani edition)...")

    url = f"{API_BASE}/quran/quran-uthmani"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "AyahSplitter/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        print(f"Error downloading: {e}")
        sys.exit(1)

    if data.get("code") != 200:
        print(f"API error: {data}")
        sys.exit(1)

    # Parse into {surah_num: {ayah_num: text}} format
    result = {}
    for surah_data in data["data"]["surahs"]:
        surah_num = surah_data["number"]
        result[str(surah_num)] = {}
        for ayah_data in surah_data["ayahs"]:
            ayah_num = ayah_data["numberInSurah"]
            result[str(surah_num)][str(ayah_num)] = ayah_data["text"]

    # Save to JSON
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=None)

    total_ayahs = sum(len(v) for v in result.values())
    size_kb = os.path.getsize(OUTPUT_FILE) / 1024
    print(f"Saved {len(result)} surahs, {total_ayahs} ayahs to {OUTPUT_FILE} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    download_quran()
