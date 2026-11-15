"""Temporary fixtures only; never writes the study's audio or audio_temp folders."""

import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from tools import audio_clip_selector as selector


class SelectorTests(unittest.TestCase):
    def test_default_paths_still_use_the_repository_root(self):
        repository = Path(__file__).resolve().parent.parent
        self.assertEqual(selector.ROOT, repository)
        self.assertEqual(selector.DEFAULT_SOURCE, repository.parent / "05. Adjusted Audio")
        self.assertEqual(selector.DEFAULT_OUTPUT, repository / "audio_temp")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="clip-selector-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "source"
        self.output = self.root / "output"
        self.source.mkdir()
        self.output.mkdir()
        first = self.source / "source0001.mp3"
        first.write_bytes(b"source fixture")
        self.sources = [first]
        for index in range(2, 201):
            path = self.source / f"source{index:04d}.mp3"
            path.write_bytes(b"source fixture")
            self.sources.append(path)
        self.state = {
            "version": 1, "source_directory": str(self.source), "clip_seconds": 5.0,
            "sources": [dict(filename=p.name, size=p.stat().st_size,
                             mtime_ns=p.stat().st_mtime_ns, duration_seconds=20.0)
                        for p in self.sources],
            "accepted": [], "candidate": None, "keep_pending": False,
        }
        self.tools = {name: name for name in ("ffmpeg", "ffprobe", "ffplay")}
        self.session = selector.Session(self.output, self.state, self.tools)

    def ready_candidate(self):
        data = b"the exact previewed compressed audio"
        self.session.candidate_path.write_bytes(data)
        self.state["candidate"] = {
            "start_seconds": 1.25, "actual_seconds": 5.016,
            "sha256": hashlib.sha256(data).hexdigest(), "byte_size": len(data),
        }
        self.session.save()
        return data

    def reload(self):
        state = json.loads((self.output / selector.PROGRESS_FILE).read_text(encoding="utf-8"))
        selector.validate_state(state, self.source)
        return selector.Session(self.output, state, self.tools)

    def test_selects_24th_48th_through_4800th_in_filename_order(self):
        paths = [Path(f"piece{i:05d}.mp3") for i in range(1, 4832)]
        paths.append(Path("ignore.wav"))
        directory = Mock()
        directory.iterdir.return_value = reversed(paths)
        with patch.object(Path, "is_file", return_value=True):
            selected = selector.select_sources(directory)
        self.assertEqual(len(selected), 200)
        self.assertEqual(selected[0].name, "piece00024.mp3")
        self.assertEqual(selected[1].name, "piece00048.mp3")
        self.assertEqual(selected[-1].name, "piece04800.mp3")

    def test_duration_validation_does_not_skip_an_incompatible_source(self):
        with patch.object(selector, "select_sources", return_value=self.sources), \
                patch.object(selector, "probe_duration", side_effect=[20.0, 4.0]), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(selector.SelectorError, "No sources were skipped"):
                selector.create_state(self.source, 5.0, self.tools)
        self.assertFalse((self.output / selector.PROGRESS_FILE).exists())

    def test_random_range_and_pending_point_survive_restart(self):
        with patch.object(selector.random, "SystemRandom") as random_class:
            random_class.return_value.uniform.return_value = 7.125
            self.session.choose_candidate()
            random_class.return_value.uniform.assert_called_once_with(0, 15.0)
        resumed = self.reload()
        self.assertEqual(resumed.state["candidate"]["start_seconds"], 7.125)
        self.assertEqual(resumed.state["clip_seconds"], 5.0)
        self.assertEqual(resumed.index, 0)

    def test_equal_duration_has_only_zero_start(self):
        self.state["sources"][0]["duration_seconds"] = 5.0
        self.session.choose_candidate()
        self.assertEqual(self.session.max_start, 0)
        self.assertEqual(self.state["candidate"]["start_seconds"], 0)

    def test_retry_stays_on_same_source_and_does_not_save_a_clip(self):
        self.ready_candidate()
        with patch.object(selector.random, "SystemRandom") as random_class:
            random_class.return_value.uniform.return_value = 8.25
            self.session.choose_candidate()
        resumed = self.reload()
        self.assertEqual(resumed.index, 0)
        self.assertEqual(resumed.state["candidate"]["start_seconds"], 8.25)
        self.assertIsNone(resumed.state["candidate"]["sha256"])
        self.assertFalse((self.output / "0001.mp3").exists())

    def test_keep_promotes_the_exact_preview_and_records_source_mapping(self):
        data = self.ready_candidate()
        self.assertEqual(self.session.keep(), "0001.mp3")
        self.assertEqual((self.output / "0001.mp3").read_bytes(), data)
        self.assertFalse(self.session.candidate_path.exists())
        resumed = self.reload()
        resumed.validate_files()
        self.assertEqual(resumed.index, 1)
        self.assertIsNone(resumed.state["candidate"])
        self.assertEqual(resumed.state["accepted"][0]["source_filename"], self.sources[0].name)
        self.assertEqual(resumed.state["accepted"][0]["start_seconds"], 1.25)

    def test_failed_atomic_progress_write_preserves_previous_record(self):
        self.session.save()
        previous = (self.output / selector.PROGRESS_FILE).read_bytes()
        with patch.object(selector.os, "replace", side_effect=OSError("disk error")):
            with self.assertRaisesRegex(OSError, "disk error"):
                self.session.choose_candidate()
        self.assertEqual((self.output / selector.PROGRESS_FILE).read_bytes(), previous)
        self.assertFalse((self.output / "0001.mp3").exists())

    def test_failed_extraction_keeps_start_point_and_never_advances(self):
        with patch.object(selector.random, "SystemRandom") as random_class, \
                patch.object(selector, "checked_command", side_effect=selector.SelectorError("extract failed")):
            random_class.return_value.uniform.return_value = 3.5
            with self.assertRaisesRegex(selector.SelectorError, "extract failed"):
                self.session.ensure_candidate()
        resumed = self.reload()
        self.assertEqual(resumed.index, 0)
        self.assertEqual(resumed.state["candidate"]["start_seconds"], 3.5)
        self.assertFalse((self.output / "0001.mp3").exists())

    def test_existing_output_is_never_overwritten(self):
        self.ready_candidate()
        target = self.output / "0001.mp3"
        target.write_bytes(b"existing kept clip")
        with self.assertRaises(selector.SelectorError):
            self.session.keep()
        self.assertEqual(target.read_bytes(), b"existing kept clip")
        self.assertEqual(self.session.index, 0)

    def test_interrupted_keep_before_rename_finishes_once_on_restart(self):
        data = self.ready_candidate()
        with patch.object(Path, "rename", side_effect=OSError("rename failed")):
            with self.assertRaisesRegex(OSError, "rename failed"):
                self.session.keep()
        resumed = self.reload()
        self.assertTrue(resumed.state["keep_pending"])
        self.assertEqual(resumed.index, 0)
        resumed.validate_files()
        resumed.finish_keep()
        self.assertEqual(self.reload().index, 1)
        self.assertEqual((self.output / "0001.mp3").read_bytes(), data)

    def test_interrupted_keep_after_rename_finishes_once_on_restart(self):
        data = self.ready_candidate()
        original_save = self.session.save
        calls = 0

        def fail_final_write():
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("final progress write failed")
            original_save()

        with patch.object(self.session, "save", side_effect=fail_final_write):
            with self.assertRaisesRegex(OSError, "final progress write failed"):
                self.session.keep()
        resumed = self.reload()
        self.assertEqual(resumed.index, 0)
        self.assertTrue(resumed.state["keep_pending"])
        self.assertFalse(resumed.candidate_path.exists())
        resumed.validate_files()
        resumed.finish_keep()
        self.assertEqual(self.reload().index, 1)
        self.assertEqual((self.output / "0001.mp3").read_bytes(), data)

    def test_modified_source_clip_and_corrupt_state_fail_clearly(self):
        self.ready_candidate()
        changed = copy.deepcopy(self.state)
        changed["sources"][0]["filename"] = "..\\outside.mp3"
        with self.assertRaises(selector.SelectorError):
            selector.validate_state(changed, self.source)
        self.session.candidate_path.write_bytes(b"changed")
        with self.assertRaises(selector.SelectorError):
            self.session.ensure_candidate()
        self.sources[0].write_bytes(b"changed source")
        with self.assertRaisesRegex(selector.SelectorError, "Source file changed"):
            self.session.validate_files()

    def test_quit_during_playback_stops_player_and_preserves_candidate(self):
        data = self.ready_candidate()
        with patch.object(selector, "Player") as player_class, \
                patch.object(selector.msvcrt, "kbhit", side_effect=[False, True]), \
                patch.object(selector.msvcrt, "getwch", return_value="q"), \
                contextlib.redirect_stdout(io.StringIO()):
            selector.review(self.session)
        player_class.return_value.start.assert_called_once_with(self.session.candidate_path)
        player_class.return_value.stop.assert_called_once()
        self.assertEqual(self.reload().index, 0)
        self.assertEqual(self.session.candidate_path.read_bytes(), data)

    def test_keep_during_playback_can_save_final_0200_and_complete(self):
        data = self.ready_candidate()
        record = self.state["candidate"]
        self.state["accepted"] = [dict(record, output_filename=f"{i + 1:04d}.mp3",
                                       source_filename=self.sources[i].name) for i in range(199)]
        with patch.object(selector, "Player") as player_class, \
                patch.object(selector.msvcrt, "kbhit", side_effect=[False, True]), \
                patch.object(selector.msvcrt, "getwch", return_value="k"), \
                contextlib.redirect_stdout(io.StringIO()) as printed:
            selector.review(self.session)
        self.assertEqual(self.reload().index, 200)
        self.assertEqual((self.output / "0200.mp3").read_bytes(), data)
        self.assertIn("all 200 clips have been saved", printed.getvalue())
        player_class.return_value.stop.assert_called()

    def test_keyboard_interrupt_during_playback_stops_player(self):
        self.ready_candidate()
        with patch.object(selector, "Player") as player_class, \
                patch.object(selector.msvcrt, "kbhit", side_effect=[False, KeyboardInterrupt]), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(KeyboardInterrupt):
                selector.review(self.session)
        player_class.return_value.stop.assert_called_once()
        self.assertEqual(self.reload().index, 0)

    def test_run_after_emptying_completed_output_asks_for_new_duration(self):
        data = self.ready_candidate()
        record = self.state["candidate"]
        for i in range(200):
            (self.output / f"{i + 1:04d}.mp3").write_bytes(data)
            self.state["accepted"].append(dict(record, output_filename=f"{i + 1:04d}.mp3",
                                               source_filename=self.sources[i].name))
        self.state["candidate"] = None
        self.session.save()
        for path in self.output.iterdir():
            path.unlink()  # Only this test's private TemporaryDirectory.
        with patch.object(selector.sys.stdin, "isatty", return_value=True), \
                patch.object(selector, "find_tools", return_value=self.tools), \
                patch("builtins.input", return_value="7.5") as prompt, \
                patch.object(selector, "select_sources", return_value=self.sources), \
                patch.object(selector, "probe_duration", return_value=20.0), \
                patch.object(selector, "review"), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(selector.main(["--source", str(self.source), "--output", str(self.output)]), 0)
        prompt.assert_called_once()
        self.assertEqual(self.reload().state["clip_seconds"], 7.5)
        self.assertEqual(self.reload().index, 0)

    def test_output_lock_blocks_a_second_process_and_releases_after_exit(self):
        command = [selector.sys.executable, "-c",
                   "import sys; from pathlib import Path; from tools import audio_clip_selector as s; "
                   "folder=Path(sys.argv[1]); "
                   "exec('with s.output_lock(folder):\\n print(\"locked\")')", str(self.output)]
        with selector.output_lock(self.output):
            blocked = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn("Another selector", blocked.stderr)
        released = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(released.returncode, 0, released.stderr)


class RealFFmpegTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="clip-selector-ffmpeg-test-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.tools = selector.find_tools()
        cls.source = cls.root / "original.mp3"
        selector.checked_command([
            cls.tools["ffmpeg"], "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:a", "libmp3lame",
            "-q:a", "2", str(cls.source),
        ])

    def test_stream_copy_packets_match_original_and_resume_uses_same_candidate(self):
        output = self.root / "copied"
        output.mkdir()
        stat = self.source.stat()
        state = {"source_directory": str(self.root), "clip_seconds": 1.0, "accepted": [],
                 "candidate": {"start_seconds": 1.234, "sha256": None, "actual_seconds": None, "byte_size": None},
                 "sources": [{"filename": self.source.name, "size": stat.st_size,
                              "mtime_ns": stat.st_mtime_ns, "duration_seconds": selector.probe_duration(self.source, self.tools)}],
                 "keep_pending": False}
        session = selector.Session(output, state, self.tools)
        session.ensure_candidate()
        self.assertLess(abs(state["candidate"]["actual_seconds"] - 1.0), 0.1)

        def hashes(path):
            info = json.loads(selector.checked_command([
                self.tools["ffprobe"], "-v", "error", "-select_streams", "a:0", "-show_packets",
                "-show_data_hash", "sha256", "-show_entries", "packet=data_hash", "-of", "json", str(path),
            ]))
            return [packet["data_hash"] for packet in info["packets"]]

        original_hashes = hashes(self.source)
        copied_hashes = hashes(session.candidate_path)
        self.assertTrue(copied_hashes)
        self.assertTrue(any(original_hashes[i:i + len(copied_hashes)] == copied_hashes
                            for i in range(len(original_hashes) - len(copied_hashes) + 1)))
        before = session.candidate_path.read_bytes()
        with patch.object(selector, "checked_command", side_effect=AssertionError("must not re-extract")):
            session.ensure_candidate()
        session.keep()
        self.assertEqual((output / "0001.mp3").read_bytes(), before)

    def test_real_playback_failure_is_explicit_even_if_ffplay_returns_zero(self):
        output = self.root / "bad-playback"
        output.mkdir()
        player = selector.Player(output, self.tools["ffplay"])
        try:
            with patch.dict(os.environ, {"SDL_AUDIODRIVER": "clip_selector_invalid_driver"}):
                player.start(self.source)
            deadline = time.monotonic() + 10
            while player.process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertIsNotNone(player.process.poll(), "ffplay did not exit after audio device failure")
            with self.assertRaisesRegex(selector.SelectorError, "Audio playback failed"):
                player.check()
        finally:
            player.stop()

    def test_real_playback_finishes_without_status_text_being_treated_as_error(self):
        output = self.root / "normal-playback"
        output.mkdir()
        player = selector.Player(output, self.tools["ffplay"])
        try:
            # A test audio sink exercises ffplay without requiring speakers in CI.
            with patch.dict(os.environ, {"SDL_AUDIODRIVER": "dummy"}):
                player.start(self.source)
            deadline = time.monotonic() + 10
            while player.process.poll() is None and time.monotonic() < deadline:
                player.check()
                time.sleep(0.05)
            self.assertEqual(player.process.poll(), 0)
            player.check()
            self.assertEqual(player.log_path.read_bytes(), b"")
        finally:
            player.stop()


if __name__ == "__main__":
    unittest.main()
