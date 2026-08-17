import json,subprocess,os,time
env=dict(os.environ, COMFY_HOST='http://127.0.0.1:8188', AUDIO_AUTOSTART='1', AUDIO_GEN_TIMEOUT='1800')
py=os.path.expanduser('~/.config/comfy-audio/venv/bin/python')
p=subprocess.Popen([py if os.path.exists(py) else '/usr/bin/python3', os.path.expanduser('~/.config/comfy-audio/server.py')],
                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
def send(o): p.stdin.write(json.dumps(o)+'\n'); p.stdin.flush()
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}})
p.stdout.readline(); send({"jsonrpc":"2.0","method":"notifications/initialized"})
t0=time.time()
send({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_music","arguments":{
  "tags":"warm indie folk, acoustic guitar, brushed drums, male vocals, intimate room reverb",
  "lyrics":"[verse]\nThe harness hums on the desk tonight\n[chorus]\nEverything local, everything mine",
  "seconds":30,"bpm":92,"key":"G major","seed":424242}}})
line=p.stdout.readline()
r=json.loads(line); res=r.get('result',{})
print(f"elapsed {time.time()-t0:.0f}s  isError={res.get('isError')}")
for blk in res.get('content',[])[:2]:
    print(str(blk.get('text',blk))[:300])
p.kill()
