# Audio clip selector

From PowerShell in this repository, run:

```powershell
python .\tools\audio_clip_selector.py
```

Enter the clip length in seconds for a new run. The script uses the existing
Python installation and `ffmpeg`, `ffprobe`, and `ffplay` on PATH. No Python
packages are required or installed. It runs independently of the experiment.

The default source folder is `..\05. Adjusted Audio`; the default output is
`audio_temp` at the repository root. These defaults are anchored to the repository,
so moving the script into `tools/` does not change the source or saved progress.
Only MP3 files directly inside the source folder
are considered, sorted by case-insensitive filename (Unicode text order, then
the original filename to break ties). Sources 24, 48, ..., 4800 yield the 200
clips. There is no separate source-count check. Only the 200 selected sources
are probed to validate the requested duration before the first preview.

Each candidate is extracted and then played automatically. Press these keys
directly; **Enter is not required**, and the controls work during playback:

| Key | Action |
| --- | --- |
| **K** | Keep the entire candidate as `0001.mp3`, `0002.mp3`, ..., `0200.mp3`; advance to the next selected source. |
| **R** | Discard this candidate and choose another random point in the same source. |
| **P** | Replay the same candidate without changing its timepoint. |
| **Q** | Stop playback and exit, retaining progress and the current candidate. |

After playback ends, the same keys remain available. A new start is drawn
uniformly from zero through `(source duration - requested clip length)`.
If that range is zero, retry is unavailable because there is only one valid
start. Clips are saved by copying the original compressed MP3 audio; there is
no re-encoding, volume adjustment, normalization, fade, or effect. MP3 cut
boundaries and measured durations can differ slightly from the requested times.
Keep saves the exact candidate file that was previewed, even if playback was
stopped before its end.

Run the same command after quitting, closing the terminal, or interrupting
the script. It restores the duration, selected source list, accepted clips,
and current candidate/start point. `clip_selector_progress.json` records the
source-to-output mapping, requested start times, measured clip durations, and
file checksums. Do not edit or remove it during an unfinished run. A recorded
Keep interrupted during saving is completed on restart, without accepting a
second clip or advancing twice. Missing/changed source files, modified clips,
tool failures, and saving errors stop the program with an explicit error.

After all 200 clips are complete, **empty `audio_temp`, including the progress
record and helper files**, before launching again. The next run asks for a
new clip length. The script never clears the folder or overwrites kept clips.
Generated output and progress are excluded from Git.

For a different input/output folder, supply explicit paths:

```powershell
python .\tools\audio_clip_selector.py --source "C:\path\to\originals" --output "C:\path\to\clips"
```

Verification uses temporary fixtures, never the real output folder:

```powershell
python -m unittest discover -s tests -p "test_audio_clip_selector.py" -v
```
