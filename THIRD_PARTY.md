# Third-party pronunciation data

Lexora's offline pronunciation lookup embeds only the English US data from
`open-dict-data/ipa-dict`, fixed at commit
`972cd67dd5f96bc5660e28070cde26e3928abcd7` (MIT, copyright 2016 dohliam).
The data is based on `lingz/cmudict-ipa` (MIT, copyright 2016 Lingliang Zhang).
The original copyright and permission notices are preserved in:

- `src-tauri/src/engine/pronunciation-data/LICENSE-ipa-dict.txt`
- `src-tauri/src/engine/pronunciation-data/LICENSE-cmudict-ipa.txt`
- `src-tauri/src/engine/pronunciation-data/LICENSE-cmudict.txt` (original CMUdict
  redistribution notice, BSD-style)
- `src-tauri/src/engine/pronunciation-data/LICENSE-syllabify.txt` (MIT)

All these notices and the project license are embedded in the executable and
available through the stateless `pronunciation_licenses()` Tauri command,
including in portable single-executable releases.

Source URLs, checksums, compression details, attribution and the evaluation of
the unbundled `pinyin_pro` alternative are recorded in
`src-tauri/src/engine/pronunciation-data/README.md`.

The Chinese whole-word table contains 43 manually reviewed entries, including
银行 and 重庆. It is authored by Lexora contributors and covered by
the repository's MIT `LICENSE`. No third-party Chinese data is copied.

The service reuses the existing `serde` and `zip` dependencies; this change adds
no production Cargo dependency and does not require Cargo.lock regeneration.

## Command contract

`lookup_pronunciation({ text: string })` is a stateless Tauri command. It returns
`{ ok: true, result: PronunciationResult }` without calling an AI model.

`PronunciationResult` contains `status` (`Verified`, `Unknown`, `Ambiguous` or
`NotApplicable`), nullable `notation` (`ipa` or `pinyin`), `value`, `locale`,
`source`, and `dataVersion`. Ambiguous results additionally contain `candidates`
and always have `value: null`. Only `Verified` has a selected value; this means
an exact match in the pinned data, not an infallible linguistic judgment. Unknown
and inapplicable results have no pronunciation metadata.

The Rust API is `engine::pronunciation::lookup(&str) -> PronunciationResult`.
It is deterministic and independent of Tauri state. Consumers must render the
result separately from model output; this backend change does not modify the
model stream or Markdown body.


The picker displays only `Verified` readings separately from the model body.
Unknown, ambiguous, inapplicable and failed lookups are silently omitted. Copy
includes the separate reading; speech uses only the model body. Stale lookup
responses are discarded after a new request, hiding or closing the panel.
The default word lookup prompt prohibits model-generated IPA, pinyin and
pronunciation sections; generated text is never treated as verified data.
Unknown spellings such as `carzy` have no pronunciation value. The Chinese
table does not cover arbitrary Chinese, and unknown combinations are never
assembled from individual character readings. Tests establish implementation
behavior, not the quality of arbitrary model output.
