"""Static metadata for all 114 suras of the Quran.

Each sura entry contains its number (1-based), Arabic name,
transliterated name, and total aya count.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Sura:
    number: int
    name: str
    transliteration: str
    aya_count: int


SURAS: list[Sura] = [
    Sura(number=1, name="الفاتحة", transliteration="Al-Fatiha", aya_count=7),
    Sura(number=2, name="البقرة", transliteration="Al-Baqarah", aya_count=286),
    Sura(number=3, name="آل عمران", transliteration="Aal-E-Imran", aya_count=200),
    Sura(number=4, name="النساء", transliteration="An-Nisa", aya_count=176),
    Sura(number=5, name="المائدة", transliteration="Al-Ma'idah", aya_count=120),
    Sura(number=6, name="الأنعام", transliteration="Al-An'am", aya_count=165),
    Sura(number=7, name="الأعراف", transliteration="Al-A'raf", aya_count=206),
    Sura(number=8, name="الأنفال", transliteration="Al-Anfal", aya_count=75),
    Sura(number=9, name="التوبة", transliteration="At-Tawbah", aya_count=129),
    Sura(number=10, name="يونس", transliteration="Yunus", aya_count=109),
    Sura(number=11, name="هود", transliteration="Hud", aya_count=123),
    Sura(number=12, name="يوسف", transliteration="Yusuf", aya_count=111),
    Sura(number=13, name="الرعد", transliteration="Ar-Ra'd", aya_count=43),
    Sura(number=14, name="إبراهيم", transliteration="Ibrahim", aya_count=52),
    Sura(number=15, name="الحجر", transliteration="Al-Hijr", aya_count=99),
    Sura(number=16, name="النحل", transliteration="An-Nahl", aya_count=128),
    Sura(number=17, name="الإسراء", transliteration="Al-Isra", aya_count=111),
    Sura(number=18, name="الكهف", transliteration="Al-Kahf", aya_count=110),
    Sura(number=19, name="مريم", transliteration="Maryam", aya_count=98),
    Sura(number=20, name="طه", transliteration="Taha", aya_count=135),
    Sura(number=21, name="الأنبياء", transliteration="Al-Anbiya", aya_count=112),
    Sura(number=22, name="الحج", transliteration="Al-Hajj", aya_count=78),
    Sura(number=23, name="المؤمنون", transliteration="Al-Mu'minun", aya_count=118),
    Sura(number=24, name="النور", transliteration="An-Nur", aya_count=64),
    Sura(number=25, name="الفرقان", transliteration="Al-Furqan", aya_count=77),
    Sura(number=26, name="الشعراء", transliteration="Ash-Shu'ara", aya_count=227),
    Sura(number=27, name="النمل", transliteration="An-Naml", aya_count=93),
    Sura(number=28, name="القصص", transliteration="Al-Qasas", aya_count=88),
    Sura(number=29, name="العنكبوت", transliteration="Al-Ankabut", aya_count=69),
    Sura(number=30, name="الروم", transliteration="Ar-Rum", aya_count=60),
    Sura(number=31, name="لقمان", transliteration="Luqman", aya_count=34),
    Sura(number=32, name="السجدة", transliteration="As-Sajdah", aya_count=30),
    Sura(number=33, name="الأحزاب", transliteration="Al-Ahzab", aya_count=73),
    Sura(number=34, name="سبأ", transliteration="Saba", aya_count=54),
    Sura(number=35, name="فاطر", transliteration="Fatir", aya_count=45),
    Sura(number=36, name="يس", transliteration="Ya-Sin", aya_count=83),
    Sura(number=37, name="الصافات", transliteration="As-Saffat", aya_count=182),
    Sura(number=38, name="ص", transliteration="Sad", aya_count=88),
    Sura(number=39, name="الزمر", transliteration="Az-Zumar", aya_count=75),
    Sura(number=40, name="غافر", transliteration="Ghafir", aya_count=85),
    Sura(number=41, name="فصلت", transliteration="Fussilat", aya_count=54),
    Sura(number=42, name="الشورى", transliteration="Ash-Shura", aya_count=53),
    Sura(number=43, name="الزخرف", transliteration="Az-Zukhruf", aya_count=89),
    Sura(number=44, name="الدخان", transliteration="Ad-Dukhan", aya_count=59),
    Sura(number=45, name="الجاثية", transliteration="Al-Jathiyah", aya_count=37),
    Sura(number=46, name="الأحقاف", transliteration="Al-Ahqaf", aya_count=35),
    Sura(number=47, name="محمد", transliteration="Muhammad", aya_count=38),
    Sura(number=48, name="الفتح", transliteration="Al-Fath", aya_count=29),
    Sura(number=49, name="الحجرات", transliteration="Al-Hujurat", aya_count=18),
    Sura(number=50, name="ق", transliteration="Qaf", aya_count=45),
    Sura(number=51, name="الذاريات", transliteration="Adh-Dhariyat", aya_count=60),
    Sura(number=52, name="الطور", transliteration="At-Tur", aya_count=49),
    Sura(number=53, name="النجم", transliteration="An-Najm", aya_count=62),
    Sura(number=54, name="القمر", transliteration="Al-Qamar", aya_count=55),
    Sura(number=55, name="الرحمن", transliteration="Ar-Rahman", aya_count=78),
    Sura(number=56, name="الواقعة", transliteration="Al-Waqi'ah", aya_count=96),
    Sura(number=57, name="الحديد", transliteration="Al-Hadid", aya_count=29),
    Sura(number=58, name="المجادلة", transliteration="Al-Mujadila", aya_count=22),
    Sura(number=59, name="الحشر", transliteration="Al-Hashr", aya_count=24),
    Sura(number=60, name="الممتحنة", transliteration="Al-Mumtahanah", aya_count=13),
    Sura(number=61, name="الصف", transliteration="As-Saf", aya_count=14),
    Sura(number=62, name="الجمعة", transliteration="Al-Jumu'ah", aya_count=11),
    Sura(number=63, name="المنافقون", transliteration="Al-Munafiqun", aya_count=11),
    Sura(number=64, name="التغابن", transliteration="At-Taghabun", aya_count=18),
    Sura(number=65, name="الطلاق", transliteration="At-Talaq", aya_count=12),
    Sura(number=66, name="التحريم", transliteration="At-Tahrim", aya_count=12),
    Sura(number=67, name="الملك", transliteration="Al-Mulk", aya_count=30),
    Sura(number=68, name="القلم", transliteration="Al-Qalam", aya_count=52),
    Sura(number=69, name="الحاقة", transliteration="Al-Haqqah", aya_count=52),
    Sura(number=70, name="المعارج", transliteration="Al-Ma'arij", aya_count=44),
    Sura(number=71, name="نوح", transliteration="Nuh", aya_count=28),
    Sura(number=72, name="الجن", transliteration="Al-Jinn", aya_count=28),
    Sura(number=73, name="المزمل", transliteration="Al-Muzzammil", aya_count=20),
    Sura(number=74, name="المدثر", transliteration="Al-Muddathir", aya_count=56),
    Sura(number=75, name="القيامة", transliteration="Al-Qiyamah", aya_count=40),
    Sura(number=76, name="الإنسان", transliteration="Al-Insan", aya_count=31),
    Sura(number=77, name="المرسلات", transliteration="Al-Mursalat", aya_count=50),
    Sura(number=78, name="النبأ", transliteration="An-Naba", aya_count=40),
    Sura(number=79, name="النازعات", transliteration="An-Nazi'at", aya_count=46),
    Sura(number=80, name="عبس", transliteration="Abasa", aya_count=42),
    Sura(number=81, name="التكوير", transliteration="At-Takwir", aya_count=29),
    Sura(number=82, name="الانفطار", transliteration="Al-Infitar", aya_count=19),
    Sura(number=83, name="المطففين", transliteration="Al-Mutaffifin", aya_count=36),
    Sura(number=84, name="الانشقاق", transliteration="Al-Inshiqaq", aya_count=25),
    Sura(number=85, name="البروج", transliteration="Al-Buruj", aya_count=22),
    Sura(number=86, name="الطارق", transliteration="At-Tariq", aya_count=17),
    Sura(number=87, name="الأعلى", transliteration="Al-A'la", aya_count=19),
    Sura(number=88, name="الغاشية", transliteration="Al-Ghashiyah", aya_count=26),
    Sura(number=89, name="الفجر", transliteration="Al-Fajr", aya_count=30),
    Sura(number=90, name="البلد", transliteration="Al-Balad", aya_count=20),
    Sura(number=91, name="الشمس", transliteration="Ash-Shams", aya_count=15),
    Sura(number=92, name="الليل", transliteration="Al-Layl", aya_count=21),
    Sura(number=93, name="الضحى", transliteration="Ad-Dhuha", aya_count=11),
    Sura(number=94, name="الشرح", transliteration="Ash-Sharh", aya_count=8),
    Sura(number=95, name="التين", transliteration="At-Tin", aya_count=8),
    Sura(number=96, name="العلق", transliteration="Al-Alaq", aya_count=19),
    Sura(number=97, name="القدر", transliteration="Al-Qadr", aya_count=5),
    Sura(number=98, name="البينة", transliteration="Al-Bayyinah", aya_count=8),
    Sura(number=99, name="الزلزلة", transliteration="Az-Zalzalah", aya_count=8),
    Sura(number=100, name="العاديات", transliteration="Al-Adiyat", aya_count=11),
    Sura(number=101, name="القارعة", transliteration="Al-Qari'ah", aya_count=11),
    Sura(number=102, name="التكاثر", transliteration="At-Takathur", aya_count=8),
    Sura(number=103, name="العصر", transliteration="Al-Asr", aya_count=3),
    Sura(number=104, name="الهمزة", transliteration="Al-Humazah", aya_count=9),
    Sura(number=105, name="الفيل", transliteration="Al-Fil", aya_count=5),
    Sura(number=106, name="قريش", transliteration="Quraysh", aya_count=4),
    Sura(number=107, name="الماعون", transliteration="Al-Ma'un", aya_count=7),
    Sura(number=108, name="الكوثر", transliteration="Al-Kawthar", aya_count=3),
    Sura(number=109, name="الكافرون", transliteration="Al-Kafirun", aya_count=6),
    Sura(number=110, name="النصر", transliteration="An-Nasr", aya_count=3),
    Sura(number=111, name="المسد", transliteration="Al-Masad", aya_count=5),
    Sura(number=112, name="الإخلاص", transliteration="Al-Ikhlas", aya_count=4),
    Sura(number=113, name="الفلق", transliteration="Al-Falaq", aya_count=5),
    Sura(number=114, name="الناس", transliteration="An-Nas", aya_count=6),
]

# Build lookup dict for O(1) access by sura number.
_SURA_BY_NUMBER: dict[int, Sura] = {s.number: s for s in SURAS}


def get_sura(number: int) -> Sura:
    """Return sura metadata by number (1-114). Raises KeyError if invalid."""
    try:
        return _SURA_BY_NUMBER[number]
    except KeyError:
        raise KeyError(f"Invalid sura number: {number}. Must be 1-114.") from None


def get_sura_name(number: int) -> str:
    """Return the Arabic name of the sura."""
    return get_sura(number).name


def get_aya_count(number: int) -> int:
    """Return total number of ayas in the sura."""
    return get_sura(number).aya_count


def get_total_ayas() -> int:
    """Return total number of ayas in the entire Quran (6236)."""
    return sum(s.aya_count for s in SURAS)
