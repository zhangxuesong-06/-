import json
import os
import re
import urllib.request
import urllib.error

text = open(os.path.expanduser('~/.dsh/.credentials.yaml'), encoding='utf-8', errors='ignore').read()
key = re.search(r'DSH_API_KEY:\s*["\']?([^\s"\']+)', text).group(1)


def post(payload, timeout=90):
    req = urllib.request.Request(
        'https://sekirocloud.shop/v1/chat/completions',
        data=json.dumps(payload).encode(),
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'DeepSeek-Harness/0.2.1'},
        method='POST',
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 绕过系统代理
    try:
        r = opener.open(req, timeout=timeout)
        return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 'ERR', str(e)[:200].encode()


print('=== 1) 非流式 ===')
st, body = post({
    'model': 'deepseek-v4-pro',
    'messages': [{'role': 'user', 'content': '只回复四个字：代理成功'}],
    'max_tokens': 32,
})
print('status', st)
try:
    j = json.loads(body)
    msg = j['choices'][0]['message']
    print('content:', repr(msg.get('content'))[:200])
    print('usage:', j.get('usage'))
except Exception:
    print('body:', body[:400])

print('\n=== 2) 流式帧统计 ===')
req = urllib.request.Request(
    'https://sekirocloud.shop/v1/chat/completions',
    data=json.dumps({
        'model': 'deepseek-v4-pro',
        'messages': [{'role': 'user', 'content': '数到五'}],
        'stream': True,
        'max_tokens': 48,
    }).encode(),
    headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'DeepSeek-Harness/0.2.1'},
    method='POST',
)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    r = opener.open(req, timeout=90)
    raw = r.read().decode('utf-8', 'ignore')
    frames = [x for x in raw.split('\n\n') if x.strip()]
    print('status', r.status, '帧数', len(frames), '含 DONE', '[DONE]' in raw)
    print('前两帧:', frames[0][:120] if frames else '-')
except urllib.error.HTTPError as e:
    print('HTTP', e.code, e.read()[:200])
except Exception as e:
    print('ERR', str(e)[:200])
