import sys
import json
import traceback
import time
from urllib.parse import urlparse
try:
    from curl_cffi import requests
except ImportError:
    pass

sessions = {}

def get_session(impersonate, proxy=None):
    key = f"{impersonate}_{proxy}"
    if key not in sessions:
        proxies = {"http": proxy, "https": proxy} if proxy else None
        sessions[key] = requests.Session(impersonate=impersonate, proxies=proxies)
    return sessions[key]

def process_line(line):
    try:
        args = json.loads(line)
        url = args.get("url")
        method = args.get("method", "GET")
        headers = args.get("headers", {})
        impersonate = args.get("impersonate", "chrome120")
        proxy = args.get("proxy")
        data = args.get("data")
        timeout = args.get("timeout", 15000) / 1000.0
        
        session = get_session(impersonate, proxy)
        
        # Inject cookies if passed
        req_cookies = args.get("cookies", [])
        for c in req_cookies:
            session.cookies.set(c["name"], c["value"], domain=c.get("domain", urlparse(url).hostname))

        resp = session.request(method, url, headers=headers, data=data, timeout=timeout)
        
        challengeDetected = False
        text = resp.text
        if resp.status_code in (403, 503) and ("cloudflare" in text.lower() or "just a moment" in text.lower()):
            challengeDetected = True
            
        out_cookies = []
        for c in session.cookies.jar:
            out_cookies.append({
                "name": c.name,
                "value": c.value,
                "domain": c.domain,
                "path": c.path
            })

        reqId = args.get("reqId")
        sys.stdout.write(json.dumps({
            "reqId": reqId,
            "status": "ok",
            "code": resp.status_code,
            "html": text,
            "cookies": out_cookies,
            "headers": dict(resp.headers),
            "challengeDetected": challengeDetected
        }) + "\n")
    except Exception as e:
        reqId = None
        try: reqId = json.loads(line).get("reqId")
        except: pass
        sys.stdout.write(json.dumps({"reqId": reqId, "status": "error", "message": str(e)}) + "\n")
    
    sys.stdout.flush()

if __name__ == "__main__":
    for line in sys.stdin:
        if not line.strip(): continue
        process_line(line)
