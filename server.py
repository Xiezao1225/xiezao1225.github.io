#!/usr/bin/env python3
"""支持 Range 请求的本地 HTTP 服务器，用于视频播放"""
import http.server
import os
import re
import socketserver

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def do_GET(self):
        fpath = self.translate_path(self.path)
        if not os.path.isfile(fpath):
            super().do_GET()
            return

        file_size = os.path.getsize(fpath)
        range_header = self.headers.get("Range")

        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if match:
                start, end = match.groups()
                try:
                    start = int(start) if start else 0
                    end = int(end) if end else file_size - 1
                    if start >= file_size:
                        self.send_error(416, "Range Not Satisfiable")
                        return
                    end = min(end, file_size - 1)
                    length = end - start + 1

                    self.send_response(206)
                    self.send_header("Content-Type", self.guess_type(fpath))
                    self.send_header("Content-Length", str(length))
                    self.send_header(
                        "Content-Range",
                        f"bytes {start}-{end}/{file_size}"
                    )
                    self.end_headers()

                    with open(fpath, "rb") as f:
                        f.seek(start)
                        remaining = length
                        while remaining > 0:
                            chunk = f.read(min(64 * 1024, remaining))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
                    return
                except (ValueError, OSError):
                    pass

        super().do_GET()

    def do_HEAD(self):
        fpath = self.translate_path(self.path)
        if os.path.isfile(fpath):
            file_size = os.path.getsize(fpath)
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(fpath))
            self.send_header("Content-Length", str(file_size))
            self.end_headers()
        else:
            super().do_HEAD()

os.chdir(DIRECTORY)
with socketserver.TCPServer(("", PORT), RangeHandler) as httpd:
    print(f"✅ 服务器已启动: http://localhost:{PORT}")
    print(f"   视频页: http://localhost:{PORT}/anmuxi.html")
    print(f"   首页:   http://localhost:{PORT}/index.html")
    httpd.serve_forever()