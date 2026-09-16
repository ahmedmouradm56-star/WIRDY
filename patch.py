#!/usr/bin/env python3
"""Strip the CDN html2canvas tag and inline the offline renderer + bridge."""
import re, sys, pathlib

src = pathlib.Path('/mnt/user-data/uploads/study-timetable-v9.html').read_text(encoding='utf-8')
js  = pathlib.Path('/home/claude/proj/wirdy-offline.js').read_text(encoding='utf-8')

# 1. remove every remote <script src="http...">  (offline app: nothing may block startup)
removed = re.findall(r'<script[^>]+src="https?://[^"]+"[^>]*>\s*</script>', src)
src = re.sub(r'<script[^>]+src="https?://[^"]+"[^>]*>\s*</script>', '', src)

# 2. inject ours in the same position (inside <head>, before the app script)
payload = '<script>\n' + js + '\n</script>'
if '</head>' in src:
    src = src.replace('</head>', payload + '\n</head>', 1)
else:
    src = src.replace('<body', payload + '\n<body', 1)

# 3. offline viewport safety: no external font/CSS fetch should stall first paint
src = re.sub(r'<link[^>]+href="https?://[^"]+"[^>]*>', '', src)

out = pathlib.Path('/home/claude/proj/app/src/main/assets/index.html')
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(src, encoding='utf-8')

print("removed remote scripts :", len(removed))
for r in removed:
    print("   -", r[:90])
print("html2canvas shim present:", 'window.html2canvas = function' in src)
print("bridge polyfill present :", 'navigator.share = async function' in src)
print("output bytes            :", out.stat().st_size)
