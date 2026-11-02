import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

from guard import assess, normalize_path, render  # noqa: E402
from handoff import render as render_handoff  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def report(**overrides):
    base = {
        "verdict": "green",
        "constraints": [{"text": "do not touch the public API", "source": "user", "certain": True}],
        "files": [{"path": "src/a.ts", "change": "null guard", "reason": "crash on empty", "certain": True}],
        "nextStep": "rerun the failing test",
        "verify": ["npm test -- src/a.test.ts"],
        "unknowns": [],
    }
    base.update(overrides)
    return base


class AssessTests(unittest.TestCase):
    def test_bookkeeping_noise_keeps_green(self):
        actual = [f"src/f{i}.ts" for i in range(12)]
        files = [{"path": f"src/f{i}.ts", "change": "edit", "reason": "fix", "certain": True} for i in range(7)]
        files += [
            {"path": "C:/Users/me/.dsh/sessions/x/session.v4.jsonl.zstd", "change": "repair", "reason": "session fix", "certain": True},
            {"path": "backup.zstd", "change": "backup", "reason": "rollback safety", "certain": True},
            {"path": ".ctx-guard/patch.py", "change": "script", "reason": "repair tool", "certain": True},
        ]
        result = assess(ROOT, report(files=files, unknowns=["where the old thread went", "handoff not verified"]), actual, "git working tree")
        self.assertEqual(result["level"], "green")
        self.assertEqual(result["counts"]["missing"], 5)
        self.assertEqual(result["counts"]["phantom"], 3)
        self.assertIn("no demotion", " ".join(result["notes"]))
        self.assertIn("GREEN", render(result))

    def test_major_omission_demotes(self):
        actual = [f"src/f{i}.ts" for i in range(6)]
        result = assess(ROOT, report(files=[{"path": "src/f0.ts", "change": "x", "reason": "fix", "certain": True}]), actual, "git working tree")
        self.assertEqual(result["level"], "yellow")
        self.assertIn("omits", " ".join(result["reasons"]))

    def test_constraint_amnesia_is_red(self):
        result = assess(
            ROOT,
            report(constraints=[], unknowns=["无法确认约束是否还生效"]),
            ["src/a.ts"],
            "git working tree",
        )
        self.assertEqual(result["level"], "red")

    def test_no_git_baseline_still_returns_verdict(self):
        result = assess(ROOT, report(), None, "no git baseline")
        self.assertEqual(result["level"], "green")
        self.assertEqual(result["counts"]["actualFiles"], 0)

    def test_missing_next_step_demotes(self):
        result = assess(ROOT, report(nextStep=""), ["src/a.ts"], "git working tree")
        self.assertEqual(result["level"], "yellow")

    def test_no_constraints_is_only_a_note(self):
        result = assess(ROOT, report(constraints=[]), ["src/a.ts"], "git working tree")
        self.assertEqual(result["level"], "green")

    def test_unknowns_without_constraint_hint_is_note(self):
        result = assess(ROOT, report(unknowns=["deploy flag"]), ["src/a.ts"], "git working tree")
        self.assertEqual(result["level"], "green")

    def test_path_normalization(self):
        self.assertEqual(normalize_path(ROOT, "src/a.ts"), "src/a.ts")
        self.assertIsNone(normalize_path(ROOT, "   "))


class HandoffTests(unittest.TestCase):
    def test_handoff_contains_seven_sections(self):
        text = render_handoff(report(objective="ship the fix"), ROOT, "2026-01-01 00:00", {"level": "green", "reasons": []})
        for heading in (
            "## 1. 目标与完成标准",
            "## 2. 不可动约束",
            "## 3. 当前状态",
            "## 4. 改动文件与原因",
            "## 5. 关键决策与被否决方案",
            "## 6. 已知坑与失败尝试",
            "## 7. 下一步与验证命令",
            "## 新对话开场白",
        ):
            self.assertIn(heading, text)
        self.assertIn("ship the fix", text)
        self.assertIn("npm test -- src/a.test.ts", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
