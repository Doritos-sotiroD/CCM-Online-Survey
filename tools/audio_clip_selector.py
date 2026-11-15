r"""Interactive, resumable MP3 excerpt selection from a Windows terminal.

Run from the repository root: python .\tools\audio_clip_selector.py
Uses the installed ffmpeg/ffprobe/ffplay executables; no Python packages needed.
"""

import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import msvcrt
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import time


# Keep source, output and resumable progress anchored to the repository root.
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT.parent / "05. Adjusted Audio"
DEFAULT_OUTPUT = ROOT / "audio_temp"
CLIP_COUNT = 200
FILE_STEP = 24
PROGRESS_FILE = "clip_selector_progress.json"
CANDIDATE_FILE = "clip_selector_candidate.mp3"
PART_FILE = "clip_selector_candidate.part.mp3"
LOCK_FILE = "clip_selector.lock"


class SelectorError(RuntimeError):
    pass


def find_tools():
    tools = {}
    for name in ("ffmpeg", "ffprobe", "ffplay"):
        path = shutil.which(name)
        if path is None:
            raise SelectorError(f"Required tool '{name}' was not found on PATH.")
        tools[name] = path
    return tools


def checked_command(command):
    result = subprocess.run(
        command, stdin=subprocess.DEVNULL, capture_output=True,
        encoding="utf-8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if result.returncode != 0 or result.stderr.strip():
        raise SelectorError(
            f"{Path(command[0]).stem} failed (exit {result.returncode}):\n"
            f"{result.stderr.strip()}"
        )
    return result.stdout


def probe_duration(path, tools):
    info = json.loads(checked_command([
        tools["ffprobe"], "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name:format=duration", "-of", "json", str(path),
    ]))
    streams = info.get("streams", [])
    if not streams or streams[0].get("codec_name") != "mp3":
        raise SelectorError(f"The file does not contain MP3 audio: {path}")
    try:
        seconds = float(info["format"]["duration"])
    except (KeyError, TypeError, ValueError) as exc:
        raise SelectorError(f"Cannot determine the audio duration: {path}") from exc
    if not math.isfinite(seconds) or seconds <= 0:
        raise SelectorError(f"Invalid audio duration: {path}")
    return seconds


def select_sources(directory):
    # Fixed, case-insensitive filename order; inspect only files in this folder.
    ordered = sorted(
        (p for p in directory.iterdir() if p.is_file() and p.suffix.lower() == ".mp3"),
        key=lambda p: (p.name.casefold(), p.name),
    )
    # No source-count precheck: the input is guaranteed to contain enough files.
    return [ordered[i] for i in range(FILE_STEP - 1, CLIP_COUNT * FILE_STEP, FILE_STEP)]


def prompt_duration():
    while True:
        text = input("Clip length in seconds: ").strip()
        try:
            seconds = float(text)
        except ValueError:
            print("Enter a positive number of seconds.")
            continue
        if math.isfinite(seconds) and seconds > 0:
            return seconds
        print("Enter a positive, finite number of seconds.")


def save_progress(output, state):
    # Same-directory replacement leaves either the previous or the new JSON intact.
    temporary = output / (PROGRESS_FILE + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, output / PROGRESS_FILE)


@contextmanager
def output_lock(output):
    # Windows releases this lock even if the process/terminal is forcibly closed.
    with (output / LOCK_FILE).open("a+b") as handle:
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise SelectorError("Another selector is already using this output folder.") from exc
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def check_source(directory, source):
    path = directory / source["filename"]
    stat = path.stat()
    if stat.st_size != source["size"] or stat.st_mtime_ns != source["mtime_ns"]:
        raise SelectorError(f"Source file changed since this run began: {path}")
    return path


def create_state(source_directory, seconds, tools):
    sources = []
    print("Checking durations of the 200 selected sources...", flush=True)
    for number, path in enumerate(select_sources(source_directory), 1):
        stat = path.stat()
        duration = probe_duration(path, tools)
        if duration < seconds:
            raise SelectorError(
                f"Requested {seconds:g}s, but '{path.name}' is only {duration:g}s.\n"
                "Restart and choose a shorter clip length. No sources were skipped."
            )
        sources.append({
            "filename": path.name, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
            "duration_seconds": duration,
        })
        if number % 20 == 0:
            print(f"  {number}/200 checked", flush=True)
    return {
        "version": 1, "source_directory": str(source_directory),
        "clip_seconds": seconds, "sources": sources, "accepted": [],
        "candidate": None, "keep_pending": False,
    }


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_state(state, source_directory):
    """Reject broken progress before using its paths or modifying any clip."""
    def require(condition):
        if not condition:
            raise SelectorError("Invalid selector progress record; no clips were changed.")

    require(isinstance(state, dict) and state.get("version") == 1)
    require(state.get("source_directory") == str(source_directory))
    seconds = state.get("clip_seconds")
    require(finite_number(seconds) and seconds > 0)
    sources = state.get("sources")
    require(isinstance(sources, list) and len(sources) == CLIP_COUNT)
    names = []
    for source in sources:
        require(isinstance(source, dict))
        name = source.get("filename")
        require(isinstance(name, str) and Path(name).name == name and name.lower().endswith(".mp3"))
        require(type(source.get("size")) is int and source["size"] > 0)
        require(type(source.get("mtime_ns")) is int)
        require(finite_number(source.get("duration_seconds")) and source["duration_seconds"] >= seconds)
        names.append(name.casefold())
    require(len(set(names)) == CLIP_COUNT)
    accepted = state.get("accepted")
    require(isinstance(accepted, list) and len(accepted) <= CLIP_COUNT)
    require(type(state.get("keep_pending")) is bool)

    def check_candidate(candidate, index, ready):
        require(isinstance(candidate, dict))
        start = candidate.get("start_seconds")
        require(finite_number(start) and 0 <= start <= sources[index]["duration_seconds"] - seconds)
        digest = candidate.get("sha256")
        if digest is None and not ready:
            require(candidate.get("actual_seconds") is None and candidate.get("byte_size") is None)
        else:
            require(isinstance(digest, str) and len(digest) == 64 and all(c in "0123456789abcdef" for c in digest))
            require(finite_number(candidate.get("actual_seconds")) and candidate["actual_seconds"] > 0)
            require(type(candidate.get("byte_size")) is int and candidate["byte_size"] > 0)

    for index, clip in enumerate(accepted):
        check_candidate(clip, index, ready=True)
        require(clip.get("output_filename") == f"{index + 1:04d}.mp3")
        require(clip.get("source_filename") == sources[index]["filename"])
    candidate = state.get("candidate")
    if candidate is not None:
        require(len(accepted) < CLIP_COUNT)
        check_candidate(candidate, len(accepted), ready=state["keep_pending"])
    require(not state["keep_pending"] or candidate is not None)


def verify_clip(path, record):
    if not path.is_file() or path.stat().st_size != record["byte_size"]:
        raise SelectorError(f"Recorded clip is missing or incomplete: {path}")
    if hashlib.sha256(path.read_bytes()).hexdigest() != record["sha256"]:
        raise SelectorError(f"Recorded clip has changed: {path}")


class Session:
    def __init__(self, output, state, tools):
        self.output = output
        self.state = state
        self.tools = tools
        self.source_directory = Path(state["source_directory"])
        self.candidate_path = output / CANDIDATE_FILE

    @property
    def index(self):
        return len(self.state["accepted"])

    @property
    def max_start(self):
        return self.state["sources"][self.index]["duration_seconds"] - self.state["clip_seconds"]

    def save(self):
        save_progress(self.output, self.state)

    def validate_files(self):
        for source in self.state["sources"]:
            check_source(self.source_directory, source)
        for clip in self.state["accepted"]:
            verify_clip(self.output / clip["output_filename"], clip)
        expected = {clip["output_filename"] for clip in self.state["accepted"]}
        expected.update((CANDIDATE_FILE, PART_FILE))
        if self.state["keep_pending"]:
            expected.add(f"{self.index + 1:04d}.mp3")
        unexpected = [p.name for p in self.output.iterdir() if p.suffix.lower() == ".mp3" and p.name not in expected]
        if unexpected:
            raise SelectorError(f"Unrecorded MP3 file(s) in the output folder: {', '.join(unexpected)}")

    def choose_candidate(self):
        # Persist the random point before extraction so an abort retains it.
        start = random.SystemRandom().uniform(0, self.max_start)
        self.state["candidate"] = {
            "start_seconds": start, "actual_seconds": None,
            "sha256": None, "byte_size": None,
        }
        self.save()

    def ensure_candidate(self):
        if self.state["candidate"] is None:
            self.choose_candidate()
        candidate = self.state["candidate"]
        if candidate["sha256"] is not None:
            verify_clip(self.candidate_path, candidate)
            return
        source = check_source(self.source_directory, self.state["sources"][self.index])
        partial = self.output / PART_FILE
        # Only this tool's unfinished extraction is replaced; kept clips are untouched.
        partial.unlink(missing_ok=True)
        checked_command([
            self.tools["ffmpeg"], "-hide_banner", "-loglevel", "error", "-xerror", "-nostdin",
            "-ss", f"{candidate['start_seconds']:.9f}", "-i", str(source),
            "-t", f"{self.state['clip_seconds']:.9f}", "-map", "0:a:0",
            "-c:a", "copy", "-vn", "-sn", "-dn", "-f", "mp3", "-n", str(partial),
        ])
        actual_seconds = probe_duration(partial, self.tools)
        with partial.open("r+b") as handle:
            os.fsync(handle.fileno())
            digest = hashlib.sha256(handle.read()).hexdigest()
        byte_size = partial.stat().st_size
        os.replace(partial, self.candidate_path)
        candidate.update(actual_seconds=actual_seconds, sha256=digest, byte_size=byte_size)
        self.save()

    def finish_keep(self):
        """Complete the recorded Keep, including after a crash at either side of rename."""
        candidate = self.state["candidate"]
        destination = self.output / f"{self.index + 1:04d}.mp3"
        if self.candidate_path.exists() and not destination.exists():
            verify_clip(self.candidate_path, candidate)
            # On Windows rename fails if the destination exists; never overwrite a clip.
            self.candidate_path.rename(destination)
        elif destination.exists() and not self.candidate_path.exists():
            verify_clip(destination, candidate)
        else:
            raise SelectorError("Cannot complete the pending Keep: ambiguous or missing clip files.")
        record = dict(candidate)
        record.update(
            output_filename=destination.name,
            source_filename=self.state["sources"][self.index]["filename"],
        )
        self.state["accepted"].append(record)
        self.state["candidate"] = None
        self.state["keep_pending"] = False
        self.save()
        return destination.name

    def keep(self):
        verify_clip(self.candidate_path, self.state["candidate"])
        self.state["keep_pending"] = True
        self.save()
        return self.finish_keep()


class Player:
    def __init__(self, output, executable):
        self.log_path = output / "clip_selector_playback.log"
        self.executable = executable
        self.process = None
        self.log = None

    def start(self, path):
        self.log = self.log_path.open("wb")
        self.process = subprocess.Popen(
            [self.executable, "-hide_banner", "-loglevel", "error", "-nostats", "-nodisp", "-autoexit", "-i", str(path)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=self.log,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

    def check(self):
        code = self.process.poll()
        error = self.log_path.read_text(encoding="utf-8", errors="replace").strip()
        if error or (code is not None and code != 0):
            raise SelectorError(f"Audio playback failed (exit {code}):\n{error}")

    def stop(self):
        try:
            if self.process is not None and self.process.poll() is None:
                self.process.terminate()
                self.process.wait(timeout=5)
        finally:
            if self.log is not None:
                self.log.close()
            self.process = None
            self.log = None


def review(session):
    player = Player(session.output, session.tools["ffplay"])
    try:
        while session.index < CLIP_COUNT:
            session.ensure_candidate()
            candidate = session.state["candidate"]
            print(f"\nClip {session.index + 1:04d} / 0200 | source #{(session.index + 1) * FILE_STEP}")
            print(session.state["sources"][session.index]["filename"])
            print(
                f"Start: {candidate['start_seconds']:.3f}s | requested: {session.state['clip_seconds']:g}s"
                f" | MP3 duration: {candidate['actual_seconds']:.3f}s"
            )
            print("K = keep   R = another random point   P = replay   Q = quit/resume later", flush=True)
            # Discard stale keystrokes from the previous clip/extraction.
            while msvcrt.kbhit():
                msvcrt.getwch()
            player.start(session.candidate_path)
            while True:
                player.check()
                if not msvcrt.kbhit():
                    time.sleep(0.05)
                    continue
                key = msvcrt.getwch().lower()
                if key == "k":
                    player.stop()
                    filename = session.keep()
                    print(f"Saved {filename} ({session.index}/200).", flush=True)
                    break
                if key == "r":
                    if session.max_start == 0:
                        print("This source matches the clip length; its only valid start is 0s.", flush=True)
                        continue
                    player.stop()
                    session.choose_candidate()
                    break
                if key == "p":
                    player.stop()
                    player.start(session.candidate_path)
                if key == "q":
                    print("Paused. Run the same command to resume this candidate.", flush=True)
                    return
        print("\nComplete: all 200 clips have been saved.")
        print("For a new run, empty audio_temp (including the progress record) and run again.")
    finally:
        player.stop()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Folder containing the original MP3 files")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Clip and progress folder (default: audio_temp)")
    args = parser.parse_args(argv)
    try:
        if not sys.stdin.isatty():
            raise SelectorError("Run directly in an interactive PowerShell terminal, without piping input.")
        tools = find_tools()
        source_directory = args.source.resolve(strict=True)
        if not source_directory.is_dir():
            raise SelectorError(f"Source is not a directory: {source_directory}")
        output = args.output.resolve()
        if output == source_directory:
            raise SelectorError("Source and output folders must be different.")
        output.mkdir(parents=True, exist_ok=True)
        with output_lock(output):
            progress = output / PROGRESS_FILE
            if progress.exists():
                state = json.loads(progress.read_text(encoding="utf-8"))
                validate_state(state, source_directory)
                print(f"Resuming: {len(state['accepted'])}/200 kept; clip length {state['clip_seconds']:g}s.")
            else:
                if any(p.name != LOCK_FILE for p in output.iterdir()):
                    raise SelectorError("Output folder contains files but no progress record. Use an empty folder for a new run.")
                state = create_state(source_directory, prompt_duration(), tools)
                save_progress(output, state)
            session = Session(output, state, tools)
            session.validate_files()
            if state["keep_pending"]:
                print(f"Completed interrupted Keep: {session.finish_keep()}")
            review(session)
        return 0
    except KeyboardInterrupt:
        print("\nStopped. Saved progress is retained; run the same command to continue.")
        return 130
    except (SelectorError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print(f"\nERROR: {exc}\nStopped; completion has not been reported.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    # Source names contain characters outside the Windows Korean code page.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
