"""Create a deterministic handover ZIP and verify it against package files."""
from datetime import date
import hashlib
import json
from pathlib import Path
import re
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / f"{ROOT.name}.zip"
metadata = json.loads((ROOT / "extract/metadata.json").read_text())
stamp = date.fromisoformat(metadata["meta"]["checkedOn"])
zip_time = (stamp.year, stamp.month, stamp.day, 0, 0, 0)

files = sorted(
    p for p in ROOT.rglob("*")
    if p.is_file() and not {".git", ".runtime", ".venv", "node_modules", "__pycache__"}.intersection(p.relative_to(ROOT).parts) and p.suffix not in {".pyc", ".log"} and p.name != ".DS_Store"
    and (".impeccable" not in p.relative_to(ROOT).parts or p.relative_to(ROOT).as_posix() == ".impeccable/design.json")
)
if not files:
    raise SystemExit("Refusing to build an empty package")

secret_pattern = re.compile(rb"(?:sk-|sb_live_)[A-Za-z0-9_-]{24,}")
for path in files:
    if path.name.startswith(".env") or path.suffix in {".pem", ".key"}:
        raise SystemExit(f"Refusing to package a secret/config file: {path.relative_to(ROOT)}")
    if path.suffix in {".js", ".mjs", ".py", ".html", ".json", ".jsonl", ".md", ".command"}:
        if secret_pattern.search(path.read_bytes()):
            raise SystemExit(f"Possible API key found; refusing to package: {path.relative_to(ROOT)}")

tmp = OUT.with_suffix(".zip.tmp")
try:
    with ZipFile(tmp, "w", compression=ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for path in files:
            name = f"{ROOT.name}/{path.relative_to(ROOT).as_posix()}"
            info = ZipInfo(name, date_time=zip_time)
            info.compress_type = ZIP_DEFLATED
            mode = 0o100755 if path.stat().st_mode & 0o111 else 0o100644
            info.external_attr = (mode & 0xFFFF) << 16
            archive.writestr(info, path.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=6)
    tmp.replace(OUT)
finally:
    if tmp.exists():
        tmp.unlink()

with ZipFile(OUT) as archive:
    bad_member = archive.testzip()
    if bad_member:
        raise SystemExit(f"ZIP CRC failed: {bad_member}")
    names = archive.namelist()
    if len(names) != len(files):
        raise SystemExit(f"ZIP file count mismatch: {len(names)} != {len(files)}")
    for path in files:
        name = f"{ROOT.name}/{path.relative_to(ROOT).as_posix()}"
        if hashlib.sha256(archive.read(name)).digest() != hashlib.sha256(path.read_bytes()).digest():
            raise SystemExit(f"ZIP content mismatch: {name}")

result = {
    "status": "passed",
    "files": len(files),
    "zip": str(OUT),
    "bytes": OUT.stat().st_size,
    "sha256": hashlib.sha256(OUT.read_bytes()).hexdigest(),
    "crc": "passed",
}
OUT.with_suffix(".manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False, indent=2))
