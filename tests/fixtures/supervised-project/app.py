from http.server import BaseHTTPRequestHandler, HTTPServer
import os
import sqlite3
import sys
from urllib.request import urlopen


class App(BaseHTTPRequestHandler):
    def do_GET(self):
        if sys.argv[1] == 'db':
            with sqlite3.connect('/data/example.db') as db:
                db.execute('CREATE TABLE IF NOT EXISTS messages (text TEXT)')
                if self.path == '/write':
                    db.execute("INSERT INTO messages VALUES ('persisted row')")
                rows = db.execute('SELECT text FROM messages')
                payload = ','.join(row[0] for row in rows).encode()
        else:
            database = os.environ.get('DATABASE_URL', 'http://db:8000')
            with urlopen(database + self.path, timeout=5) as response:
                payload = response.read()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(payload)


HTTPServer(('', int(os.environ.get('PORT', '8000'))), App).serve_forever()
