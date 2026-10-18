"""Test the installed-app upgrade in an isolated disposable copy of git HEAD."""
import functools
import io
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tarfile
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix="scratch-upgrade-", dir=os.environ.get("TMPDIR")) as directory:
        target = Path(directory)
        archive = subprocess.check_output(["git", "archive", "HEAD", "scratch"], cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive)) as files:
            for entry in files.getmembers():
                path = (target / entry.name).resolve()
                if not path.is_relative_to(target.resolve()) or entry.issym() or entry.islnk():
                    raise ValueError("unsafe git archive entry")
            files.extractall(target)

        class Handler(SimpleHTTPRequestHandler):
            offline = False

            def do_GET(self):
                if Handler.offline:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                super().do_GET()

            def do_POST(self):
                if self.path == "/__offline":
                    Handler.offline = True
                    self.send_response(204)
                    self.end_headers()
                    return
                if self.path != "/__upgrade":
                    self.send_error(404)
                    return
                shutil.copytree(ROOT / "scratch", target / "scratch", dirs_exist_ok=True)
                self.send_response(204)
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(target)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            env = {**os.environ, "SCRATCH_TEST_URL": f"http://127.0.0.1:{server.server_port}/scratch/"}
            subprocess.run(["node", "tests/upgrade-browser.cjs"], cwd=ROOT, env=env, check=True)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
