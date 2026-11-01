# Fonts

These font files are packaged locally so the game UI does not depend on a third-party font request. Their copyright notices and the complete SIL Open Font License 1.1 text are distributed in `src/assets/THIRD_PARTY_NOTICES.txt` and linked from the running application. `@font-face` rules live in `src/styles/fonts.css`; font roles are tokens in `src/styles/tokens.css`.

| File | Source in google/fonts | Role | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| `BigShouldersDisplay-Variable.woff2` | `ofl/bigshouldersdisplay/BigShouldersDisplay[wght].ttf` | Large names and numbers | 47460 | `bd54ccb13e8f6ddb28c8882b84d0569807f001e8f8941e61800ae12394839d24` |
| `BigShouldersText-Variable.woff2` | `ofl/bigshoulderstext/BigShouldersText[wght].ttf` | Small names | 48616 | `e24e51b6314c0f57b8610adc9336b8f5c8e33fc5184df2d6beef6f127ae0f4bb` |
| `SofiaSans-Variable.woff2` | `ofl/sofiasans/SofiaSans[wght].ttf` | Body and tables | 52488 | `c56e169ff912b386a807835419432ee3a5cc1430ec5c3569eb15b627f9096660` |
| `Sancreek-Regular.woff2` | `ofl/sancreek/Sancreek-Regular.ttf` | Home and mode titles | 34412 | `25694753267f80ea84673a31801aad8c0e06e5647a6faed86df330880f53a0be` |
| `Cinzel-Variable.woff2` | `ofl/cinzel/Cinzel[wght].ttf` | Honours board title | 36640 | `391ea5c1f11b0f22c6d42b78dc42d7c985173d2107f23be42e730a87292f25a8` |

Downloaded from https://github.com/google/fonts at commit `6c1dbe27dcf7d817d4b62cec033ba77fa8e2a5ec` and converted with fontTools, keeping the weight axis and all layout features:

```sh
python3 -m fontTools.subset "<source>.ttf" --flavor=woff2 --layout-features='*' --output-file=<file>.woff2 \
  --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2197,U+2212,U+2215,U+2304,U+25B4,U+25B8,U+25BE,U+2713,U+FEFF,U+FFFD"
```

That range is the Google Fonts Latin subset plus the arrows and marks the UI uses. Glyphs a font does not contain (for example `▾` and `✓`) fall back to the system font.

google/fonts also ships a single `ofl/bigshoulders/BigShoulders[opsz,wght].ttf`. The separate Display and Text families are used because they match the design doc's font roles one to one.

Big Shoulders has no tabular figures. Sofia Sans does (`font-variant-numeric: tabular-nums`), so Sofia Sans Extra Condensed is not bundled.
