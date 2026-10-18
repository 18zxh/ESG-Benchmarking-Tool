"""One memory-only GLM connection and one bounded transport for all adapters."""
import json
import ssl
import threading
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, HTTPSHandler

from .core import ACTIVE, LocalError, fingerprint


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Gateway:
    def __init__(self, store, *, allow_local=False, sender=None):
        self.store, self.allow_local, self.sender = store, allow_local, sender
        self.current = None
        self.lock = threading.RLock()
        self.listeners = []

    def connect(self, data):
        model = str(data.get('model', 'glm-5.3-flash')).strip().lower()
        base = str(data.get('baseUrl', 'https://open.bigmodel.cn/api/paas/v4')).strip().rstrip('/')
        if base.endswith('/chat/completions'):
            base = base[:-len('/chat/completions')]
        url = urlsplit(base)
        local = self.allow_local and url.hostname in {'127.0.0.1', 'localhost', '::1'}
        if (url.username or url.password or url.query or url.fragment or
                (not local and (url.scheme != 'https' or url.hostname not in {'open.bigmodel.cn', 'api.z.ai'})) or
                (local and url.scheme not in {'http', 'https'})):
            raise LocalError('请使用GLM官方HTTPS接口。')
        try:
            url.port
        except ValueError:
            raise LocalError('接口端口无效。') from None
        if model not in {'glm-5.3-flash', 'glm-5.3-flashx'}:
            raise LocalError('当前融合版保留已支持的GLM Flash/FlashX型号。')
        key = str(data.get('apiKey', '')).strip()
        with self.lock:
            if not key and self.current and self.current['baseUrl'] == base and self.current['model'] == model:
                key = self.current['apiKey']
            if (not key and not local) or len(key) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in key):
                raise LocalError('连接密钥为空或格式无效。')
            self.store.secrets.remember(key)
            self.current = {'id': uuid.uuid4().hex, 'name': 'GLM', 'baseUrl': base, 'model': model,
                            'apiKey': key, 'endpoint': base + '/chat/completions', 'mode': 'native',
                            'fingerprint': fingerprint([base, model, 'native'])}
            for listener in self.listeners:
                listener(dict(self.current))
        return self.public()

    def public(self):
        with self.lock:
            provider = ({k: v for k, v in self.current.items() if k != 'apiKey'} if self.current else None)
        return {'providers': [provider] if provider else [], 'currentProviderId': provider['id'] if provider else None}

    def get(self, provider_id=None):
        with self.lock:
            if not self.current or (provider_id and provider_id != self.current['id']):
                raise LocalError('请先连接共享GLM服务；服务重启后需重新连接。', 409)
            return dict(self.current)

    def send(self, provider, payload, *, namespace=None):
        run = ACTIVE.get()
        namespace = namespace or (run.namespace if run else 'exchange')
        content = payload.get('messages', [{}])[-1].get('content')
        phase = 'reading' if isinstance(content, list) and any(x.get('type') == 'file' for x in content if isinstance(x, dict)) else 'assessment'
        scope, job_id = (run.scope, run.job_id) if run else ('manual', 'manual')
        response = None
        failed = False
        try:
            if self.sender:
                response = self.sender(provider, payload)
            else:
                import certifi
                context = ssl.create_default_context(cafile=certifi.where())
                request = Request(provider.get('endpoint') or provider['baseUrl'].rstrip('/') + '/chat/completions',
                                  data=json.dumps(payload, ensure_ascii=False).encode(), method='POST',
                                  headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.get('apiKey', '')})
                with build_opener(NoRedirect(), HTTPSHandler(context=context)).open(request, timeout=240) as upstream:
                    raw = upstream.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise LocalError('模型响应超过大小限制。', 502)
                response = json.loads(raw)
            if not isinstance(response, dict):
                raise LocalError('模型响应不是JSON对象。', 502)
            actual = response.get('model')
            if actual and actual != provider['model']:
                raise LocalError('上游返回的模型与当前连接不同。', 502)
            return response
        except HTTPError as exc:
            failed = True
            raise LocalError(f'GLM服务返回HTTP {exc.code}，请检查凭据、额度或权限。', 502) from None
        except (URLError, TimeoutError, OSError):
            failed = True
            raise LocalError('GLM连接中断或超时；未返回的用量无法确认。', 502) from None
        except (ValueError, TypeError):
            failed = True
            raise LocalError('GLM未返回完整有效的JSON。', 502) from None
        except Exception:
            failed = True
            raise
        finally:
            self.store.record_usage(namespace, scope, job_id, phase, response=response, error=failed,
                                    model=provider.get('model', ''), host=urlsplit(provider.get('baseUrl', '')).hostname or '')
