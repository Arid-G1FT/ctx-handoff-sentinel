#!/usr/bin/env python3
"""ctx-guard: deterministic evidence check for a context-handoff self-report.

The model answers three recall questions (constraints / changed files / next
step). This script never supplies the answers: it only compares what the model
claimed against what the working tree actually contains, and returns a verdict.

Policy: the model's own verdict is the baseline. Evidence overrides it only on a
hard contradiction (amnesia about constraints, a report that omits most of the
files the session touched, a report with no next step at all). Ordinary
bookkeeping noise — a few helper files omitted, shell-written paths the git
baseline cannot see, honestly declared unknowns — is reported as context and
never demotes the verdict.

Usage:
    python3 guard.py --root . --report .ctx-guard/report.json
    python3 guard.py --root . --report - --json        # report on stdin
    python3 guard.py --root . --report r.json --session-files writes.txt

Exit codes: 0 = green or yellow, 2 = red, 1 = malformed input.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

VERDICT_ORDER = {"green": 0, "yellow": 1, "red": 2}
ORDER_VERDICT = {value: key for key, value in VERDICT_ORDER.items()}

# Hard-contradiction thresholds. Tuned so that a healthy session is not demoted
# for omitting a handful of scratch files.
MISSING_RATIO_YELLOW = 0.5
MISSING_COUNT_YELLOW = 2
# Losing almost all file memory is no longer a warning: at >=90% and >=10 files
# the context cannot account for its own work, which is what red means.
MISSING_RATIO_RED = 0.9
MISSING_COUNT_RED = 10
PHANTOM_RATIO_YELLOW = 0.5
PHANTOM_COUNT_YELLOW = 3
NO_FILES_REPORTED_MIN_ACTUAL = 3

CONSTRAINT_HINTS = ("constraint", "rule", "requirement", "限制", "约束", "规则", "要求")
AMNESIA_HINTS = (
    "cannot recall",
    "can't recall",
    "do not remember",
    "don't remember",
    "not sure",
    "unsure",
    "无法确认",
    "记不清",
    "不记得",
    "不能确认",
)

LEVEL_LABEL = {"green": "🟢 GREEN", "yellow": "🟡 YELLOW", "red": "🔴 RED"}



def _utf8_stdio() -> None:
    """Emit UTF-8 regardless of the Windows console code page."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - older/embedded interpreters
            pass


def bump(level: str, minimum: str) -> str:
    """Raise a verdict to at least ``minimum``; never lower it."""
    return level if VERDICT_ORDER.get(level, 0) >= VERDICT_ORDER[minimum] else minimum


def normalize_path(root: str, path: str) -> str | None:
    """Normalize one report path against the root; return POSIX relative form when inside."""
    if not isinstance(path, str) or not path.strip():
        return None
    raw = path.strip().strip("`'\"")
    if not raw:
        return None
    absolute = raw if os.path.isabs(raw) else os.path.join(root, raw)
    absolute = os.path.normpath(absolute)
    try:
        relative = os.path.relpath(absolute, root)
    except ValueError:  # different drive on Windows
        return absolute.replace("\\", "/")
    if relative.startswith(".."):
        return absolute.replace("\\", "/")
    return relative.replace("\\", "/")


def run_git(root: str, args: list[str]) -> tuple[int, str]:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        return 127, ""
    return completed.returncode, completed.stdout


def git_changed_files(root: str, baseline: str = "HEAD") -> list[str] | None:
    """Files the working tree changed, from git. ``None`` when this is not a repo."""
    code, inside = run_git(root, ["rev-parse", "--is-inside-work-tree"])
    if code != 0 or inside.strip() != "true":
        return None

    files: list[str] = []
    code, porcelain = run_git(root, ["status", "--porcelain", "-z"])
    if code == 0 and porcelain:
        entries = porcelain.split("\0")
        index = 0
        while index < len(entries):
            entry = entries[index]
            index += 1
            if len(entry) < 4:
                continue
            status = entry[:2]
            path = entry[3:]
            if "R" in status or "C" in status:
                # Rename/copy entries carry the destination as the next token.
                if index < len(entries) and entries[index]:
                    path = entries[index]
                    index += 1
            relative = normalize_path(root, path)
            if relative is not None:
                files.append(relative)

    # A tracked diff against the baseline catches changes git status also shows;
    # the explicit diff keeps renamed/deleted files visible by destination.
    if baseline:
        code, diff = run_git(root, ["diff", "--name-only", "--no-renames", baseline, "--"]) 
        if code == 0:
            for line in diff.splitlines():
                relative = normalize_path(root, line)
                if relative is not None:
                    files.append(relative)

    return sorted(set(files))


def read_file_list(path: str, root: str) -> list[str]:
    with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
        lines = [line.strip() for line in handle if line.strip()]
    normalized = [normalize_path(root, line) for line in lines]
    return sorted({item for item in normalized if item is not None})


def looks_executable(command: str) -> bool:
    return len(command.strip()) >= 3 and any(char in command for char in (" ", "/", "\\", "-", "."))


def assess(root: str, report: dict, actual: list[str] | None, evidence_label: str) -> dict:
    """Compare one self-report with the ground truth and return the verdict payload."""
    if not isinstance(report, dict):
        raise ValueError("report must be a JSON object")

    verdict = report.get("verdict", "green")
    level = verdict if verdict in VERDICT_ORDER else "green"

    reasons: list[str] = []
    notes: list[str] = []

    constraints = report.get("constraints") or []
    files = report.get("files") or []
    unknowns = [str(item) for item in (report.get("unknowns") or [])]
    next_step = str(report.get("nextStep") or "").strip()
    verify = [str(item) for item in (report.get("verify") or [])]

    reported = [normalize_path(root, entry.get("path")) for entry in files if isinstance(entry, dict)]
    reported = [path for path in reported if path is not None]

    missing: list[str] = []
    phantom: list[str] = []
    if actual is not None:
        actual_set = set(actual)
        reported_set = set(reported)
        missing = [path for path in actual if path not in reported_set]
        phantom = [path for path in reported if path not in actual_set]

    if not constraints:
        notes.append("no constraints listed (fine when nothing is pinned)")

    if actual is not None:
        if len(actual) >= NO_FILES_REPORTED_MIN_ACTUAL and not reported:
            if len(actual) >= MISSING_COUNT_RED:
                level = "red"
                reasons.append(
                    f"the working tree changed {len(actual)} file(s) but the report lists none: "
                    "file memory is gone, hand off"
                )
            else:
                level = bump(level, "yellow")
                reasons.append(
                    f"the working tree changed {len(actual)} file(s) but the report lists none"
                )
        elif missing:
            ratio = len(missing) / max(len(actual), 1)
            if len(missing) >= MISSING_COUNT_RED and ratio > MISSING_RATIO_RED:
                level = "red"
                reasons.append(
                    f"report omits {len(missing)}/{len(actual)} changed files ({round(ratio * 100)}%): "
                    "file memory is effectively gone, hand off"
                )
            elif len(missing) >= MISSING_COUNT_YELLOW and ratio > MISSING_RATIO_YELLOW:
                level = bump(level, "yellow")
                reasons.append(
                    f"report omits {len(missing)}/{len(actual)} changed files (more than half): "
                    + ", ".join(missing[:3])
                )
            else:
                notes.append(
                    f"{len(missing)} file(s) omitted (minor, no demotion): " + ", ".join(missing[:3])
                )

        if phantom:
            ratio = len(phantom) / max(len(reported), 1)
            if len(phantom) >= PHANTOM_COUNT_YELLOW and ratio > PHANTOM_RATIO_YELLOW:
                level = bump(level, "yellow")
                reasons.append(
                    f"{len(phantom)} reported file(s) are not in the {evidence_label} baseline "
                    "and dominate the report (possible fabrication): " + ", ".join(phantom[:3])
                )
            else:
                notes.append(
                    f"{len(phantom)} reported file(s) are not in the {evidence_label} baseline "
                    "(usually shell writes outside git, no demotion)"
                )

    for entry in files:
        if isinstance(entry, dict) and len(str(entry.get("reason") or "").strip()) < 4:
            notes.append(f"{entry.get('path')} has a too-short reason")
            break

    amnesia = any(hint in unknown.lower() for unknown in unknowns for hint in AMNESIA_HINTS)
    constraint_unknown = any(
        hint in unknown.lower() for unknown in unknowns for hint in CONSTRAINT_HINTS
    )
    if amnesia and (constraint_unknown or not constraints):
        level = "red"
        reasons.append("the report admits it cannot recall the constraints/rules")
    elif unknowns:
        notes.append(f"{len(unknowns)} honestly declared unknown(s) (no demotion)")

    if not next_step:
        level = bump(level, "yellow")
        reasons.append("no next step")
    elif not verify:
        level = bump(level, "yellow")
        reasons.append("no verification command")
    elif not any(looks_executable(command) for command in verify):
        level = bump(level, "yellow")
        reasons.append("verification commands do not look runnable")

    if verdict == "red" and level != "red":
        level = "red"
        reasons.append("the model self-reported red")
    elif verdict == "green" and level != "green":
        reasons.append(
            f"the model self-reported green, but the evidence disagrees (evidence: {level.upper()})"
        )

    return {
        "level": level,
        "label": LEVEL_LABEL[level],
        "reasons": list(dict.fromkeys(reasons)),
        "notes": list(dict.fromkeys(notes)),
        "counts": {
            "actualFiles": 0 if actual is None else len(actual),
            "reportedFiles": len(reported),
            "missing": len(missing),
            "phantom": len(phantom),
        },
        "evidence": evidence_label,
    }


def render(result: dict) -> str:
    lines = [f"ctx-guard · {result['label']}"]
    if result["reasons"]:
        lines.append("reasons: " + "; ".join(result["reasons"]))
    if result["notes"]:
        lines.append("notes: " + "; ".join(result["notes"]))
    counts = result["counts"]
    lines.append(
        "evidence: {actual} changed · {reported} reported · {missing} missing · {phantom} unverified".format(
            actual=counts["actualFiles"],
            reported=counts["reportedFiles"],
            missing=counts["missing"],
            phantom=counts["phantom"],
        )
        + f" (baseline: {result['evidence']})"
    )
    return "\n".join(lines)


def clean_payload(payload: str) -> str:
    """Strip a UTF-8 BOM and an optional ```json fence from a report body."""
    text = payload.replace("\ufeff", "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


def load_report(path: str) -> dict:
    if path == "-":
        payload = sys.stdin.read()
    else:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
            payload = handle.read()
    return json.loads(clean_payload(payload))


def main(argv: list[str] | None = None) -> int:
    _utf8_stdio()
    parser = argparse.ArgumentParser(description="Evidence-check a context handoff self-report.")
    parser.add_argument("--root", default=".", help="workspace root (default: cwd)")
    parser.add_argument("--report", default="-", help="JSON report path, or - for stdin")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    parser.add_argument(
        "--session-files",
        default=None,
        help="optional newline-separated list of files the session wrote (native write log)",
    )
    parser.add_argument("--baseline", default="HEAD", help="git ref used as the change baseline")
    args = parser.parse_args(argv)

    root = os.path.abspath(args.root)
    try:
        report = load_report(args.report)
    except (OSError, ValueError) as error:
        print(f"ctx-guard: cannot read report: {error}", file=sys.stderr)
        return 1

    if args.session_files:
        try:
            actual = read_file_list(args.session_files, root)
        except OSError as error:
            print(f"ctx-guard: cannot read --session-files: {error}", file=sys.stderr)
            return 1
        label = "session write log"
    else:
        actual = git_changed_files(root, args.baseline)
        label = "git working tree" if actual is not None else "no git baseline"

    try:
        result = assess(root, report, actual, label)
    except ValueError as error:
        print(f"ctx-guard: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(render(result))

    return 2 if result["level"] == "red" else 0


if __name__ == "__main__":
    sys.exit(main())
