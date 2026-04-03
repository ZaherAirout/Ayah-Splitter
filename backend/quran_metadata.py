"""Quran metadata: ayah counts per surah and surah names."""

# Number of ayahs in each surah (1-indexed: AYAH_COUNTS[1] = Al-Fatiha = 7 ayahs)
AYAH_COUNTS = {
    1: 7, 2: 286, 3: 200, 4: 176, 5: 120, 6: 165, 7: 206, 8: 75, 9: 129, 10: 109,
    11: 123, 12: 111, 13: 43, 14: 52, 15: 99, 16: 128, 17: 111, 18: 110, 19: 98, 20: 135,
    21: 112, 22: 78, 23: 118, 24: 64, 25: 77, 26: 227, 27: 93, 28: 88, 29: 69, 30: 60,
    31: 34, 32: 30, 33: 73, 34: 54, 35: 45, 36: 83, 37: 182, 38: 88, 39: 75, 40: 85,
    41: 54, 42: 53, 43: 89, 44: 59, 45: 37, 46: 35, 47: 38, 48: 29, 49: 18, 50: 45,
    51: 60, 52: 49, 53: 62, 54: 55, 55: 78, 56: 96, 57: 29, 58: 22, 59: 24, 60: 13,
    61: 14, 62: 11, 63: 11, 64: 18, 65: 12, 66: 12, 67: 30, 68: 52, 69: 52, 70: 44,
    71: 28, 72: 28, 73: 20, 74: 56, 75: 40, 76: 31, 77: 50, 78: 40, 79: 46, 80: 42,
    81: 29, 82: 19, 83: 36, 84: 25, 85: 22, 86: 17, 87: 19, 88: 26, 89: 30, 90: 20,
    91: 15, 92: 21, 93: 11, 94: 8, 95: 8, 96: 19, 97: 5, 98: 8, 99: 8, 100: 11,
    101: 11, 102: 8, 103: 3, 104: 9, 105: 5, 106: 4, 107: 7, 108: 3, 109: 6, 110: 3,
    111: 5, 112: 4, 113: 5, 114: 6,
}

SURAH_NAMES = {
    1: "Al-Fatiha", 2: "Al-Baqarah", 3: "Aal-E-Imran", 4: "An-Nisa", 5: "Al-Maeda",
    6: "Al-Anaam", 7: "Al-Araf", 8: "Al-Anfal", 9: "At-Tawba", 10: "Yunus",
    11: "Hud", 12: "Yusuf", 13: "Ar-Rad", 14: "Ibrahim", 15: "Al-Hijr",
    16: "An-Nahl", 17: "Al-Isra", 18: "Al-Kahf", 19: "Maryam", 20: "Taha",
    21: "Al-Anbiya", 22: "Al-Hajj", 23: "Al-Mumenoon", 24: "An-Noor", 25: "Al-Furqan",
    26: "Ash-Shuara", 27: "An-Naml", 28: "Al-Qasas", 29: "Al-Ankaboot", 30: "Ar-Room",
    31: "Luqman", 32: "As-Sajda", 33: "Al-Ahzab", 34: "Saba", 35: "Fatir",
    36: "Ya-Sin", 37: "As-Saaffat", 38: "Sad", 39: "Az-Zumar", 40: "Ghafir",
    41: "Fussilat", 42: "Ash-Shura", 43: "Az-Zukhruf", 44: "Ad-Dukhan", 45: "Al-Jathiya",
    46: "Al-Ahqaf", 47: "Muhammad", 48: "Al-Fath", 49: "Al-Hujraat", 50: "Qaf",
    51: "Adh-Dhariyat", 52: "At-Tur", 53: "An-Najm", 54: "Al-Qamar", 55: "Ar-Rahman",
    56: "Al-Waqia", 57: "Al-Hadid", 58: "Al-Mujadila", 59: "Al-Hashr", 60: "Al-Mumtahina",
    61: "As-Saff", 62: "Al-Jumua", 63: "Al-Munafiqoon", 64: "At-Taghabun", 65: "At-Talaq",
    66: "At-Tahrim", 67: "Al-Mulk", 68: "Al-Qalam", 69: "Al-Haaqqa", 70: "Al-Maarij",
    71: "Nooh", 72: "Al-Jinn", 73: "Al-Muzzammil", 74: "Al-Muddathir", 75: "Al-Qiyama",
    76: "Al-Insan", 77: "Al-Mursalat", 78: "An-Naba", 79: "An-Naziat", 80: "Abasa",
    81: "At-Takwir", 82: "Al-Infitar", 83: "Al-Mutaffifin", 84: "Al-Inshiqaq", 85: "Al-Burooj",
    86: "At-Tariq", 87: "Al-Ala", 88: "Al-Ghashiya", 89: "Al-Fajr", 90: "Al-Balad",
    91: "Ash-Shams", 92: "Al-Lail", 93: "Ad-Dhuha", 94: "Al-Inshirah", 95: "At-Tin",
    96: "Al-Alaq", 97: "Al-Qadr", 98: "Al-Bayyina", 99: "Az-Zalzala", 100: "Al-Adiyat",
    101: "Al-Qaria", 102: "At-Takathur", 103: "Al-Asr", 104: "Al-Humaza", 105: "Al-Fil",
    106: "Quraish", 107: "Al-Maun", 108: "Al-Kauther", 109: "Al-Kafiroon", 110: "An-Nasr",
    111: "Al-Masad", 112: "Al-Ikhlas", 113: "Al-Falaq", 114: "An-Nas",
}

# Surahs that do NOT start with Basmallah (only At-Tawba / surah 9)
NO_BASMALLAH = {9}

# Average relative word counts per ayah (approximate, for proportional splitting)
# These are average word counts used to estimate relative ayah lengths
SURAH_AVG_WORDS_PER_AYAH = {
    1: 5.0, 2: 18.5, 3: 16.8, 4: 20.2, 5: 19.6, 6: 16.2, 7: 14.8, 8: 16.0,
    9: 16.5, 10: 14.8, 11: 15.5, 12: 14.2, 13: 16.8, 14: 15.2, 15: 8.8,
    16: 16.5, 17: 14.8, 18: 15.2, 19: 11.8, 20: 9.2, 21: 13.5, 22: 16.8,
    23: 12.8, 24: 19.5, 25: 11.2, 26: 7.5, 27: 14.2, 28: 15.5, 29: 14.2,
    30: 13.5, 31: 15.8, 32: 13.2, 33: 18.8, 34: 15.2, 35: 16.2, 36: 10.2,
    37: 6.2, 38: 12.8, 39: 16.5, 40: 15.8, 41: 15.2, 42: 15.8, 43: 12.8,
    44: 9.5, 45: 15.2, 46: 16.2, 47: 15.8, 48: 19.2, 49: 18.5, 50: 9.2,
    51: 7.8, 52: 8.2, 53: 8.8, 54: 9.2, 55: 6.8, 56: 8.2, 57: 18.5,
    58: 22.5, 59: 18.2, 60: 22.8, 61: 16.2, 62: 16.2, 63: 16.2, 64: 16.8,
    65: 21.5, 66: 18.2, 67: 11.2, 68: 9.8, 69: 8.2, 70: 8.5, 71: 11.2,
    72: 12.5, 73: 12.8, 74: 7.5, 75: 7.2, 76: 11.8, 77: 6.8, 78: 7.8,
    79: 7.2, 80: 6.5, 81: 6.2, 82: 6.5, 83: 8.5, 84: 7.5, 85: 8.8,
    86: 6.2, 87: 6.5, 88: 7.2, 89: 7.8, 90: 6.5, 91: 6.2, 92: 6.2,
    93: 5.8, 94: 5.5, 95: 6.2, 96: 6.5, 97: 6.5, 98: 13.5, 99: 6.2,
    100: 5.5, 101: 5.8, 102: 5.2, 103: 5.8, 104: 6.2, 105: 5.5, 106: 5.2,
    107: 5.2, 108: 4.8, 109: 5.2, 110: 5.5, 111: 5.2, 112: 4.5, 113: 5.2,
    114: 5.5,
}
