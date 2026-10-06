"""Локальный сервер для разработки: отдаёт проект без кеширования,
чтобы браузер не подгружал устаревшие ES-модули.

Запуск:  python tools/serve.py [порт]
"""

import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    handler = functools.partial(NoCacheHandler, directory='.')
    with ThreadingHTTPServer(('127.0.0.1', port), handler) as httpd:
        print(f'http://127.0.0.1:{port}/  (Ctrl+C — остановить)')
        httpd.serve_forever()


if __name__ == '__main__':
    main()