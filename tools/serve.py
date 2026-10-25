#!/usr/bin/env python3
"""Dev server for the spike pages and the built extension.

ThreadingHTTPServer + no-store: the stock `python -m http.server` is single-threaded
(listen backlog 5, so a page pulling a dozen modules gets a spurious
ERR_CONNECTION_REFUSED) and sends Last-Modified without Cache-Control, so an
edited module silently stays cached for hours.

--coi adds Cross-Origin-Opener/Embedder-Policy so self.crossOriginIsolated is true,
which is what onnxruntime-web needs for multi-threaded WASM (SharedArrayBuffer).
"""
import argparse
import functools
import http.server
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        # Without this, .mjs is served as text/plain and Chrome refuses the module script.
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        if self.server.coi:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.server.verbose:
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port", nargs="?", type=int, default=8791)
    ap.add_argument("--coi", action="store_true", help="enable cross-origin isolation (threads)")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    handler = functools.partial(Handler, directory=str(ROOT))
    with Server(("127.0.0.1", a.port), handler) as httpd:
        httpd.verbose = a.verbose
        httpd.coi = a.coi
        print(f"serving {ROOT} on http://127.0.0.1:{a.port} (coi={a.coi})", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
