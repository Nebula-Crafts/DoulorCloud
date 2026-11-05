# -*- coding: utf-8 -*-
"""第二轮：按 handler 名删除剩余路由块（正则路由 path 提取失败的）。"""
import io, re

p = 'src/index.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')

DEAD = (
    'donationHandlers', 'adminMailboxHandlers', 'proxyHandlers', 'emailHandlers',
    'tempboxHandlers', 'storageHandlers', 'newapiHandlers', 'adminChannelHandlers',
    'profileHandlers', 'wb2apiHandlers', 'qoder2apiHandlers', 'r2AdminHandlers',
    'collectionHandlers', 'collectionAdminHandlers',
)

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
    if any(name + 'Handlers.' in seg or name + 'Handlers\n' in seg for name in DEAD):
        to_delete.append((a, b))

for (a, b) in sorted(to_delete, key=lambda x: -x[0]):
    e = b
    while e + 1 < len(lines) and lines[e + 1].strip() == '':
        e += 1
    s2 = a
    while s2 > 0 and lines[s2 - 1].strip().startswith('//'):
        s2 -= 1
    del lines[s2:e + 1]

print('deleted by handler name:', len(to_delete))

s = '\n'.join(lines)

# 清理孤儿 import（dead handlers 已删）
for name in DEAD:
    s = re.sub(r'import \* as ' + name + r' from "\./handlers/[a-z-]+"\n', '', s)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('done')
