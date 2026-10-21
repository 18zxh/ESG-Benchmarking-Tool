"""Bounded GLM SSE assembly; reasoning is never mistaken for final content."""
import json
import time

from .core import LocalError


def read_response(upstream, *, limit=2 * 1024 * 1024, duration=300):
    if 'text/event-stream' not in upstream.headers.get('Content-Type', '').lower():
        raw = upstream.read(limit + 1)
        if len(raw) > limit:
            raise LocalError('模型响应超过大小限制。', 502)
        return json.loads(raw)
    began, size, parts, finish, model, usage = time.monotonic(), 0, [], None, None, None
    try:
        while True:
            line = upstream.readline(65537)
            if not line:
                break
            size += len(line)
            if size > limit or len(line) > 65536:
                raise LocalError('模型流式响应超过大小限制。', 502)
            if time.monotonic() - began > duration:
                raise LocalError('模型流式响应超过等待上限；已完成页段保留。', 502)
            if not line.startswith(b'data:'):
                continue
            data = line[5:].strip()
            if data == b'[DONE]':
                break
            value = json.loads(data)
            if value.get('error'):
                raise LocalError('模型流式响应报告服务错误；未接受未完成结果。', 502)
            if value.get('model'):
                model = value['model']
            if isinstance(value.get('usage'), dict):
                usage = value['usage']
            for choice in value.get('choices', []):
                if choice.get('index', 0) != 0:
                    continue
                text = choice.get('delta', {}).get('content')
                if text is not None:
                    if not isinstance(text, str):
                        raise ValueError()
                    parts.append(text)
                if choice.get('finish_reason'):
                    finish = choice['finish_reason']
        if finish is None:
            raise LocalError('模型流式响应中断，未收到完成标记；未接受未完成结果。', 502)
        result = {'choices': [{'finish_reason': finish, 'message': {'content': ''.join(parts)}}]}
        if model:
            result['model'] = model
        if usage is not None:
            result['usage'] = usage
        return result
    except Exception as exc:
        if usage is not None:
            exc.reported_usage = {'usage': usage}
        raise
