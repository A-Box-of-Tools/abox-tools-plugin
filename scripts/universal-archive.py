#!/usr/bin/env python3
"""Verify native release inputs and assemble or extract the universal MCPB."""

from __future__ import annotations

import argparse
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import sys
import zipfile

from importlib.util import module_from_spec, spec_from_file_location


TARGETS = {
    "windows-x64": ("win32", "x64", "node.exe"),
    "linux-x64": ("linux", "x64", "node"),
    "macos-arm64": ("darwin", "arm64", "node"),
    "macos-x64": ("darwin", "x64", "node"),
}
COMMON_ROOTS = ("bin/", "src/", "vendor/", "assets/", "node_modules/")
COMMON_FILES = {"package.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "PRIVACY.md", "SECURITY.md", "scripts/verify-vendor.mjs"}
REQUIRED_COMMON = {
    "bin/abox-mcp.mjs", "src/tools.mjs", "vendor/abox/provenance.json",
    "assets/icon.png", "package.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "PRIVACY.md", "SECURITY.md",
    "scripts/verify-vendor.mjs", "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/zod/package.json", "node_modules/playwright-core/package.json",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_file(filename: Path) -> str:
    with filename.open("rb") as incoming:
        return hashlib.file_digest(incoming, "sha256").hexdigest()


def archive_members(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    members = {}
    names = set()
    total = 0
    require(len(archive.infolist()) <= 50000, "Archive has too many entries.")
    for member in archive.infolist():
        raw = member.filename
        name = raw.removesuffix("/")
        parts = PurePosixPath(name).parts
        require(name and raw == name + ("/" if member.is_dir() else ""), f"Invalid archive name: {raw}")
        require("\\" not in raw and not raw.startswith("/") and not PureWindowsPath(raw).drive, f"Unsafe archive name: {raw}")
        require(all(part not in ("", ".", "..") and ":" not in part for part in name.split("/")), f"Unsafe archive path: {raw}")
        require(parts and all(not part.endswith((" ", ".")) for part in parts), f"Nonportable archive path: {raw}")
        require(all(re.fullmatch(r"(?i)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part) is None for part in parts), f"Reserved archive path: {raw}")
        key = name.casefold()
        require(key not in names, f"Duplicate archive path: {raw}")
        names.add(key)
        mode = member.external_attr >> 16
        kind = stat.S_IFMT(mode)
        require(not stat.S_ISLNK(mode) and kind in (0, stat.S_IFREG, stat.S_IFDIR), f"Archive contains a link or special file: {raw}")
        require(kind == 0 or member.is_dir() == (kind == stat.S_IFDIR), f"Archive entry type mismatch: {raw}")
        require(not member.flag_bits & 1, "Encrypted release archives are unsupported.")
        require(member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "Unsupported archive compression.")
        require(member.file_size <= 1024 * 1024 * 1024, "Archive entry is too large.")
        total += member.file_size
        require(total <= 3 * 1024 * 1024 * 1024, "Expanded archive is too large.")
        members[name] = member
    # Reject a file used as another entry's parent before any extraction begins.
    for name in members:
        for parent in PurePosixPath(name).parents:
            if str(parent) in members:
                require(members[str(parent)].is_dir(), f"Archive parent is not a directory: {parent}")
    return members


def json_member(archive: zipfile.ZipFile, members: dict, name: str) -> dict:
    require(name in members and not members[name].is_dir(), f"Missing archive metadata: {name}")
    require(members[name].file_size <= 2 * 1024 * 1024, f"Metadata is too large: {name}")
    value = json.loads(archive.read(members[name]))
    require(isinstance(value, dict), f"Metadata is not an object: {name}")
    return value


def member_hash(archive: zipfile.ZipFile, member: zipfile.ZipInfo) -> str:
    with archive.open(member) as incoming:
        return hashlib.file_digest(incoming, "sha256").hexdigest()


def check_checksum(archive: Path) -> str:
    require(archive.is_file() and not archive.is_symlink(), f"Missing regular archive: {archive}")
    checksum = archive.with_name(archive.name + ".sha256")
    require(checksum.is_file() and not checksum.is_symlink() and checksum.stat().st_size <= 512, f"Missing checksum: {checksum}")
    match = re.fullmatch(r"([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)\r?\n?", checksum.read_bytes().decode("utf-8"))
    require(match is not None and match[2] == archive.name, f"Invalid checksum record: {checksum}")
    digest = sha256_file(archive)
    require(match[1].lower() == digest, f"Release checksum mismatch: {archive.name}")
    return digest


def write_json(filename: Path, value: dict) -> None:
    with filename.open("xb") as outgoing:
        outgoing.write((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def prepare(inputs: Path, destination: Path, version: str, revision: str) -> None:
    require(re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version) is not None, "Invalid release version.")
    require(re.fullmatch(r"[a-f0-9]{40,64}", revision) is not None, "Invalid source revision.")
    require(inputs.is_dir() and not inputs.is_symlink(), "Native inputs must be a regular directory.")
    require(not destination.exists() and not destination.is_symlink(), "Universal staging directory already exists.")
    expected = {f"abox-tools-{version}-{label}.{extension}{suffix}" for label in TARGETS for extension in ("zip", "mcpb") for suffix in ("", ".sha256")}
    require({entry.name for entry in inputs.iterdir()} == expected, "Universal assembly requires exactly sixteen native release assets.")
    native = {}
    shared = None
    upstream = None
    with ExitStack() as stack:
        for label, (platform, arch, executable) in TARGETS.items():
            base = f"abox-tools-{version}-{label}"
            archive_path = inputs / f"{base}.mcpb"
            digest = check_checksum(archive_path)
            check_checksum(inputs / f"{base}.zip")
            archive = stack.enter_context(zipfile.ZipFile(archive_path))
            members = archive_members(archive)
            metadata = json_member(archive, members, "BUNDLE.json")
            manifest = json_member(archive, members, "manifest.json")
            require(metadata.get("version") == version and metadata.get("platform") == platform and metadata.get("arch") == arch, f"Native metadata disagrees: {label}")
            require(metadata.get("source_revision") == revision and metadata.get("dirty_source") is False, f"Native source revision is not clean and pinned: {label}")
            require(isinstance(metadata.get("node_version"), str) and re.fullmatch(r"\d+\.\d+\.\d+", metadata["node_version"]) is not None, f"Invalid Node version: {label}")
            if upstream is None:
                upstream = metadata.get("upstream_commit")
            require(isinstance(upstream, str) and metadata.get("upstream_commit") == upstream, f"Native upstream revisions differ: {label}")
            runtime_name = f"runtime/{executable}"
            require(manifest.get("name") == "abox-tools" and manifest.get("version") == version and manifest.get("manifest_version") == "0.3", f"Native manifest disagrees: {label}")
            require(manifest.get("server") == {"type": "binary", "entry_point": runtime_name, "mcp_config": {"command": "${__dirname}/" + runtime_name, "args": ["${__dirname}/bin/abox-mcp.mjs"]}}, f"Unexpected native MCP launch configuration: {label}")
            require(runtime_name in members and "runtime/LICENSE" in members, f"Missing bundled runtime or license: {label}")
            require(member_hash(archive, members[runtime_name]) == metadata.get("runtime_sha256"), f"Runtime checksum mismatch: {label}")
            common = {name: member_hash(archive, member) for name, member in members.items() if not member.is_dir() and (name in COMMON_FILES or name.startswith(COMMON_ROOTS))}
            require(REQUIRED_COMMON.issubset(common), f"Native payload lacks required server files: {label}")
            if shared is None:
                shared = common
            require(common == shared, f"Shared processing code or dependencies differ across native bundles: {label}")
            native[label] = (archive, members, metadata, digest)

        destination.mkdir(parents=True)
        first_archive, first_members, _, _ = native["windows-x64"]
        for name in sorted(shared):
            target = destination.joinpath(*PurePosixPath(name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with first_archive.open(first_members[name]) as incoming, target.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
            target.chmod(0o644)
        runtimes = {}
        for label, (archive, members, metadata, digest) in native.items():
            executable = TARGETS[label][2]
            for source, name in [(f"runtime/{executable}", executable), ("runtime/LICENSE", "LICENSE")]:
                target = destination / "runtime" / label / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(members[source]) as incoming, target.open("xb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
                target.chmod(0o755 if name in ("node", "node.exe") else 0o644)
            runtimes[label] = {key: metadata[key] for key in ("platform", "arch", "node_version", "runtime_sha256")}
            runtimes[label]["native_mcpb_sha256"] = digest
        write_json(destination / "BUNDLE.json", {"kind": "universal-mcpb", "version": version, "source_revision": revision, "upstream_commit": upstream, "runtimes": runtimes, "shared_sha256": shared})


def archive_helpers():
    spec = spec_from_file_location("abox_archive_release", Path(__file__).with_name("archive-release.py"))
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def finalize(root: Path, output: Path) -> None:
    require(root.is_dir() and not root.is_symlink(), "Universal payload must be a regular directory.")
    require(not output.exists() and not output.is_symlink(), "Universal archive already exists.")
    checksum = output.with_name(output.name + ".sha256")
    require(not checksum.exists() and not checksum.is_symlink(), "Universal checksum already exists.")
    helper = archive_helpers()
    output.parent.mkdir(parents=True, exist_ok=True)
    entries = []
    executables = {f"runtime/{label}/{executable}" for label, (_, _, executable) in TARGETS.items()}
    executables.add("scripts/launch-macos.sh")
    for source, relative, mode, directory in helper.payload_entries(root):
        if relative in executables:
            mode |= 0o111
        entries.append((source, relative, mode, directory))
    helper.write_archive(output, None, entries)
    helper.write_checksum(output, checksum)


def extract(archive_path: Path, destination: Path) -> None:
    check_checksum(archive_path)
    require(not destination.exists() and not destination.is_symlink(), "Extraction destination already exists.")
    with zipfile.ZipFile(archive_path) as archive:
        members = archive_members(archive)
        metadata = json_member(archive, members, "BUNDLE.json")
        require(metadata.get("kind") == "universal-mcpb", "The archive is not a universal MCPB.")
        destination.mkdir(parents=True)
        for name, member in members.items():
            target = destination.joinpath(*PurePosixPath(name).parts)
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as incoming, target.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
            target.chmod(stat.S_IMODE(member.external_attr >> 16) or 0o644)
        for name, expected in metadata.get("shared_sha256", {}).items():
            require(name in members and not members[name].is_dir(), f"Missing shared file: {name}")
            require(member_hash(archive, members[name]) == expected, f"Shared file checksum mismatch: {name}")
        for label, (_, _, executable) in TARGETS.items():
            name = f"runtime/{label}/{executable}"
            require(name in members and not members[name].is_dir(), f"Missing runtime: {label}")
            require(member_hash(archive, members[name]) == metadata["runtimes"][label]["runtime_sha256"], f"Runtime checksum mismatch: {label}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    preparing = commands.add_parser("prepare")
    preparing.add_argument("--inputs", required=True, type=Path)
    preparing.add_argument("--destination", required=True, type=Path)
    preparing.add_argument("--version", required=True)
    preparing.add_argument("--revision", required=True)
    finalizing = commands.add_parser("finalize")
    finalizing.add_argument("--root", required=True, type=Path)
    finalizing.add_argument("--output", required=True, type=Path)
    extracting = commands.add_parser("extract")
    extracting.add_argument("--archive", required=True, type=Path)
    extracting.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args()
    for field in ("inputs", "destination", "root", "output", "archive"):
        if hasattr(args, field):
            require(getattr(args, field).is_absolute(), f"--{field} must be absolute.")
    if args.operation == "prepare":
        prepare(args.inputs, args.destination, args.version, args.revision)
    elif args.operation == "finalize":
        finalize(args.root, args.output)
    else:
        extract(args.archive, args.destination)
    print(json.dumps({"ok": True, "operation": args.operation}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"Universal bundle failed: {error}", file=sys.stderr)
        sys.exit(1)
