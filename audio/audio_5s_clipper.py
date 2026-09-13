from pathlib import Path
from pydub import AudioSegment


CLIP_LENGTH_SECONDS = 5
OUTPUT_FOLDER_NAME = "clips"


def time_to_ms(timepoint):
    """
    Convert m:s or m:ss.s into milliseconds.
    Examples:
        1:23   -> 83000 ms
        2:15.5 -> 135500 ms
    """
    try:
        minutes, seconds = timepoint.strip().split(":")
        total_seconds = int(minutes) * 60 + float(seconds)

        if total_seconds < 0:
            raise ValueError

        return int(total_seconds * 1000)

    except (ValueError, TypeError):
        raise ValueError("Time must be in m:s format, for example 2:15 or 2:15.5")


def main():
    # Folder containing this Python script
    script_folder = Path(__file__).resolve().parent

    # Create output folder
    output_folder = script_folder / OUTPUT_FOLDER_NAME
    output_folder.mkdir(exist_ok=True)

    # Find MP3 files whose filenames are numbers: 001.mp3, 002.mp3, etc.
    audio_files = [
        file
        for file in script_folder.glob("*.mp3")
        if file.stem.isdigit()
    ]

    # Sort numerically: 001, 002, 003, ...
    audio_files.sort(key=lambda file: int(file.stem))

    if not audio_files:
        print("No numbered MP3 files were found.")
        return

    print(f"Found {len(audio_files)} audio file(s).")
    print("Enter the clip start time in m:s format.")
    print("Examples: 1:23, 2:15.5")
    print("Press Enter without typing anything to skip a file.")
    print()

    for audio_file in audio_files:
        print(f"--- {audio_file.name} ---")

        # Load the audio
        audio = AudioSegment.from_file(audio_file)

        duration_seconds = len(audio) / 1000
        print(f"Duration: {duration_seconds:.1f} seconds")

        while True:
            user_input = input(
                f"Start time for {audio_file.name}: "
            ).strip()

            # Allow skipping
            if user_input == "":
                print("Skipped.\n")
                break

            try:
                start_ms = time_to_ms(user_input)
            except ValueError as error:
                print(error)
                continue

            end_ms = start_ms + (CLIP_LENGTH_SECONDS * 1000)

            # Make sure a full 5-second clip is possible
            if end_ms > len(audio):
                latest_start = max(
                    0,
                    (len(audio) / 1000) - CLIP_LENGTH_SECONDS
                )

                print(
                    f"Not enough audio remaining for a 5-second clip.\n"
                    f"Latest possible start time is approximately "
                    f"{latest_start:.1f} seconds."
                )
                continue

            # Extract clip
            clip = audio[start_ms:end_ms]

            # Keep exactly the same filename
            output_file = output_folder / audio_file.name

            # Save as MP3
            clip.export(output_file, format="mp3")

            print(
                f"Saved: {OUTPUT_FOLDER_NAME}/{audio_file.name} "
                f"({user_input} → 5 seconds later)\n"
            )

            break

    print("Finished.")


if __name__ == "__main__":
    main()