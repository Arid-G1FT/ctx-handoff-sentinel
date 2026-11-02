#!/usr/bin/env python3
"""ctx-guard: turn one self-report into a handoff document.

The report is the same JSON the model wrote for guard.py. Everything the next
session needs is captured in seven fixed sections so nothing important depends on
the model remembering to mention it.

Usage:
    python3 handoff.py --root . --report .ctx-guard/report.json
    python3 handoff.py --root . --report r.json --out docs/HANDOFF.md
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import subprocess
import sys

LEVEL_LABEL = {"green": "🟢 GREEN", "yellow": "🟡 YELLOW", "red": "🔴 RED"}



def _utf8_stdio() -> None:
    """Emit UTF-8 regardless of the Windows console code page."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - older/embedded interpreters
            pass


def git_changed_files(root: str) -> list[str]:
    try:
        completed = subprocess.run(
            ["git", "status", "--porcelain", "-z"],
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        return []
    if completed.returncode != 0:
        return []
    files = []
    entries = completed.stdout.split("\0")
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if len(entry) < 4:
            continue
        path = entry[3:]
        if "R" in entry[:2] or "C" in entry[:2]:
            if index < len(entries) and entries[index]:
                path = entries[index]
                index += 1
        files.append(path)
    return sorted(set(files))


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


def bullet(lines: list[str]) -> list[str]:
    return [f"- {line}" for line in lines] or ["- （无）"]


def render(report: dict, root: str, created: str, verdict: dict | None) -> str:
    constraints = report.get("constraints") or []
    files = report.get("files") or []
    unknowns = report.get("unknowns") or []
    verify = report.get("verify") or []
    decisions = report.get("decisions") or []
    failed = report.get("failedAttempts") or []

    level = (verdict or {}).get("level") or report.get("verdict") or "unknown"
    label = LEVEL_LABEL.get(level, str(level).upper())

    out: list[str] = []
    out.append("# 上下文交接单 / Context handoff")
    out.append("")
    out.append(f"- 生成时间：{created}")
    out.append(f"- 工作目录：`{os.path.abspath(root)}`")
    out.append(f"- 判定：{label}")
    if report.get("objective"):
        out.append(f"- 目标：{report['objective']}")
    out.append("")

    out.append("## 1. 目标与完成标准")
    out.append("")
    objective = report.get("objective") or report.get("nextStep") or "（未提供，请向用户确认）"
    out.append(str(objective))
    out.append("")

    out.append("## 2. 不可动约束")
    out.append("")
    if constraints:
        for entry in constraints:
            if isinstance(entry, dict):
                text = entry.get("text") or ""
                source = entry.get("source") or ""
                flag = "" if entry.get("certain", True) else "（不确定）"
                out.append(f"- {text}" + (f"（来源：{source}）" if source else "") + flag)
    else:
        out.append("- （无）")
    out.append("")

    out.append("## 3. 当前状态")
    out.append("")
    out.append(f"- 判定：{label}")
    if verdict:
        reasons = verdict.get("reasons") or []
        if reasons:
            out.append("- 证据提示：" + "；".join(reasons))
    out.append(f"- 已完成：{report.get('done') or '（未提供，请核对 git 工作区）'}")
    out.append("")

    out.append("## 4. 改动文件与原因")
    out.append("")
    if files:
        for entry in files:
            if isinstance(entry, dict):
                out.append(
                    f"- `{entry.get('path')}` — {entry.get('change') or '改动'}；原因：{entry.get('reason') or '未说明'}"
                )
    else:
        changed = git_changed_files(root)
        if changed:
            out.append("（模型未列出文件；以下来自 git 工作区）")
            out.extend(f"- `{path}`" for path in changed)
        else:
            out.append("- （无）")
    out.append("")

    out.append("## 5. 关键决策与被否决方案")
    out.append("")
    if decisions:
        for entry in decisions:
            out.append(f"- {entry}")
    else:
        out.append("- （未提供）")
    out.append("")

    out.append("## 6. 已知坑与失败尝试")
    out.append("")
    rows = [str(item) for item in failed] + [f"无法确认：{item}" for item in unknowns]
    out.extend(bullet(rows))
    out.append("")

    out.append("## 7. 下一步与验证命令")
    out.append("")
    out.append(f"- 下一步：{report.get('nextStep') or '（未提供）'}")
    if verify:
        out.append("- 验证命令：")
        for command in verify:
            out.append(f"  - `{command}`")
    else:
        out.append("- 验证命令：（未提供）")
    out.append("")

    out.append("## 新对话开场白")
    out.append("")
    out.append("```text")
    out.append("读取这份交接单后继续工作。先复述约束和当前状态，再动手；")
    out.append("如果交接单和磁盘上的实际状态冲突，以磁盘为准并告诉我。")
    out.append("```")
    out.append("")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    _utf8_stdio()
    parser = argparse.ArgumentParser(description="Write a context handoff document.")
    parser.add_argument("--root", default=".", help="workspace root (default: cwd)")
    parser.add_argument("--report", default="-", help="JSON report path, or - for stdin")
    parser.add_argument(
        "--out",
        default=None,
        help="output path (default: .ctx-handoff/HANDOFF-<timestamp>.md)",
    )
    parser.add_argument("--json", action="store_true", help="also print machine-readable metadata")
    args = parser.parse_args(argv)

    root = os.path.abspath(args.root)
    payload = sys.stdin.read() if args.report == "-" else open(
        args.report, "r", encoding="utf-8-sig", errors="replace"
    ).read()
    try:
        report = json.loads(clean_payload(payload))
    except ValueError as error:
        print(f"ctx-guard: cannot parse report: {error}", file=sys.stderr)
        return 1
    if not isinstance(report, dict):
        print("ctx-guard: report must be a JSON object", file=sys.stderr)
        return 1

    verdict = None
    guard_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "guard.py")
    if os.path.exists(guard_path):
        try:
            import importlib.util

            spec = importlib.util.spec_from_file_location("ctx_guard_evidence", guard_path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)  # type: ignore[union-attr]
            actual = module.git_changed_files(root)
            verdict = module.assess(root, report, actual, "git working tree" if actual is not None else "no git baseline")
        except Exception:  # noqa: BLE001 - handoff must still be written
            verdict = None

    created = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    markdown = render(report, root, created, verdict)

    out_path = args.out
    if out_path is None:
        out_dir = os.path.join(root, ".ctx-handoff")
        os.makedirs(out_dir, exist_ok=True)
        stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        out_path = os.path.join(out_dir, f"HANDOFF-{stamp}.md")
    else:
        out_path = os.path.abspath(out_path)
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(markdown + "\n")

    if args.json:
        print(json.dumps({"path": out_path, "level": (verdict or {}).get("level")}, ensure_ascii=False))
    else:
        print(f"交接单已写入：{out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
