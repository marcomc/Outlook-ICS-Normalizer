"""Verify private upload state and credential transport without network access."""

import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
spec = importlib.util.spec_from_file_location("uploader", Path(__file__).resolve().parent.parent / "scripts/upload.py")
uploader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uploader)


class UploadTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "scripts").mkdir()
        (self.root / "build").mkdir()
        (self.root / "config.local.json").write_text(json.dumps({"installationAccount": "user@example.com"}))
        for name in ("Code.gs", "Sync.gs", "Ical.gs", "Config.gs", "appsscript.json"):
            (self.root / "build" / name).write_text("private fixture")
        self.commands = []
        self.uploaded = None

    def cli(self, args, **kwargs):
        self.commands.append(args)
        if args[1:3] == ["auth", "status"]:
            result = {"user": "user@example.com"}
        elif args[1:3] == ["auth", "export"]:
            result = {"client_id": "fixture", "client_secret": "secret", "refresh_token": "refresh"}
        else:
            result = {"scriptId": "fixture-script"}
        return SimpleNamespace(stdout=json.dumps(result))

    def request(self, request):
        if "oauth2.googleapis.com" in request.full_url:
            result = {"access_token": "fixture-access"}
        elif request.get_method() == "PUT":
            self.uploaded = json.loads(request.data)
            result = {}
        else:
            result = self.uploaded
        return io.BytesIO(json.dumps(result).encode())

    def test_upload_and_exact_readback(self):
        with patch.object(uploader, "__file__", str(self.root / "scripts/upload.py")), \
                patch.object(uploader.subprocess, "run", self.cli), \
                patch.object(uploader.urllib.request, "urlopen", self.request):
            uploader.main()
            uploader.main()
        self.assertEqual(sum("create" in args for args in self.commands), 1)
        self.assertEqual(len(self.uploaded["files"]), 5)
        self.assertTrue(all("private fixture" not in str(args) and "secret" not in str(args)
                            for args in self.commands))
        self.assertEqual((self.root / ".installation.json").stat().st_mode & 0o777, 0o600)

    def test_uncertain_creation_is_not_repeated(self):
        def failed(args, **kwargs):
            if "create" in args:
                self.commands.append(args)
                raise subprocess.CalledProcessError(1, args)
            return self.cli(args, **kwargs)
        with patch.object(uploader, "__file__", str(self.root / "scripts/upload.py")), \
                patch.object(uploader.subprocess, "run", failed):
            with self.assertRaises(subprocess.CalledProcessError):
                uploader.main()
            with self.assertRaisesRegex(SystemExit, "uncertain"):
                uploader.main()
        self.assertEqual(sum("create" in args for args in self.commands), 1)


if __name__ == "__main__":
    unittest.main()
