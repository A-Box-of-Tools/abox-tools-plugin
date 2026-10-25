#!/usr/bin/env python3
"""Archive a prepared bundle and extract the ZIP for a relocation smoke test."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import sys
import zipfile


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def inside(path: Path, directory: Path) -> bool:
    return path == directory or directory in path.parents


def payload_entries(root: Path) -> list[tuple[Path, str, int, bool]]:
    entries = []
    for current, directories, files in os.walk(root, followlinks=False):
        directories.sort()
        files.sort()
        for name in directories + files:
            source = Path(current) / name
            info = source.lstat()
            require(not stat.S_ISLNK(info.st_mode), f"Bundle contains a symbolic link: {source}")
            directory = stat.S_ISDIR(info.st_mode)
            require(directory or stat.S_ISREG(info.st_mode), f"Bundle contains a special file: {source}")
            relative = source.relative_to(root).as_posix()
            mode = stat.S_IMODE(info.st_mode)
            # Windows cannot retain POSIX execute bits when assembling a Unix
            # bundle. These two entry points still need to survive extraction.
            if directory or relative == "runtime/node" or relative.endswith(".command"):
                mode |= 0o111
            entries.append((source, relative, mode, directory))
    require(bool(entries), "The prepared bundle is empty.")
    return sorted(entries, key=lambda entry: entry[1])


def zip_info(name: str, mode: int, directory: bool = False) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name + ("/" if directory and not name.endswith("/") else ""))
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED
    info._compresslevel = 6
    info.external_attr = ((stat.S_IFDIR if directory else stat.S_IFREG) | mode) << 16
    if directory:
        info.external_attr |= 0x10
    return info


def write_archive(destination: Path, name: str | None, entries: list) -> None:
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        if name:
            archive.writestr(zip_info(name, 0o755, True), b"", compresslevel=6)
        for source, relative, mode, directory in entries:
            member = f"{name}/{relative}" if name else relative
            info = zip_info(member, mode, directory)
            if directory:
                archive.writestr(info, b"", compresslevel=6)
            else:
                # Streaming avoids holding the bundled runtime and dependencies
                # in memory alongside their compressed copies.
                info.file_size = source.stat().st_size
                with source.open("rb") as incoming, archive.open(info, "w", force_zip64=True) as outgoing:
                    shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)


def write_checksum(archive: Path, destination: Path) -> None:
    checksum = hashlib.sha256()
    with archive.open("rb") as incoming:
        for block in iter(lambda: incoming.read(1024 * 1024), b""):
            checksum.update(block)
    with destination.open("xb") as outgoing:
        outgoing.write(f"{checksum.hexdigest()}  {archive.name}\n".encode("utf-8"))


def extract_checked(archive_path: Path, destination: Path, name: str | None) -> Path:
    require(not destination.exists() and not destination.is_symlink(), f"Extraction destination already exists: {destination}")
    extraction_root = destination.resolve()
    planned = []
    seen = set()
    with zipfile.ZipFile(archive_path, "r") as archive:
        for member in archive.infolist():
            raw = member.filename
            parts = PurePosixPath(raw).parts
            require(bool(parts) and (name is None or parts[0] == name), f"Unexpected archive root: {raw}")
            require("\\" not in raw and not raw.startswith("/"), f"Invalid archive path: {raw}")
            require(not PureWindowsPath(raw).drive, f"Archive path has a drive: {raw}")
            require(all(part not in (".", "..", "") and ":" not in part for part in parts), f"Invalid archive path: {raw}")
            target = extraction_root.joinpath(*parts).resolve()
            require(target != extraction_root and inside(target, extraction_root), f"Archive path escapes extraction root: {raw}")
            key = os.path.normcase(str(target))
            require(key not in seen, f"Duplicate archive path: {raw}")
            seen.add(key)
            mode = member.external_attr >> 16
            kind = stat.S_IFMT(mode)
            require(not stat.S_ISLNK(mode), f"Archive contains a symbolic link: {raw}")
            require(kind in (0, stat.S_IFREG, stat.S_IFDIR), f"Archive contains a special file: {raw}")
            require(member.is_dir() == (kind == stat.S_IFDIR), f"Archive entry type disagrees with its path: {raw}")
            planned.append((member, target, stat.S_IMODE(mode)))

        # Validate every entry before creating even the first extracted file.
        destination.mkdir()
        directory_modes = []
        for member, target, mode in planned:
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                directory_modes.append((target, mode))
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            require(not target.is_symlink(), f"Extraction target became a symbolic link: {target}")
            with archive.open(member) as incoming, target.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
            target.chmod(mode)
        for target, mode in reversed(directory_modes):
            target.chmod(mode)

    payload = (destination / name if name else destination).resolve(strict=True)
    require(inside(payload, extraction_root), "Extracted payload escaped its destination.")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path, help="Absolute path to the prepared bundle build.json")
    arguments = parser.parse_args()
    require(arguments.config.is_absolute(), "--config must be an absolute path.")
    require(not arguments.config.is_symlink(), "The build configuration must not be a symbolic link.")
    config_path = arguments.config.resolve(strict=True)
    config = json.loads(config_path.read_bytes().decode("utf-8"))
    name = config.get("name", "")
    require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) is not None, "Invalid bundle name.")
    root_value = config.get("root")
    require(isinstance(root_value, str) and Path(root_value).is_absolute(), "The payload root must be absolute.")
    original_root = Path(root_value)
    require(not original_root.is_symlink(), "The payload root must not be a symbolic link.")
    root = original_root.resolve(strict=True)
    build_root = config_path.parent
    require(root.is_dir() and root.name == name, "The prepared payload directory must match its bundle name.")
    require(root != build_root and inside(root, build_root), "The payload must be inside the build configuration directory.")

    release_root = build_root.parent / "release"
    require(not release_root.is_symlink(), "The release output directory must not be a symbolic link.")
    require(not release_root.exists() or release_root.is_dir(), "The release output path is not a directory.")
    extraction_root = build_root / "extracted bundle"
    zip_path = release_root / f"{name}.zip"
    mcpb_path = release_root / f"{name}.mcpb"
    zip_checksum = release_root / f"{name}.zip.sha256"
    mcpb_checksum = release_root / f"{name}.mcpb.sha256"
    platform, arch = config.get("platform"), config.get("arch")
    require((platform, arch) in {("win32", "x64"), ("linux", "x64"), ("darwin", "arm64"), ("darwin", "x64")}, "Unsupported Gemini release target.")
    gemini_path = release_root / f"{platform}.{arch}.abox-tools.zip"
    # Gemini's release selector matches only the platform prefix, including
    # checksum files. Keep checksums outside that prefix regardless of upload order.
    gemini_checksum = gemini_path.with_name("checksums." + gemini_path.name + ".sha256")
    gemini_extraction = build_root / "extracted Gemini extension"
    assets = [zip_path, zip_checksum, mcpb_path, mcpb_checksum, gemini_path, gemini_checksum]
    for output in [*assets, extraction_root, gemini_extraction]:
        require(not output.exists() and not output.is_symlink(), f"Refusing to replace existing output: {output}")

    entries = payload_entries(root)
    release_root.mkdir(exist_ok=True)
    write_archive(zip_path, name, entries)
    write_checksum(zip_path, zip_checksum)
    write_archive(mcpb_path, None, entries)
    write_checksum(mcpb_path, mcpb_checksum)
    # Gemini's GitHub release loader discovers this exact platform/architecture
    # name and requires its manifest directly at the archive root.
    require((root / "gemini-extension.json").is_file(), "Missing Gemini extension manifest.")
    write_archive(gemini_path, None, entries)
    write_checksum(gemini_path, gemini_checksum)
    extracted = extract_checked(zip_path, extraction_root, name)
    config["smoke_root"] = str(extracted)
    config["gemini_smoke_root"] = str(extract_checked(gemini_path, gemini_extraction, None))
    config["assets"] = [str(asset.resolve(strict=True)) for asset in assets]
    config_path.write_bytes((json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(json.dumps({"ok": True, "smoke_root": str(extracted), "assets": config["assets"]}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"Release archive failed: {error}", file=sys.stderr)
        sys.exit(1)
