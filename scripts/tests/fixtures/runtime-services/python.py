import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    count = 0

    def respond(self):
        Handler.count += 1
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400, "Invalid Content-Length")
            return
        if length < 0 or self.headers.get("Transfer-Encoding"):
            self.send_error(400, "Unsupported body framing")
            return
        if length > 65536:
            self.rfile.read(min(length, 65537))
            self.send_error(413, "Body too large")
            return
        raw = self.rfile.read(length)
        if len(raw) != length:
            self.send_error(400, "Incomplete body")
            return
        try:
            body = raw.decode("utf-8")
        except UnicodeDecodeError:
            self.send_error(400, "Body must be UTF-8")
            return
        payload = json.dumps({
            "family": "python", "method": self.command, "path": self.path,
            "body": body, "count": Handler.count,
        }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    do_GET = respond
    do_POST = respond
    do_PUT = respond
    do_DELETE = respond
    do_PATCH = respond
    do_OPTIONS = respond

    def log_message(self, *_args):
        pass

    def send_error(self, code, message=None, explain=None):
        payload = json.dumps({"error": message or "Request failed"}).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True


HTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 8080), Handler).serve_forever()
