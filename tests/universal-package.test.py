"""Exercise universal assembly against mismatched and unsafe release inputs."""

import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("universal_archive", ROOT / "scripts" / "universal-archive.py")
archive_tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(archive_tool)
VERSION = "0.2.1"
REVISION = "a" * 40


def checksum(filename):
    filename.with_name(filename.name + ".sha256").write_bytes(
        f"{hashlib.sha256(filename.read_bytes()).hexdigest()}  {filename.name}\n".encode()
    )


def fixtures(directory):
    for label, (platform, arch, executable) in archive_tool.TARGETS.items():
        runtime = f"Node fixture for {label}".encode()
        files = {name: f"Shared fixture: {name}".encode() for name in archive_tool.REQUIRED_COMMON}
        files["package.json"] = json.dumps({"version": VERSION, "type": "module"}).encode()
        files[f"runtime/{executable}"] = runtime
        files["runtime/LICENSE"] = b"Node fixture license"
        files["plugin.json"] = b"Platform-specific Codex plugin"
        files["START-HERE.html"] = b"Platform-specific installer"
        files["BUNDLE.json"] = json.dumps({
            "version": VERSION, "platform": platform, "arch": arch, "node_version": "24.0.0",
            "source_revision": REVISION, "dirty_source": False, "upstream_commit": "b" * 40,
            "runtime_sha256": hashlib.sha256(runtime).hexdigest(),
        }).encode()
        files["manifest.json"] = json.dumps({
            "manifest_version": "0.3", "name": "abox-tools", "version": VERSION,
            "server": {"type": "binary", "entry_point": f"runtime/{executable}", "mcp_config": {
                "command": "${__dirname}/runtime/" + executable,
                "args": ["${__dirname}/bin/abox-mcp.mjs"],
            }},
        }).encode()
        for extension in ("zip", "mcpb"):
            filename = directory / f"abox-tools-{VERSION}-{label}.{extension}"
            with zipfile.ZipFile(filename, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for name, data in files.items():
                    info = zipfile.ZipInfo(name)
                    info.create_system = 3
                    info.external_attr = (stat.S_IFREG | (0o755 if name == f"runtime/{executable}" else 0o644)) << 16
                    archive.writestr(info, data)
            checksum(filename)


class UniversalPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="abox-universal-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.inputs = self.root / "native"
        self.inputs.mkdir()
        self.output = self.root / "prepared payload"
        fixtures(self.inputs)

    def prepare(self):
        archive_tool.prepare(self.inputs, self.output, VERSION, REVISION)

    def rewrite(self, label, change):
        filename = self.inputs / f"abox-tools-{VERSION}-{label}.mcpb"
        with zipfile.ZipFile(filename) as archive:
            files = {item.filename: (item, archive.read(item)) for item in archive.infolist()}
        change(files)
        with zipfile.ZipFile(filename, "w") as archive:
            for item, data in files.values():
                archive.writestr(item, data)
        checksum(filename)

    def test_assembly_preserves_all_runtimes_and_omits_native_installer_files(self):
        self.prepare()
        self.assertFalse((self.output / "START-HERE.html").exists())
        self.assertFalse((self.output / "plugin.json").exists())
        self.assertFalse((self.output / "mcp.json").exists())
        self.assertTrue((self.output / "PRIVACY.md").is_file())
        self.assertTrue((self.output / "SECURITY.md").is_file())
        for label, (_, _, executable) in archive_tool.TARGETS.items():
            self.assertEqual((self.output / "runtime" / label / executable).read_bytes(), f"Node fixture for {label}".encode())
        # The macOS script and manifest are generated only after native evidence
        # has been verified. Here their bytes need not execute for archive tests.
        (self.output / "manifest.json").write_bytes(b"{}\n")
        launch = self.output / "scripts" / "launch-macos.sh"
        launch.write_bytes(b"#!/bin/sh\nexit 0\n")
        launch.chmod(0o755)
        output = self.root / "universal.mcpb"
        archive_tool.finalize(self.output, output)
        with zipfile.ZipFile(output) as archive:
            self.assertTrue((archive.getinfo("runtime/macos-arm64/node").external_attr >> 16) & 0o111)
            self.assertTrue((archive.getinfo("scripts/launch-macos.sh").external_attr >> 16) & 0o111)
        extracted = self.root / "relocated payload"
        archive_tool.extract(output, extracted)
        self.assertEqual((extracted / "src" / "tools.mjs").read_bytes(), (self.output / "src" / "tools.mjs").read_bytes())

    def test_changed_dependency_is_rejected_before_any_payload_is_written(self):
        def change(files):
            info, _ = files["node_modules/zod/package.json"]
            files[info.filename] = (info, b"Different dependency")
        self.rewrite("macos-x64", change)
        with self.assertRaisesRegex(ValueError, "Shared processing code or dependencies differ"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_changed_archive_is_rejected_by_its_recorded_checksum(self):
        filename = self.inputs / f"abox-tools-{VERSION}-linux-x64.mcpb"
        with filename.open("ab") as outgoing:
            outgoing.write(b"Changed after recording")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_escaping_path_and_symbolic_link_are_rejected_before_extraction(self):
        for unsafe in ("../escaped", "runtime/link"):
            with self.subTest(unsafe=unsafe):
                def change(files):
                    info = zipfile.ZipInfo(unsafe)
                    info.create_system = 3
                    info.external_attr = (stat.S_IFLNK | 0o777) << 16 if unsafe.endswith("link") else (stat.S_IFREG | 0o644) << 16
                    files[unsafe] = (info, b"../elsewhere")
                self.rewrite("windows-x64", change)
                with self.assertRaisesRegex(ValueError, "Unsafe archive path|link or special file"):
                    self.prepare()
                self.assertFalse(self.output.exists())
                fixtures(self.inputs)

    def test_wrong_source_revision_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "source revision is not clean and pinned"):
            archive_tool.prepare(self.inputs, self.output, VERSION, "c" * 40)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
