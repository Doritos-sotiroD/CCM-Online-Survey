# CCM-Online-Survey

Browser-based jsPsych experiment for evaluating emotions elicited by CCM.
Start with **[index.html](index.html)** for the website, configuration, and experiment timeline.

## File structure

```text
CCM-Online-Survey/
|-- index.html                         Main website and experiment logic
|-- README.md                          Repository overview and common commands
|-- AGENTS.md                          Repository engineering instructions
|-- .gitignore                         Excludes generated clips and Python caches
|-- emotion/
|   |-- guided-emotion.js              Emotion suggestions and vocabulary loading
|   |-- guided-emotion.css             Emotion-input styles
|   |-- english_emotion_list.txt       English vocabulary
|   `-- korean_emotion_list.txt        Korean vocabulary
|-- data/
|   `-- metadata.csv                   Runtime clip-to-work mapping
|-- docs/
|   |-- experiment.md                  Workflow, configuration, exports, and saving
|   |-- audio-clip-selector.md          Audio-preparation instructions
|   `-- reference/
|       |-- translation.txt            Dimensional-question translation reference
|       |-- integrated_korean_emotion_list.xlsx
|       `-- normalization_analysis.csv Audio normalization analysis reference
|-- tools/
|   `-- audio_clip_selector.py         Interactive, resumable MP3 clip selector
|-- audio/                             Existing numbered clips and setup audio
|-- audio_temp/                        Local generated clips/progress; ignored by Git
|-- exports/
|   |-- study.js                       Experiment and procedural CSV exports
|   `-- zip.js                         Results ZIP creation
|-- questionnaires/
|   |-- bigfive/
|   |   |-- questionnaire.js           Questionnaire loading and trial construction
|   |   |-- scoring.js                 Big Five scoring
|   |   |-- export.js                  Big Five CSV export
|   |   |-- data/                      en.json and ko.json questionnaire data
|   |   |-- SOURCE.md                  Source and coding documentation
|   |   `-- LICENSE
|   `-- gmsi/
|       |-- questionnaire.js           Gold-MSI loading and trial construction
|       |-- export.js                  Gold-MSI CSV export
|       |-- data/                      en.json and ko.json questionnaire data
|       `-- SOURCE.md                  Source and coding documentation
|-- tests/
|   |-- experiment.mjs                 Whole-experiment checks, including Big Five
|   |-- gmsi.mjs                       Gold-MSI checks
|   |-- guided-emotion.mjs             Vocabulary and emotion-input checks
|   |-- study-exports.mjs               Experiment/procedural export checks
|   |-- study-fixtures.mjs             Simulated experiment data
|   |-- emotion-dom.mjs                DOM support for response tests
|   `-- test_audio_clip_selector.py    Audio-tool tests using temporary fixtures
|-- img/                               Retained image assets
`-- jspsych/                           Retained library copies; not loaded by the site
```

The active website loads pinned jsPsych libraries from CDN URLs in `index.html`.
Keep the emotion module, stylesheet, and word lists together: the module locates
its supporting files relative to itself. `docs/reference/` contains supporting
study material; `data/metadata.csv` is the metadata file loaded by the experiment.

## Local preview

From the repository root, run:

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

Open <http://127.0.0.1:8765/>. Use HTTP/HTTPS; opening `index.html` directly as a
file prevents module and data loading. Data saving still uses the configured
DataPipe experiment; do not complete synthetic surveys against production storage.

## Verification

From the repository root with an existing Node.js 22.7+ installation:

```powershell
node --test tests/experiment.mjs tests/gmsi.mjs tests/guided-emotion.mjs tests/study-exports.mjs
```

These checks intercept network requests and use simulated responses. For the
Python audio-selector tests, using the existing Python and FFmpeg tools:

```powershell
python -m unittest discover -s tests -p "test_audio_clip_selector.py" -v
```

The audio-selector tests use temporary fixtures and do not modify the real
source recordings, kept clips, or progress. See the
[detailed verification notes](docs/experiment.md#local-verification).

## Audio preparation

```powershell
python .\tools\audio_clip_selector.py
```

The separate selector prepares 200 manually approved MP3 excerpts. Its default
source remains `..\05. Adjusted Audio`, and its output/progress remains in the
root `audio_temp/` folder. It does not change the experiment's audio pool or
configuration. See [audio clip selector instructions](docs/audio-clip-selector.md)
for playback controls, resuming, and explicit source/output paths.

## Detailed documentation

- [Experiment workflow and verification toggle](docs/experiment.md#workflow-and-verification-toggle)
- [Stimulus selection](docs/experiment.md#stimulus-selection)
- [Questionnaires](docs/experiment.md#questionnaires)
- [Data storage, CSV formats, confirmation, retries, and recovery](docs/experiment.md#data-storage)
- [Big Five source and coding](questionnaires/bigfive/SOURCE.md)
- [Gold-MSI source and coding](questionnaires/gmsi/SOURCE.md)
