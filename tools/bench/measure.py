"""Runs the Tauri benchmark (src/tauri/bench.ts) and measures the app's memory from OUTSIDE.

Usage (stdlib only, no installs):
    python3 -I tools/bench/measure.py --binary target/release/sequencescope [--only largestProteinAffine]

What it measures
  * rust_process_peak_mb : the app's own process, exact peak resident set size (ru_maxrss from wait4).
  * webcontent_peak_mb   : the web-view process(es) the app started, sampled every 50 ms (a transient shorter than 50 ms
                           can be missed, so treat it as a lower bound). Only WebContent processes that did NOT exist
                           before launch are counted, so other apps' web views are excluded.
  * the benchmark report itself (timings and result checksums) as printed by the app.
The app opens a window for the duration of the run (unfocused, no Dock icon); it never takes keyboard focus.
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time


def webcontent():
    """Returns {pid: rss_kb} of all WebKit WebContent processes right now."""
    out = subprocess.run(["ps", "-axo", "pid=,rss=,command="], capture_output=True, text=True, check=True).stdout
    found = {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and "com.apple.WebKit.WebContent" in parts[2]:
            found[int(parts[0])] = int(parts[1])
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True)
    ap.add_argument("--only", default=None)
    args = ap.parse_args()

    before = set(webcontent())
    env = dict(os.environ, SEQUENCESCOPE_SMOKE="1", SEQUENCESCOPE_SMOKE_MODE="bench")
    if args.only:
        env["SEQUENCESCOPE_BENCH_ONLY"] = args.only
    proc = subprocess.Popen([args.binary], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    peak = {"webcontent_kb": 0}
    stop = threading.Event()

    def sample():
        while not stop.is_set():
            try:
                new = {p: r for p, r in webcontent().items() if p not in before}
                peak["webcontent_kb"] = max(peak["webcontent_kb"], sum(new.values()))
            except Exception:  # a process vanished mid-sample: just try again
                pass
            time.sleep(0.05)

    t = threading.Thread(target=sample, daemon=True)
    t.start()
    stdout_chunks = []
    reader = threading.Thread(target=lambda: stdout_chunks.append(proc.stdout.read()), daemon=True)
    reader.start()
    _, status, rusage = os.wait4(proc.pid, 0)
    stop.set()
    reader.join(timeout=5)
    t.join(timeout=2)
    report = None
    for line in "".join(stdout_chunks).splitlines():
        if line.startswith("SMOKE_REPORT "):
            report = json.loads(line[len("SMOKE_REPORT "):])
    result = {
        "backend": "rust",
        "only": args.only,
        "exit": os.waitstatus_to_exitcode(status),
        "rust_process_peak_mb": round(rusage.ru_maxrss / 1048576, 1),  # macOS reports bytes
        "webcontent_peak_mb": round(peak["webcontent_kb"] / 1024, 1),
        "bench": (report or {}).get("bench"),
    }
    print(json.dumps(result))
    sys.exit(0 if result["exit"] == 0 and report else 1)


if __name__ == "__main__":
    main()
