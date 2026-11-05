"""Exercise preparation with synthetic private settings in an isolated copy."""

import json
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class PrepareTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "project"
        self.root.mkdir()
        source = Path(__file__).resolve().parent.parent
        for name in ("Code.js", "appsscript.json", "scripts/prepare.py"):
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, destination)
        self.config = json.loads((source / "config.example.json").read_text())
        self.config["feedUrl"] = "https://example.com/private-fixture.ics"
        (self.root / "config.local.json").write_text(json.dumps(self.config))

    def prepare(self):
        return subprocess.run([sys.executable, "scripts/prepare.py"], cwd=self.root,
                              capture_output=True, text=True, check=False)

    def test_fresh_and_existing_private_outputs(self):
        self.assertEqual(self.prepare().returncode, 0)
        build = self.root / "build"
        generated = build / "Config.gs"
        self.assertIn(self.config["feedUrl"], generated.read_text())
        self.assertEqual((build / "Code.gs").read_text(), (self.root / "Code.js").read_text())
        self.assertEqual(json.loads((build / "appsscript.json").read_text())["timeZone"], "Etc/UTC")
        generated.chmod(0o644)
        old_inode = generated.stat().st_ino
        self.assertEqual(self.prepare().returncode, 0)
        self.assertNotEqual(generated.stat().st_ino, old_inode)
        for name in ("Code.gs", "Config.gs", "appsscript.json"):
            self.assertEqual(stat.S_IMODE((build / name).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(build.stat().st_mode), 0o700)
        self.assertEqual(list(build.glob(".prepare-*")), [])

    def test_rejects_symlinked_build_directory(self):
        outside = self.root.parent / "outside"
        outside.mkdir()
        (self.root / "build").symlink_to(outside, target_is_directory=True)
        self.assertNotEqual(self.prepare().returncode, 0)
        self.assertEqual(list(outside.iterdir()), [])

    def test_rejects_symlinked_output_files(self):
        build = self.root / "build"
        build.mkdir()
        sentinel = self.root.parent / "sentinel"
        sentinel.write_text("untouched")
        for name in ("Code.gs", "Config.gs", "appsscript.json"):
            with self.subTest(name=name):
                destination = build / name
                destination.symlink_to(sentinel)
                self.assertNotEqual(self.prepare().returncode, 0)
                self.assertEqual(sentinel.read_text(), "untouched")
                destination.unlink()


if __name__ == "__main__":
    unittest.main()
