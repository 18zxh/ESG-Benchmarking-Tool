"""Disposable private cache. Credentials and comments never enter this layer."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
from pipeline.model_proxy import PROVIDERS


def cache_key(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class ReviewCache:
    def __init__(self, root=None):
        self.root = Path(root) if root else Path.home() / "Library/Caches/ExchangeSustainabilityWorkbench"
        self.lock = threading.RLock()

    def path(self, kind, key):
        if kind not in ("read", "align", "assessment", "assessment-window", "benchmark") or len(key) != 64 or any(c not in "0123456789abcdef" for c in key):
            raise ValueError("invalid cache identity")
        return self.root / kind / (key + ".json")

    def get(self, kind, key):
        try:
            with self.lock:
                return json.loads(self.path(kind, key).read_text("utf-8"))
        except (OSError, ValueError):
            return None

    def put(self, kind, key, value):
        path = self.path(kind, key)
        temp = None
        try:
            with self.lock:
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                self.root.chmod(0o700)
                path.parent.chmod(0o700)
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as f:
                    temp = f.name
                    json.dump(PROVIDERS.redact(value), f, ensure_ascii=False)
                    f.flush()
                    os.fsync(f.fileno())
                os.chmod(temp, 0o600)
                os.replace(temp, path)
        except OSError:
            if temp:
                try: os.unlink(temp)
                except OSError: pass
            return False
        return True


CACHE = ReviewCache()
