"""Exercise production promotion without sending requests or using credentials."""

import copy
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deploy", Path(__file__).resolve().parent.parent / "scripts/deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "vendor").mkdir()
        for name in ("Code.js", "Sync.js", "vendor/ical.js"):
            (self.root / name).write_text("new source " + name)
        manifest = json.loads((Path(__file__).resolve().parent.parent / "appsscript.json").read_text())
        (self.root / "appsscript.json").write_text(json.dumps(manifest))
        manifest["timeZone"] = "Europe/London"
        self.live = {"files": [{"name": n, "type": "SERVER_JS", "source": "old source"}
                               for n in ("Code", "Sync", "Ical")] + [
            {"name": "Config", "type": "SERVER_JS", "source": "function getInstallationConfig() { return {feedUrl:'private fixture'}; }"},
            {"name": "appsscript", "type": "JSON", "source": json.dumps(manifest)}]}
        self.initial = copy.deepcopy(self.live)
        self.target = {"account": "user@example.com", "scriptId": "fixture"}
        self.identity = {"email": "user@example.com", "verified_email": True}
        self.metadata = {"scriptId": "fixture", "creator": {"email": "user@example.com"}}
        self.calls = []

    def api(self, url, token=None, data=None, method=None):
        self.calls.append((url, method))
        if url.endswith("userinfo"):
            return self.identity
        if url.endswith("/content"):
            if method == "PUT":
                self.live = copy.deepcopy(data)
            return copy.deepcopy(self.live)
        if url.endswith("/versions"):
            return {"versionNumber": 7}
        return copy.deepcopy(self.metadata)

    def run_deploy(self, api=None):
        with patch.object(deploy, "current_revision"), patch.object(deploy, "access_token", return_value="test-token"), \
                patch.object(deploy, "request_json", api or self.api):
            deploy.deploy(self.root, self.target, {}, "a" * 40)

    def test_preserves_config_timezone_and_updates_only_source(self):
        self.run_deploy()
        after = deploy.file_map(self.live)
        before = deploy.file_map(self.initial)
        self.assertEqual(after["Config"], before["Config"])
        self.assertEqual(json.loads(after["appsscript"]["source"])["timeZone"], "Europe/London")
        self.assertEqual(after["Sync"]["source"], "new source Sync.js")
        self.assertEqual(sum(method == "PUT" for _, method in self.calls), 1)
        self.assertTrue(self.calls[-1][0].endswith("/versions"))

    def test_wrong_identity_and_project_are_rejected_before_write(self):
        for changed in ("identity", "metadata"):
            with self.subTest(changed=changed):
                if changed == "identity":
                    self.identity["email"] = "other@example.com"
                else:
                    self.identity["email"] = "user@example.com"
                    self.metadata["scriptId"] = "other"
                with self.assertRaises(ValueError):
                    self.run_deploy()
                self.assertFalse(any(method == "PUT" for _, method in self.calls))

    def test_unknown_or_duplicate_installed_files_rejected(self):
        for extra in ({"name": "Other", "type": "SERVER_JS", "source": "x"}, self.live["files"][0]):
            with self.assertRaises(ValueError):
                deploy.file_map({"files": self.live["files"] + [extra]})

    def test_scope_change_requires_owner_update(self):
        manifest = json.loads((self.root / "appsscript.json").read_text())
        manifest["oauthScopes"].append("https://www.googleapis.com/auth/drive")
        (self.root / "appsscript.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "owner-controlled"):
            self.run_deploy()
        self.assertFalse(any(method == "PUT" for _, method in self.calls))

    def test_concurrent_config_edit_stops_upload(self):
        reads = 0

        def changed(url, token=None, data=None, method=None):
            nonlocal reads
            if url.endswith("/content") and method is None:
                reads += 1
                if reads == 2:
                    self.live["files"][3]["source"] += "changed"
            return self.api(url, token, data, method)

        with self.assertRaisesRegex(ValueError, "changed during"):
            self.run_deploy(changed)
        self.assertFalse(any(method == "PUT" for _, method in self.calls))

    def test_readback_failure_is_not_retried(self):
        def bad_readback(url, token=None, data=None, method=None):
            result = self.api(url, token, data, method)
            if url.endswith("/content") and method is None and any(m == "PUT" for _, m in self.calls):
                result["files"][0]["source"] = "mismatch"
            return result

        with self.assertRaisesRegex(ValueError, "readback differs"):
            self.run_deploy(bad_readback)
        self.assertEqual(sum(m == "PUT" for _, m in self.calls), 1)
        self.assertFalse(any(url.endswith("/versions") for url, _ in self.calls))

    def test_deployment_token_rejects_personal_broad_scopes(self):
        for scopes, valid in [(deploy.SCOPES, True), (deploy.SCOPES | {"https://www.googleapis.com/auth/gmail.modify"}, False)]:
            with self.subTest(valid=valid), patch.object(deploy.urllib.request, "urlopen", return_value=io.BytesIO(
                    json.dumps({"access_token": "fixture", "scope": " ".join(scopes)}).encode())):
                credentials = dict.fromkeys(("client_id", "client_secret", "refresh_token"), "fixture")
                if valid:
                    self.assertEqual(deploy.access_token(credentials), "fixture")
                else:
                    with self.assertRaises(ValueError):
                        deploy.access_token(credentials)

    def test_exact_remote_main_guard(self):
        def git(args, **kwargs):
            if args[1:3] == ["rev-parse", "HEAD"]:
                return "a" * 40
            if args[1] == "status":
                return ""
            return "https://github.com/example/project.git"

        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "example/project", "GITHUB_TOKEN": "fixture"}), \
                patch.object(deploy.subprocess, "check_output", git), \
                patch.object(deploy, "request_json", return_value={"ref": "refs/heads/main", "object": {"type": "commit", "sha": "a" * 40}}) as remote:
            deploy.current_revision(self.root, "a" * 40)
            remote.return_value["object"]["sha"] = "b" * 40
            with self.assertRaisesRegex(ValueError, "Stale"):
                deploy.current_revision(self.root, "a" * 40)


if __name__ == "__main__":
    unittest.main()
