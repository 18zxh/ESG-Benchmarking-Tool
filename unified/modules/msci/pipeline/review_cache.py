"""Small local cache of validated PDF readings; credentials are never stored."""
import json, os, tempfile
from pathlib import Path

CACHE_DIR = Path.home() / 'Library' / 'Caches' / 'MSCIWorkbench' / 'pdf-review'
MAX_ENTRIES = 120

def _load(key, folder, field):
    try:
        value = json.loads((folder / (key + '.json')).read_text(encoding='utf-8'))
        return value[field] if value.get('key') == key else None
    except (OSError, ValueError, KeyError, TypeError):
        return None

def _save(key, value, folder, field, limit):
    try:
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=folder, delete=False) as f:
            os.chmod(f.name, 0o600)
            json.dump({'key':key, field:value}, f, ensure_ascii=False)
            temporary = f.name
        os.replace(temporary, folder / (key + '.json'))
        entries = sorted(folder.glob('*.json'), key=lambda p:p.stat().st_mtime)
        for entry in entries[:-limit]: entry.unlink(missing_ok=True)
    except OSError:
        # Read/assessment still work when a cache directory is unavailable.
        if 'temporary' in locals(): Path(temporary).unlink(missing_ok=True)

def load(key):return _load(key,CACHE_DIR,'evidence')
def save(key,evidence):_save(key,evidence,CACHE_DIR,'evidence',MAX_ENTRIES)
def load_results(key):return _load(key,CACHE_DIR/'assessments','results')
def save_results(key,results):_save(key,results,CACHE_DIR/'assessments','results',150)
