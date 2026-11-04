import itertools
import json
import os
import re
import urllib.request
import urllib.error

text = open(os.path.expanduser('~/.dsh/.credentials.yaml'), encoding='utf-8', errors='ignore').read()
key = re.search(r'DSH_API_KEY:\s*["\']?([^\s"\']+)', text).group(1)

BASE = 'https://sekirocloud.shop'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(path, payload, ua=None, stream=False):
    headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}
    if ua:
        headers['User-Agent'] = ua
    if stream:
        headers['Accept'] = 'text/event-stream'
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(), headers=headers, method='POST')
    try:
        r = opener.open(req, timeout=60)
        body = r.read(600)
        return r.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read(300)
    except Exception as e:
        return 'ERR', str(e)[:160].encode()


cases = [
    ('/v1/chat/completions', 'deepseek-v4-pro', None),
    ('/v1/chat/completions', 'deepseek-v4-pro', 'DeepSeek-Harness/0.2.1'),
    ('/v1/chat/completions', 'minimax-m3', None),
    ('/v1/chat/completions', 'deepseek-v4-flash', None),
    ('/v1/completions', 'deepseek-v4-pro', None),
]

for path, model, ua in cases:
    payload = {'model': model, 'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 8}
    st, body = call(path, payload, ua)
    txt = body.decode('utf-8', 'ignore').replace('\n', ' ')[:180]
    print(f'{path:24} {model:20} ua={str(ua)[:12]:14} -> {st} {txt}')

print('\n--- 查 /v1/models 全量 id（判断可用模型名）---')
req = urllib.request.Request(BASE + '/v1/models', headers={'Authorization': 'Bearer ' + key})
r = opener.open(req, timeout=25)
ids = [m['id'] for m in json.loads(r.read()).get('data', [])]
print('模型数', len(ids), '前 12:', ids[:12])
