#!/usr/bin/env python3
"""Serve the web app locally:  python3 serve.py  ->  http://localhost:8000/
The site lives in ./web and reads ./data/lancers_profiles.csv."""
import http.server, os, sys, webbrowser
ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)
    def translate_path(self, path):
        p = path.split("?")[0]
        if p == "/" or p == "/index.html":
            return os.path.join(ROOT, "web", "index.html")
        if p.startswith("/css/") or p.startswith("/js/"):
            return os.path.join(ROOT, "web", p.lstrip("/"))
        if p.startswith("/data/") and not os.path.exists(os.path.join(ROOT, p.lstrip("/"))):
            return os.path.join(ROOT, "web", p.lstrip("/"))
        return super().translate_path(path)
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H) as s:
        print(f"Lancers 名鑑  ->  http://localhost:{PORT}/   (Ctrl+C で停止)")
        try:
            webbrowser.open(f"http://localhost:{PORT}/")
        except Exception:
            pass
        s.serve_forever()
