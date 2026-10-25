#!/usr/bin/env python3
"""Focused archive and standalone-skill installer regressions."""

from contextlib import redirect_stdout
import hashlib
from importlib.util import module_from_spec, spec_from_file_location
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]


def load_module(name, filename):
    spec = spec_from_file_location(name, ROOT / filename)
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


archives = load_module("abox_distribution_archives", "scripts/archive-release.py")
installer = load_module("abox_skill_installer", "skills/abox-local-files/scripts/install-adapter.py")
version = json.loads((ROOT / "package.json").read_bytes())["version"]


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="abox-distribution-")
        self.addCleanup(self.temporary.cleanup)
        self.work = Path(self.temporary.name).resolve()

    def fixture(self, platform="linux", arch="x64"):
        label = installer.TARGETS[(platform, arch)]
        name = f"abox-tools-{version}-{label}"
        stage = self.work / "_release"
        stage.mkdir()
        payload = stage / name
        payload.mkdir()
        executable = "node.exe" if platform == "win32" else "node"
        runtime = payload / "runtime" / executable
        runtime.parent.mkdir()
        runtime.write_bytes(b"bundled runtime fixture")
        (payload / "bin").mkdir()
        (payload / "bin/abox-mcp.mjs").write_bytes(b"// MCP fixture\n")
        (payload / "bin/abox.mjs").write_bytes(b"// CLI fixture\n")
        (payload / "package.json").write_bytes(json.dumps({"version": version}).encode())
        (payload / "BUNDLE.json").write_bytes(json.dumps({
            "version": version, "platform": platform, "arch": arch,
            "runtime_sha256": hashlib.sha256(runtime.read_bytes()).hexdigest(),
        }).encode())
        manifest = {"name": "abox-tools", "version": version, "mcpServers": {"abox": {
            "command": "${extensionPath}/runtime/" + executable,
            "args": ["${extensionPath}/bin/abox-mcp.mjs"], "cwd": "${extensionPath}",
        }}}
        (payload / "gemini-extension.json").write_bytes(json.dumps(manifest).encode())
        config = stage / "build.json"
        config.write_bytes(json.dumps({"name": name, "root": str(payload), "version": version, "platform": platform, "arch": arch}).encode())
        with patch.object(sys, "argv", ["archive-release.py", "--config", str(config)]), redirect_stdout(io.StringIO()):
            archives.main()
        return json.loads(config.read_bytes())

    def test_native_and_gemini_archives_share_bytes_but_have_correct_roots(self):
        config = self.fixture()
        self.assertEqual(len(config["assets"]), 6)
        release = self.work / "release"
        gemini = release / "linux.x64.abox-tools.zip"
        self.assertTrue((release / "checksums.linux.x64.abox-tools.zip.sha256").is_file())
        self.assertFalse(gemini.with_name(gemini.name + ".sha256").exists())
        native_mcpb = release / f"{config['name']}.mcpb"
        self.assertEqual(gemini.read_bytes(), native_mcpb.read_bytes())
        with zipfile.ZipFile(gemini) as archive:
            self.assertIn("gemini-extension.json", archive.namelist())
            self.assertNotIn(config["name"] + "/gemini-extension.json", archive.namelist())
            self.assertTrue((archive.getinfo("runtime/node").external_attr >> 16) & 0o111)
        self.assertEqual(Path(config["gemini_smoke_root"]).joinpath("gemini-extension.json").read_bytes(), Path(config["root"]).joinpath("gemini-extension.json").read_bytes())

    def test_standalone_install_checks_archive_then_detects_changed_cache(self):
        config = self.fixture()
        archive = self.work / "release" / f"{config['name']}.zip"
        checksum = archive.with_name(archive.name + ".sha256")
        destination = self.work / "installed adapter"
        result = installer.install(archive, checksum, destination, version, "linux", "x64")
        self.assertTrue(result["ok"])
        self.assertEqual(Path(result["cli"]), destination / "bin/abox.mjs")
        receipt = json.loads((destination / "INSTALL.json").read_bytes())
        self.assertEqual(receipt["schema_version"], 1)
        self.assertNotIn("INSTALL.json", receipt["files"])
        self.assertEqual(receipt["archive_sha256"], installer.digest(archive))
        (destination / "bin/abox-mcp.mjs").write_bytes(b"changed after installation")
        with self.assertRaisesRegex(ValueError, "changed or is incomplete"):
            installer.verify_install(destination, version, "linux", "x64")

    def test_changed_download_creates_no_adapter(self):
        config = self.fixture()
        archive = self.work / "release" / f"{config['name']}.zip"
        checksum = archive.with_name(archive.name + ".sha256")
        with archive.open("ab") as outgoing:
            outgoing.write(b"modified")
        destination = self.work / "must not exist"
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            installer.install(archive, checksum, destination, version, "linux", "x64")
        self.assertFalse(destination.exists())

    def test_skill_setup_rejects_links_and_traversal_before_extraction(self):
        for malicious in ("../escape.txt", "root/runtime/link"):
            archive_path = self.work / ("traversal.zip" if malicious.startswith("..") else "link.zip")
            with zipfile.ZipFile(archive_path, "x") as archive:
                info = zipfile.ZipInfo(malicious)
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16 if "link" in malicious else (stat.S_IFREG | 0o644) << 16
                archive.writestr(info, b"target")
            with zipfile.ZipFile(archive_path) as archive, self.assertRaises(ValueError):
                installer.members(archive, "root")
        self.assertFalse((self.work / "escape.txt").exists())

    def test_distribution_versions_are_pinned_to_the_project(self):
        gemini = json.loads((ROOT / "gemini-extension.json").read_bytes())
        skill = json.loads((ROOT / "skills/abox-local-files/adapter-version.json").read_bytes())
        self.assertEqual(gemini["version"], version)
        self.assertEqual(skill["version"], version)
        self.assertEqual(skill["repository"], "A-Box-of-Tools/abox-tools-plugin")
        self.assertEqual(gemini["mcpServers"]["abox"]["args"], ["${extensionPath}/bin/abox-mcp.mjs"])


if __name__ == "__main__":
    unittest.main()
