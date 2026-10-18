"""Consistent full backups; restore only into a new directory."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import zipfile
from .core import LocalError, Store


def create_backup(store, output):
    output = Path(output)
    with tempfile.TemporaryDirectory(prefix='esg-backup-') as folder:
        database = Path(folder) / 'workbench.sqlite3'
        with store.connect() as source, sqlite3.connect(database) as target:
            source.backup(target)
        with sqlite3.connect(database) as db:
            originals = db.execute('SELECT sha,size FROM blobs').fetchall()
        manifest = {'schema': 1, 'databaseSha256': hashlib.sha256(database.read_bytes()).hexdigest(), 'originals': []}
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED) as archive:
            archive.write(database, 'workbench.sqlite3')
            for sha, size in originals:
                path = store.blobs / sha
                if path.stat().st_size != size or hashlib.sha256(path.read_bytes()).hexdigest() != sha:
                    raise LocalError('原件校验失败，未生成可交付备份。', 409)
                archive.write(path, 'originals/' + sha)
                manifest['originals'].append({'sha256': sha, 'bytes': size})
            archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False))
    output.chmod(0o600)
    return output


def restore_backup(backup, destination):
    destination = Path(destination).expanduser().resolve()
    if destination.exists():
        raise LocalError('恢复目录必须是尚不存在的新目录；已有资料不覆盖。', 409)
    with tempfile.TemporaryDirectory(prefix='esg-restore-') as folder, zipfile.ZipFile(backup) as archive:
        if archive.testzip(): raise LocalError('备份CRC校验失败。')
        names = archive.namelist()
        if len(names) != len(set(names)): raise LocalError('备份存在重复路径。')
        manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('schema') != 1: raise LocalError('备份版本不支持。')
        expected = {'manifest.json', 'workbench.sqlite3'} | {'originals/' + item['sha256'] for item in manifest['originals']}
        if set(names) != expected or any('..' in Path(name).parts or name.startswith('/') for name in names):
            raise LocalError('备份文件清单无效。')
        raw = archive.read('workbench.sqlite3')
        if hashlib.sha256(raw).hexdigest() != manifest['databaseSha256']: raise LocalError('资料库指纹不符。')
        staged = Path(folder)
        (staged / 'workbench.sqlite3').write_bytes(raw)
        (staged / 'originals').mkdir()
        for item in manifest['originals']:
            sha = item['sha256']
            if len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha): raise LocalError('原件指纹格式无效。')
            raw = archive.read('originals/' + sha)
            if len(raw) != item['bytes'] or hashlib.sha256(raw).hexdigest() != sha: raise LocalError('原件指纹不符。')
            (staged / 'originals' / sha).write_bytes(raw)
        with sqlite3.connect(staged / 'workbench.sqlite3') as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise LocalError('资料库完整性校验失败。')
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(staged, destination)
    destination.chmod(0o700)
    for path in destination.rglob('*'):
        path.chmod(0o700 if path.is_dir() else 0o600)
    return Store(destination)


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='action', required=True)
    save = commands.add_parser('create'); save.add_argument('output'); save.add_argument('--data-dir', required=True)
    restore = commands.add_parser('restore'); restore.add_argument('backup'); restore.add_argument('--target', required=True)
    args = parser.parse_args()
    if args.action == 'create': create_backup(Store(args.data_dir), args.output)
    else: restore_backup(args.backup, args.target)
    print('备份校验完成。原资料保留。')


if __name__ == '__main__': main()
