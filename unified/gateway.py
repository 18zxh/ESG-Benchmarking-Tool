"""Memory-only GLM/CPA connections and bounded shared model transport."""
import json
import ssl
import threading
import uuid
import os
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, HTTPSHandler, ProxyHandler

from .core import ACTIVE, LocalError, fingerprint
from .responses import EFFORTS, request_payload, chat_response, response_usage
from .chat_stream import read_response


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Gateway:
    def __init__(self, store, *, allow_local=False, sender=None):
        self.store, self.allow_local, self.sender = store, allow_local, sender
        self.current = None
        self.profiles = {}
        self.cpa_key_file = Path(os.environ.get("ESG_CPA_KEY_FILE", str(Path.home() / "Documents/Codex/local-services/cliproxyapi/client-key")))
        self.lock = threading.RLock()
        self.glm_lock = threading.Semaphore(1)
        self.quota_blocked = {}
        self.request_ready = None
        self.listeners = []

    def configuration(self):
        return {'cpaLocalKeyAvailable': self.cpa_key_file.is_file(), 'cpaBaseUrl': 'http://127.0.0.1:8317/v1',
                'cpaModel': 'gpt-6-luna', 'cpaReasoningEffort': 'medium', 'cpaReadingEffort': 'low'}

    def connect(self, data):
        if not isinstance(data, dict): raise LocalError('连接配置须为对象。')
        service = data.get('service', 'glm')
        if service not in {'glm', 'cpa'}: raise LocalError('请选择GLM或CPA服务。')
        cpa = service == 'cpa'
        model = str(data.get('model', 'gpt-6-luna' if cpa else 'glm-5.3-flash')).strip().lower()
        base = str(data.get('baseUrl', 'http://127.0.0.1:8317/v1' if cpa else 'https://open.bigmodel.cn/api/paas/v4')).strip().rstrip('/')
        for suffix in ('/chat/completions', '/responses'):
            if base.endswith(suffix): base = base[:-len(suffix)]
        try:
            url = urlsplit(base); port = url.port
        except ValueError: raise LocalError('接口地址或端口无效。') from None
        local = url.hostname in {'127.0.0.1', 'localhost', '::1'}
        if url.username or url.password or url.query or url.fragment or port == 0:
            raise LocalError('接口地址不能包含凭据、查询参数或无效端口。')
        if cpa:
            if not local or url.scheme not in {'http', 'https'}: raise LocalError('CPA请使用本机回环地址。')
            if model != 'gpt-6-luna': raise LocalError('当前CPA连接使用gpt-6-luna。')
        else:
            allowed_local = self.allow_local and local and url.scheme in {'http','https'}
            if not allowed_local and (url.scheme != 'https' or url.hostname not in {'open.bigmodel.cn','api.z.ai'}):
                raise LocalError('请使用GLM官方HTTPS接口。')
            if model not in {'glm-5.3-flash','glm-5.3-flashx'}: raise LocalError('请选择GLM Flash或FlashX。')
        effort = data.get('reasoningEffort', 'medium') if cpa else None
        reading_effort = data.get('readingEffort', 'low') if cpa else None
        if cpa and (effort not in EFFORTS or reading_effort not in EFFORTS): raise LocalError('CPA推理强度无效。')
        key = str(data.get('apiKey', '')).strip()
        if cpa and not key and data.get('useLocalKey') is True:
            try: key = self.cpa_key_file.read_text().strip()
            except (OSError, UnicodeError): raise LocalError('未找到可读取的本机CPA应用密钥，请手动填写。') from None
        with self.lock:
            previous = self.profiles.get(service)
            if not key and previous and previous['baseUrl'] == base and previous['model'] == model:
                key = previous['apiKey']
            if (not key and (cpa or not (self.allow_local and local))) or len(key) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in key):
                raise LocalError('连接密钥为空或格式无效。')
            self.store.secrets.remember(key)
            self.current = {'id': uuid.uuid4().hex, 'name': 'CPA' if cpa else 'GLM', 'service': service,
                            'baseUrl': base, 'model': model, 'apiKey': key, 'endpoint': base + ('/responses' if cpa else '/chat/completions'),
                            'mode': 'native', 'protocol': 'responses' if cpa else 'chat', 'reasoningEffort': effort, 'readingEffort': reading_effort,
                            'fingerprint': fingerprint([base, model, 'native', service, effort, reading_effort, 'responses-v2'] if cpa else [base, model, 'native', service, effort, 'chat'])}
            self.profiles[service] = dict(self.current)
            self.quota_blocked.pop(self.current['id'], None)
            for listener in self.listeners: listener(dict(self.current))
        return self.public()

    def public(self):
        with self.lock:
            provider = ({k:v for k,v in self.current.items() if k != 'apiKey'} if self.current else None)
            profiles = [{k:v for k,v in p.items() if k != 'apiKey'} for p in self.profiles.values()]
        return {'providers': [provider] if provider else [], 'currentProviderId': provider['id'] if provider else None,
                'connections': profiles, 'modelConfig': self.configuration()}

    def get(self, provider_id=None):
        with self.lock:
            if not self.current or (provider_id and provider_id != self.current['id']):
                raise LocalError('请先在设置中连接GLM或CPA；服务重启后需重新连接。', 409)
            return dict(self.current)

    def check(self):
        provider = self.get()
        response = self.send(provider, {'model': provider['model'], 'messages': [{'role':'user','content':'只输出JSON对象：{"ok":true}'}],
                            'stream':False,'max_tokens':2048,'response_format':{'type':'json_object'}})
        try:
            if json.loads(response['choices'][0]['message']['content']).get('ok') is not True: raise ValueError()
            if response['choices'][0]['finish_reason'] != 'stop': raise ValueError()
        except (ValueError,KeyError,IndexError,TypeError,AttributeError): raise LocalError('模型测试未返回完整确认，请检查连接后重试。',502) from None
        return {'ok':True,'model':provider['model'],'service':provider['service']}

    def send(self, provider, payload, *, namespace=None):
        if provider.get('service') != 'cpa':
            # Shared across standards in the production process: a personal
            # GLM connection must not fan out three simultaneous PDF requests.
            while True:
                with self.glm_lock:
                    ready = not self.request_ready or self.request_ready(ACTIVE.get())
                    if ready:
                        profile = provider.get('id') or provider.get('fingerprint')
                        if profile in self.quota_blocked:
                            raise LocalError(self.quota_blocked[profile], 502)
                        return self._send(provider, payload, namespace=namespace)
                # Paused jobs release the gate so another module may proceed.
                time.sleep(.1)
        return self._send(provider, payload, namespace=namespace)

    def _send(self, provider, payload, *, namespace=None):
        run = ACTIVE.get()
        namespace = namespace or (run.namespace if run else 'exchange')
        content = payload.get('messages', [{}])[-1].get('content')
        phase = 'reading' if isinstance(content, list) and any(x.get('type') == 'file' for x in content if isinstance(x, dict)) else 'assessment'
        scope, job_id = (run.scope, run.job_id) if run else ('manual', 'manual')
        response = None
        usage_response = None
        cpa = provider.get("service") == "cpa"
        failed = False
        try:
            effective = {**provider, 'reasoningEffort': provider.get('readingEffort', 'low')} if cpa and phase == 'reading' else provider
            # Legacy CSA hard-coded max while the other GLM readers used low.
            # Enforce the shared GLM policy without changing the method content.
            wire = request_payload(effective, payload) if cpa else {**payload, 'reasoning_effort': 'low'}
            if self.sender:
                response = self.sender(provider, wire)
            else:
                import certifi
                if not cpa:
                    wire = {**wire, 'stream': True, 'stream_options': {'include_usage': True}}
                context = ssl.create_default_context(cafile=certifi.where())
                request = Request(provider.get('endpoint') or provider['baseUrl'].rstrip('/') + '/chat/completions',
                                  data=json.dumps(wire, ensure_ascii=False).encode(), method='POST',
                                  headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.get('apiKey', '')})
                handlers = [NoRedirect(), HTTPSHandler(context=context)]
                if cpa: handlers.append(ProxyHandler({}))
                with build_opener(*handlers).open(request, timeout=240) as upstream:
                    try:
                        response = read_response(upstream)
                    except Exception as exc:
                        usage_response = getattr(exc, 'reported_usage', None)
                        raise
            if not isinstance(response, dict):
                raise LocalError('模型响应不是JSON对象。', 502)
            if cpa:
                usage_response = {"usage": response_usage(response.get("usage"))}
                response = chat_response(response)
            actual = response.get('model')
            if actual and actual != provider['model']:
                raise LocalError('上游返回的模型与当前连接不同。', 502)
            return response
        except HTTPError as exc:
            failed = True
            if exc.code in {408, 504}:
                raise LocalError(f'{provider.get("name","模型")}请求超时（HTTP {exc.code}）。已完成结果保留，可重试未完成部分；该请求的用量无法确认。', 502) from None
            if exc.code == 429:
                try:
                    detail = json.loads(exc.read(8192)).get('error', {})
                    code = str(detail.get('code', '429'))[:32]
                    message = self.store.secrets.clean(str(detail.get('message', '请求过于频繁或额度不足。')))[:240]
                except (ValueError, TypeError, AttributeError):
                    code, message = '429', '请求过于频繁或额度不足。'
                error = f'{provider.get("name","模型")}请求受限（HTTP 429，代码{code}）：{message}'
                if code == '1113':
                    error += ' 已停止本连接的后续请求；补足额度后请在设置重新连接，再重试未完成部分。'
                    self.quota_blocked[provider.get('id') or provider.get('fingerprint')] = error
                raise LocalError(error, 502) from None
            if exc.code == 400:
                # Keep the provider's bounded, redacted diagnostic. A generic
                # "check key" message hides context limits and unsupported fields.
                try:
                    detail = json.loads(exc.read(8192)).get('error', {})
                    code = str(detail.get('code', '400'))[:32]
                    message = self.store.secrets.clean(str(detail.get('message', '请求参数无效。')))[:240]
                except (ValueError, TypeError, AttributeError):
                    code, message = '400', '请求参数无效。'
                raise LocalError(f'{provider.get("name","模型")}请求被拒绝（HTTP 400，代码{code}）：{message}', 502) from None
            raise LocalError(f'{provider.get("name","模型")}服务返回HTTP {exc.code}，请检查凭据、额度或权限。', 502) from None
        except (URLError, TimeoutError, OSError):
            failed = True
            raise LocalError('模型连接中断或超时；请检查所选服务，未返回的用量无法确认。', 502) from None
        except LocalError:
            failed = True
            raise
        except (ValueError, TypeError):
            failed = True
            raise LocalError('模型服务未返回完整有效的JSON。', 502) from None
        except Exception:
            failed = True
            raise
        finally:
            self.store.record_usage(namespace, scope, job_id, phase, response=usage_response if usage_response is not None else response, error=failed,
                                    model=provider.get('model', ''), host=urlsplit(provider.get('baseUrl', '')).hostname or '')
