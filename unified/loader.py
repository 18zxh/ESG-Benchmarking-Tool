"""Load unchanged upstream files under separate Python package namespaces."""
import importlib
import importlib.abc
import importlib.util
from importlib.machinery import SourceFileLoader
from pathlib import Path
import re
import sys
import types
import uuid


class ExchangeLoader(SourceFileLoader):
    def __init__(self, name, path, prefix):
        super().__init__(name, path)
        self.prefix = prefix

    def get_code(self, fullname):
        # Do not write transformed bytecode beside an unchanged upstream source.
        source = Path(self.path).read_text()
        source = re.sub(r'(?m)^(\s*from )pipeline(?=[. ])', r'\g<1>' + self.prefix, source)
        return compile(source, self.path, 'exec')


class Finder(importlib.abc.MetaPathFinder):
    def __init__(self, prefix, root):
        self.prefix, self.root = prefix, root

    def find_spec(self, fullname, path=None, target=None):
        if not fullname.startswith(self.prefix + '.'):
            return None
        relative = fullname[len(self.prefix) + 1:].replace('.', '/')
        file = self.root / (relative + '.py')
        if file.is_file():
            return importlib.util.spec_from_loader(fullname, ExchangeLoader(fullname, str(file), self.prefix))
        return None


class Modules:
    def __init__(self):
        root = Path(__file__).resolve().parent / 'modules'
        self.prefix = 'unified._mount_' + uuid.uuid4().hex
        package = types.ModuleType(self.prefix)
        package.__path__ = [str(root)]
        sys.modules[self.prefix] = package
        self.finder = Finder(self.prefix + '.exchange.pipeline', root / 'exchange' / 'pipeline')
        sys.meta_path.insert(0, self.finder)
        self.servers = {name: importlib.import_module(self.prefix + '.' + name + '.pipeline.workbench_server')
                        for name in ('csa', 'msci', 'exchange')}

    def get(self, namespace, name):
        return importlib.import_module(self.prefix + '.' + namespace + '.pipeline.' + name)

    def close(self):
        for name in ('csa', 'msci'):
            native = self.get(name, 'native_pdf_jobs' if name == 'csa' else 'pdf_assessment')
            if name == 'csa':
                native.shutdown()
            else:
                for job in native.JOBS.values():
                    job['stop'] = True; job['pause'] = False
                native.POOL.shutdown(wait=False, cancel_futures=True)
            self.get(name, 'model_proxy').POOL.shutdown(wait=False, cancel_futures=True)
        if self.finder in sys.meta_path:
            sys.meta_path.remove(self.finder)
