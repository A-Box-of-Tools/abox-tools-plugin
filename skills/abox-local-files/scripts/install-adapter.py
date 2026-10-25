#!/usr/bin/env python3
"""Install a pinned abox.tools adapter without npm or editing agent settings."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import platform as host
import re
import shutil
import stat
import sys
import tempfile
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import zipfile

MAX_ARCHIVE = 512 * 1024 * 1024
MAX_EXPANDED = 3 * 1024 * 1024 * 1024
TARGETS = {("win32", "x64"): "windows-x64", ("linux", "x64"): "linux-x64",
           ("darwin", "arm64"): "macos-arm64", ("darwin", "x64"): "macos-x64"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(filename):
    with filename.open("rb") as incoming:
        value = hashlib.sha256()
        for block in iter(lambda: incoming.read(1024 * 1024), b""):
            value.update(block)
        return value.hexdigest()


def target():
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(host.machine().lower())
    platform = "win32" if sys.platform == "win32" else sys.platform
    require((platform, arch) in TARGETS, "Supported adapters: Windows x64, Linux x64, macOS arm64 or x64.")
    return platform, arch


def download(url, destination, maximum):
    request = Request(url, headers={"User-Agent": "abox-tools-skill-setup", "Accept": "application/octet-stream"})
    with urlopen(request, timeout=60) as incoming, destination.open("xb") as outgoing:
        final = urlparse(incoming.url)
        require(final.scheme == "https" and (final.hostname == "github.com" or (final.hostname or "").endswith(".githubusercontent.com")), "Unexpected release download host.")
        total = 0
        while True:
            block = incoming.read(1024 * 1024)
            if not block:
                break
            total += len(block)
            require(total <= maximum, "Release download exceeds its size limit.")
            outgoing.write(block)


def verify_checksum(archive, checksum, name):
    require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size <= MAX_ARCHIVE, "The release archive must be a regular file within the size limit.")
    require(checksum.is_file() and not checksum.is_symlink() and checksum.stat().st_size <= 512, "The checksum must be a small regular file.")
    match = re.fullmatch(r"([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)\r?\n?", checksum.read_bytes().decode("utf-8"))
    actual = digest(archive)
    require(match is not None and match[2] == name and match[1].lower() == actual, "Release SHA-256 verification failed.")
    return actual


def members(archive, bundle_name):
    planned, seen, total = [], set(), 0
    require(len(archive.infolist()) <= 50000, "Release archive has too many entries.")
    for member in archive.infolist():
        raw = member.filename
        require(raw and "\\" not in raw and not raw.startswith("/") and not PureWindowsPath(raw).drive, "Unsafe release archive path.")
        parts = raw.removesuffix("/").split("/")
        require(parts[0] == bundle_name and all(part not in ("", ".", "..") and ":" not in part and not part.endswith((" ", ".")) for part in parts), "Invalid release archive root or path.")
        require(all(re.fullmatch(r"(?i)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part) is None for part in parts), "Reserved release archive path.")
        key = "/".join(parts).casefold()
        require(key not in seen, "Duplicate release archive path.")
        seen.add(key)
        mode = member.external_attr >> 16
        kind = stat.S_IFMT(mode)
        require(not stat.S_ISLNK(mode) and kind in (0, stat.S_IFREG, stat.S_IFDIR), "Release contains a link or special file.")
        require(kind == 0 or member.is_dir() == (kind == stat.S_IFDIR), "Release entry type mismatch.")
        require(not member.flag_bits & 1 and member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "Unsupported release ZIP encoding.")
        total += member.file_size
        require(total <= MAX_EXPANDED and member.file_size <= 1024 * 1024 * 1024, "Expanded release exceeds its size limit.")
        if len(parts) == 1:
            require(member.is_dir(), "The archive root must be a directory.")
            continue
        relative = "/".join(parts[1:])
        require(relative != "INSTALL.json", "The archive must not supply an installation receipt.")
        planned.append((member, relative, stat.S_IMODE(mode)))
    by_name = {relative: member for member, relative, _ in planned}
    for _, relative, _ in planned:
        for parent in PurePosixPath(relative).parents:
            if str(parent) in by_name:
                require(by_name[str(parent)].is_dir(), "An archive file is used as a directory.")
    require("BUNDLE.json" in by_name and "bin/abox-mcp.mjs" in by_name and "bin/abox.mjs" in by_name, "Release is missing its adapter entry points.")
    return planned


def verify_install(destination, version, platform, arch):
    require(destination.is_dir() and not destination.is_symlink(), "The installed adapter directory is invalid.")
    receipt_file = destination / "INSTALL.json"
    require(receipt_file.is_file() and not receipt_file.is_symlink() and receipt_file.stat().st_size <= 16 * 1024 * 1024, "The adapter installation receipt is missing or too large.")
    receipt = json.loads(receipt_file.read_bytes())
    require(isinstance(receipt, dict), "The adapter installation receipt must be an object.")
    require(receipt.get("schema_version") == 1 and receipt.get("version") == version and receipt.get("platform") == platform and receipt.get("arch") == arch, "The adapter receipt does not match this version and platform.")
    expected_archive = f"abox-tools-{version}-{TARGETS[(platform, arch)]}.zip"
    archive_checksum = receipt.get("archive_sha256")
    require(receipt.get("archive") == expected_archive and isinstance(archive_checksum, str) and re.fullmatch(r"[a-f0-9]{64}", archive_checksum) and archive_checksum != "0" * 64, "The adapter receipt has invalid release metadata.")
    inventory = receipt.get("files")
    require(isinstance(inventory, dict) and 0 < len(inventory) <= 50000 and "INSTALL.json" not in inventory, "The adapter receipt has an invalid file inventory.")
    require(len({name.casefold() for name in inventory}) == len(inventory), "The adapter receipt has ambiguous paths.")
    for name, checksum in inventory.items():
        require(isinstance(name, str) and name and "\\" not in name and not name.startswith("/") and all(part not in ("", ".", "..") and ":" not in part for part in name.split("/")), "The adapter receipt has an unsafe path.")
        require(isinstance(checksum, str) and re.fullmatch(r"[a-f0-9]{64}", checksum), "The adapter receipt has an invalid file checksum.")
    files = {}
    for filename in destination.rglob("*"):
        require(not filename.is_symlink(), "The installed adapter contains a symbolic link.")
        require(filename.is_file() or filename.is_dir(), "The installed adapter contains a special file.")
        if filename.is_file() and filename != receipt_file:
            files[filename.relative_to(destination).as_posix()] = digest(filename)
    require(files == inventory, "The installed adapter changed or is incomplete. Move it aside and run setup again.")
    executable = "runtime/node.exe" if platform == "win32" else "runtime/node"
    require(all(name in inventory for name in (executable, "bin/abox-mcp.mjs", "bin/abox.mjs", "BUNDLE.json", "package.json")), "The installed adapter is missing required files.")
    bundle = json.loads((destination / "BUNDLE.json").read_bytes())
    project = json.loads((destination / "package.json").read_bytes())
    require(isinstance(bundle, dict) and isinstance(project, dict), "The installed bundle metadata must be objects.")
    require(bundle.get("version") == version and project.get("version") == version and bundle.get("platform") == platform and bundle.get("arch") == arch and files.get(executable) == bundle.get("runtime_sha256"), "The installed runtime does not match its bundle receipt.")
    if platform != "win32" and sys.platform != "win32":
        require((destination / executable).stat().st_mode & 0o111, "The installed runtime is not executable.")
    return {"ok": True, "version": version, "adapter_root": str(destination), "node_executable": str(destination / executable), "cli": str(destination / "bin/abox.mjs"), "mcp_entry": str(destination / "bin/abox-mcp.mjs"), "archive_sha256": receipt["archive_sha256"]}


def install(archive_path, checksum, destination, version, platform, arch):
    bundle_name = f"abox-tools-{version}-{TARGETS[(platform, arch)]}"
    archive_name = bundle_name + ".zip"
    checksum_value = verify_checksum(archive_path, checksum, archive_name)
    require(not destination.exists() and not destination.is_symlink(), "Refusing to replace an existing adapter.")
    with tempfile.TemporaryDirectory(prefix=".abox-install-", dir=destination.parent) as temporary:
        stage = Path(temporary) / "payload"
        with zipfile.ZipFile(archive_path) as archive:
            planned = members(archive, bundle_name)
            stage.mkdir()
            for member, relative, mode in planned:
                target_file = stage.joinpath(*PurePosixPath(relative).parts)
                if member.is_dir():
                    target_file.mkdir(parents=True, exist_ok=True)
                    continue
                target_file.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as incoming, target_file.open("xb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
                target_file.chmod(mode | (0o111 if relative == "runtime/node" else 0))
        files = {filename.relative_to(stage).as_posix(): digest(filename) for filename in stage.rglob("*") if filename.is_file()}
        receipt = {"schema_version": 1, "version": version, "platform": platform, "arch": arch, "archive": archive_name, "archive_sha256": checksum_value, "files": files}
        (stage / "INSTALL.json").write_bytes((json.dumps(receipt, indent=2) + "\n").encode())
        verify_install(stage, version, platform, arch)
        stage.rename(destination)
    return verify_install(destination, version, platform, arch)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-root", type=Path, help="Absolute adapter cache directory; defaults to ~/.abox-tools/adapters")
    parser.add_argument("--archive", type=Path, help="Use an already downloaded release ZIP instead of the network")
    parser.add_argument("--checksum", type=Path, help="Matching published .sha256 file, required with --archive")
    parser.add_argument("--verify-only", action="store_true", help="Verify an existing cache without downloading")
    args = parser.parse_args()
    metadata = json.loads(Path(__file__).resolve().parents[1].joinpath("adapter-version.json").read_bytes())
    version = metadata.get("version")
    require(isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version), "Invalid pinned adapter version.")
    require(metadata.get("repository") == "A-Box-of-Tools/abox-tools-plugin", "Unexpected adapter publisher.")
    platform, arch = target()
    cache = args.cache_root or Path.home() / ".abox-tools" / "adapters"
    require(cache.is_absolute(), "The adapter cache path must be absolute.")
    destination = cache / version / f"{platform}-{arch}"
    for candidate in (cache, destination.parent, destination):
        require(not candidate.is_symlink(), "The adapter cache must not use symbolic links.")
    if destination.exists() or args.verify_only:
        print(json.dumps(verify_install(destination, version, platform, arch)))
        return
    require(bool(args.archive) == bool(args.checksum), "--archive and --checksum must be supplied together.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination = destination.parent.resolve() / destination.name
    with tempfile.TemporaryDirectory(prefix=".abox-download-", dir=destination.parent) as temporary:
        if args.archive:
            require(args.archive.is_absolute() and args.checksum.is_absolute(), "Offline archive and checksum paths must be absolute.")
            archive_path, checksum = args.archive, args.checksum
        else:
            archive_name = f"abox-tools-{version}-{TARGETS[(platform, arch)]}.zip"
            base = f"https://github.com/{metadata['repository']}/releases/download/v{version}"
            archive_path, checksum = Path(temporary) / archive_name, Path(temporary) / (archive_name + ".sha256")
            download(base + "/" + checksum.name, checksum, 512)
            download(base + "/" + archive_name, archive_path, MAX_ARCHIVE)
        print(json.dumps(install(archive_path, checksum, destination, version, platform, arch)))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        sys.exit(1)
