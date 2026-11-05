# -*- coding: utf-8 -*-
"""删除 index.ts 中属于已裁撤模块的路由块 + 相关 import。"""
import io, re

p = 'src/index.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')

DELETE_PREFIXES = (
    '/mailbox', '/donations', '/wb2api', '/qoder2api', '/profile', '/storage',
    '/dev', '/admin/storage', '/admin/mailboxes', '/admin/newapi', '/admin/donations',
    '/admin/wb2api', '/admin/qoder2api', '/admin/sensenova', '/admin/channels',
    '/admin/r2', '/admin/points/backfill-donations', '/collection', '/admin/collection',
    '/v1/mailbox', '/v1/temp-mailbox', '/newapi-test', '/admin/newapi-test',
)

def path_of(seg: str):
    m = re.search(r'path: "([^"]+)"', seg)
    if m:
        return m.group(1)
    m = re.search(r'match: \(routePath: string\) => routePath\.match\(/(.+)/\)', seg)
    if m:
        raw = m.group(1)
        pm = re.match(r'\^\\\/([a-zA-Z0-9_-]+)', raw)
        if pm:
            return '/' + pm.group(1)
    return None

def is_deleted(path: str) -> bool:
    if path is None:
        return False
    if path in DELETE_PREFIXES:
        return True
    for pre in DELETE_PREFIXES:
        if path.startswith(pre + '/'):
            return True
    return False

# 路由块边界：'  {' 起，括号配平止
blocks = []
i = 0
while i < len(lines):
    if lines[i] == '  {':
        j = i
        depth = 0
        while j < len(lines):
            depth += lines[j].count('{') - lines[j].count('}')
            if depth == 0 and j > i:
                break
            j += 1
        blocks.append((i, j))
        i = j + 1
    else:
        i += 1

to_delete = []
for (a, b) in blocks:
    seg = '\n'.join(lines[a:b + 1])
    path = path_of(seg)
    if is_deleted(path):
        to_delete.append((a, b, path))

# 从后往前删，连同前置注释行与后随空行
for (a, b, path) in sorted(to_delete, key=lambda x: -x[0]):
    e = b
    while e + 1 < len(lines) and lines[e + 1].strip() == '':
        e += 1
    s2 = a
    while s2 > 0 and lines[s2 - 1].strip().startswith('//'):
        s2 -= 1
    del lines[s2:e + 1]

print('deleted route blocks:', len(to_delete))

s = '\n'.join(lines)

# 删除对应 import
IMPORT_NAMES = [
    'emailHandlers', 'tempboxHandlers', 'adminMailboxHandlers', 'storageHandlers',
    'newapiHandlers', 'adminChannelHandlers', 'donationHandlers', 'wb2apiHandlers',
    'qoder2apiHandlers', 'profileHandlers', 'proxyHandlers', 'r2AdminHandlers',
    'collectionHandlers', 'collectionAdminHandlers',
]
for name in IMPORT_NAMES:
    s = re.sub(r'import \* as ' + name + r' from "\./handlers/[a-z-]+"\n', '', s)
# 删除已无消费者的根模块 import（game-wallet / collection-plugins / newapi-client 等按需保留）
s = re.sub(r'import \{[^}]*\} from "\./game-wallet"\n', '', s)
s = re.sub(r'import \{[^}]*\} from "\./collection-plugins"\n', '', s)
s = re.sub(r'import \{ incomingEmail \} from "\./email-delivery"\n', '', s)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('imports cleaned')
