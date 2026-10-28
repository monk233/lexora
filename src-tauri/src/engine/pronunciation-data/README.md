# Offline pronunciation data

No runtime network request or model-generated pronunciation is used. Data is
loaded once on first access. `Verified` means an exact entry in the pinned data,
not that the dictionary is infallible. Distinct readings produce `Ambiguous`
with candidates and no selected value.

## English (US)

- Source: https://github.com/open-dict-data/ipa-dict
- Fixed commit: `972cd67dd5f96bc5660e28070cde26e3928abcd7`
- Original file: `data/en_US.txt` (UTF-8, tab separated)
- Original URL: https://raw.githubusercontent.com/open-dict-data/ipa-dict/972cd67dd5f96bc5660e28070cde26e3928abcd7/data/en_US.txt
- Original size: 3,180,267 bytes.
- Original SHA-256: `2af6f154a5c363275f052d1f85acedef38ed185ca9745aa4314be77f6b70de67`
- Embedded archive: `en_US.tsv.zip`, 919,198 bytes. Its single entry is
  `en_US.tsv`; the bytes of the original file are unchanged.
- Archive SHA-256: `27ac693e28f188db3341625c276725bdaa35438a53dbd89609da4499cd71b840`
- ZIP entry timestamp: `1980-01-01T00:00:00Z`; DEFLATE compression.
- License: MIT, copyright 2016 dohliam (`LICENSE-ipa-dict.txt`).
- Upstream credits: the English US data derives from Lingliang Zhang's
  `cmudict-ipa`, also MIT (`LICENSE-cmudict-ipa.txt`), and stress annotation
  using `syllabify`. The bundled cmudict-ipa license was retrieved at commit
  `629483e9a7fa5b9ff11bb83e3fda6dcc25c5c511`.
- Original CMUdict redistribution notice is retained in `LICENSE-cmudict.txt`,
  retrieved at `cmusphinx/cmudict` commit
  `74790861f652b15e4ac49015a90074ad62a27690` (BSD-style).
- Syllabify's MIT notice is retained in `LICENSE-syllabify.txt`, extracted from
  the header of `syllabify.py` at `kylebgorman/syllabify` commit
  `d816db784436e9de87ec1ef9bd11b8e229853710`.
- This bundles only the English US dataset. Other ipa-dict languages have
  different licenses and are not included.

Lookup folds ASCII case only. Spelling corrections and phonetic synthesis are
not performed. Comma-separated distinct dictionary readings remain ambiguous.
Unknown spellings such as `carzy` have no pronunciation value.

## Chinese

`zh_verified.tsv` is a small, project-authored, manually reviewed list of
whole-word Mandarin readings, version `lexora-zh-2026-10-28.1`. It is distributed
under the project's MIT license, copyright 2026 Lexora contributors.
Syllables are separated with spaces and retain lexical tones; this is not a
speech sandhi transcriber. `|` separates alternative readings of ambiguous
entries. Simplified and traditional spellings are separate exact entries.

This deliberately limited list covers 银行/銀行, 重庆/重慶, 长大/長大 and
长短/長短, together with a few other common words. Unknown combinations return
`Unknown`, even if every individual character has a known reading. An unknown
word is never assembled from character-level pinyin. This prevents false
verification of arbitrary short sentences, names and polyphonic combinations.

`pinyin_pro` 3.29.4 was evaluated: it is a pure-Rust MIT port with embedded
character/word data and segmentation. Its general conversion API chooses
readings for arbitrary combinations, and does not establish that the complete
input is a verified dictionary entry. It also exposes process-global mutable
dictionaries. For this conservative first release we use the smaller reviewed
table rather than treating heuristic conversion as verification. Expanding
coverage requires adding and reviewing complete entries, or adopting a
licensed dictionary with a strict exact-entry API and explicit ambiguity.

## Limits and failure handling

Only 1–12 Han characters or English word candidates of at most 40 ASCII
characters qualify. Identifiers, camelCase, URLs, mixed scripts, punctuation,
and sentences return `NotApplicable`. Plain lowercase identifiers that are also
real words cannot be distinguished without caller context.

Malformed, duplicate or corrupt embedded data fails closed to `Unknown`.
Archive expansion is bounded to 4 MiB. Loading uses `OnceLock`; no writable
cache, external executable, Python, Node or platform API is required.

Reproduction: download the fixed original URL, verify its SHA-256, then create
a ZIP with a single `en_US.tsv` entry using DEFLATE and the timestamp above.
Compression implementations can produce different archive bytes; the expanded
file hash is the canonical source-integrity check.
