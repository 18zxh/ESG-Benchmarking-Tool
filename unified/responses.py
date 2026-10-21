"""Translate native workbench chat contracts to the CPA Responses wire format."""
from .core import LocalError

EFFORTS = ('none', 'low', 'medium', 'high', 'xhigh', 'max')


def request_payload(provider, payload):
    messages = []
    for message in payload.get('messages', []):
        role = message.get('role')
        if role not in {'system', 'developer', 'user', 'assistant'}:
            raise LocalError('CPA请求包含不支持的消息角色。')
        content = message.get('content')
        if isinstance(content, str):
            content = [{'type': 'text', 'text': content}]
        if not isinstance(content, list): raise LocalError('CPA请求内容无效。')
        parts = []
        for part in content:
            kind = part.get('type')
            if kind == 'text':
                parts.append({'type': 'output_text' if role == 'assistant' else 'input_text', 'text': part['text']})
            elif kind == 'file':
                file = part.get('file', {})
                item = {'type': 'input_file'}
                if file.get('file_data'):
                    item.update(filename=file.get('filename', 'pages.pdf'), file_data=file['file_data'])
                elif file.get('file_id'): item['file_id'] = file['file_id']
                else: raise LocalError('CPA请求缺少PDF原件。')
                parts.append(item)
            elif kind == 'image_url':
                image = part['image_url']
                parts.append({'type': 'input_image', 'image_url': image.get('url') if isinstance(image, dict) else image,
                              'detail': image.get('detail', 'auto') if isinstance(image, dict) else 'auto'})
            else: raise LocalError('CPA请求内容类型不支持，已停止，未丢弃内容。')
        messages.append({'role': role, 'content': parts})
    result = {'model': provider['model'], 'input': messages, 'stream': False, 'store': False,
              'reasoning': {'effort': provider['reasoningEffort']}}
    maximum = payload.get('max_tokens', payload.get('max_completion_tokens'))
    if maximum is not None: result['max_output_tokens'] = maximum
    format_ = payload.get('response_format', {})
    if format_.get('type') == 'json_object': result['text'] = {'format': {'type': 'json_object'}}
    elif format_.get('type') == 'json_schema':
        result['text'] = {'format': {'type': 'json_schema', **format_.get('json_schema', {})}}
    return result


def chat_response(response):
    """Only explicit final output can become the legacy contract's content."""
    if not isinstance(response, dict): raise LocalError('CPA响应不是JSON对象。', 502)
    status = response.get('status')
    finish = 'stop'
    if status == 'incomplete':
        if response.get('incomplete_details', {}).get('reason') == 'max_output_tokens': finish = 'length'
        else: raise LocalError('CPA响应未完成，请重试失败项。', 502)
    elif status != 'completed':
        raise LocalError('CPA响应未成功完成，请检查服务和账号额度。', 502)
    texts = []
    for item in response.get('output', []):
        if item.get('type') != 'message': continue
        for part in item.get('content', []):
            if part.get('type') == 'refusal': raise LocalError('CPA模型拒绝了本次请求，未生成评估结论。', 502)
            if part.get('type') == 'output_text' and isinstance(part.get('text'), str): texts.append(part['text'])
    if not texts and finish == 'stop': raise LocalError('CPA没有返回最终结果，未将推理内容作为评估。', 502)
    mapped = response_usage(response.get('usage'))
    return {'id': response.get('id'), 'model': response.get('model'),
            'choices': [{'finish_reason': finish, 'message': {'role': 'assistant', 'content': ''.join(texts)}}], 'usage': mapped}


def response_usage(usage):
    mapped = {}
    if isinstance(usage, dict):
        for source, target in (('input_tokens', 'prompt_tokens'), ('output_tokens', 'completion_tokens'), ('total_tokens', 'total_tokens')):
            if type(usage.get(source)) is int and usage[source] >= 0: mapped[target] = usage[source]
        for source, target, keys in (('input_tokens_details', 'prompt_tokens_details', ('cached_tokens',)),
                                     ('output_tokens_details', 'completion_tokens_details', ('reasoning_tokens',))):
            details = usage.get(source)
            if isinstance(details, dict):
                mapped[target] = {k:details[k] for k in keys if type(details.get(k)) is int and details[k] >= 0}
    return mapped
