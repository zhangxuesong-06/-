import os
import re
import urllib.request
import urllib.error

path = os.path.expanduser('~/.dsh/.credentials.yaml')
text = open(path, encoding='utf-8', errors='ignore').read()
m = re.search(r'DSH_API_KEY:\s*["\']?([^\s"\']+)', text)
key = m.group(1) if m else ''
print('key 长度:', len(key), '前缀:', (key[:4] + '…') if key else '-')


def get(url, proxy=None):
    headers = {'Authorization': 'Bearer ' + key}
    handler = urllib.request.ProxyHandler({} if proxy is None else {'http': proxy, 'https': proxy})
    opener = urllib.request.build_opener(handler)
    try:
        r = opener.open(urllib.request.Request(url, headers=headers), timeout=25)
        return r.status, r.read()[:400]
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:400]
    except Exception as e:
        return 'ERR', str(e)[:220].encode()


for label, proxy in [('直连', None), ('系统代理', 'http://127.0.0.1:27137')]:
    st, body = get('https://sekirocloud.shop/v1/models', proxy)
    txt = body.decode('utf-8', 'ignore') if isinstance(body, bytes) else body
    print('\n[%s] status=%s' % (label, st))
    print(' body:', txt[:320])
