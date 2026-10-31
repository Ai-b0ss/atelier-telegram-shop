import json,subprocess
root="https://atelier-customwear-demo-2026.igorekglukhovskii43.workers.dev"
p=subprocess.run(["curl.exe","--fail","--silent","--show-error","--max-time","20",root+"/health"],capture_output=True,text=True,timeout=25)
assert p.returncode==0,"HTTP_GET_FAILED"
o=json.loads(p.stdout)
assert o.get("ok") and o.get("database") and o.get("mode")=="demo",o
print("LIVE_HEALTH_OK",o)
p=subprocess.run(["curl.exe","--silent","--show-error","--max-time","20","--output","NUL","--write-out","%{http_code}","-X","POST","-H","Content-Type: application/json","--data","{}",root+"/webhook"],capture_output=True,text=True,timeout=25)
assert p.returncode==0 and p.stdout=="403",(p.returncode,p.stdout)
print("UNAUTHORIZED_WEBHOOK_BLOCKED",p.stdout)
