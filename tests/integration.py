"""Exercise real Scratch clients against real Stash over local HTTPS.

Usage: PLAYWRIGHT_MODULE=/path/to/playwright python3 tests/integration.py /path/to/stash
Archives, certificates and browser profiles are disposable; no live service is used.
"""
import functools
import importlib.util
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]


def main():
    source = Path(sys.argv[1]) / "stash.py"
    spec = importlib.util.spec_from_file_location("stash_fixture", source)
    assert spec is not None and spec.loader is not None
    stash = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stash)
    with tempfile.TemporaryDirectory(prefix="scratch-integration-", dir=os.environ.get("TMPDIR")) as directory:
        temporary = Path(directory)
        certificate = temporary / "cert.pem"
        key = temporary / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", str(key), "-out", str(certificate)], check=True, capture_output=True)
        web = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(SimpleHTTPRequestHandler, directory=str(ROOT)))
        origin = f"http://127.0.0.1:{web.server_port}"
        archive = stash.StashServer(("127.0.0.1", 0), temporary / "archive", origin)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(certificate, key)
        archive.socket = tls.wrap_socket(archive.socket, server_side=True)
        servers = [web, archive]
        for server in servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            env = {**os.environ, "SCRATCH_TEST_URL": origin + "/scratch/", "STASH_TEST_SERVER": f"https://127.0.0.1:{archive.server_port}"}
            subprocess.run(["node", "tests/sync-browser.cjs"], cwd=ROOT, env=env, check=True)
            devices = sorted((temporary / "archive" / "scratch").iterdir())
            assert len(devices) == 2, "expected independent stable device IDs"
            count = sum(len(list(device.glob("backup/objects/*.json"))) for device in devices)
            assert count >= 4, "append-only historical archives retained"
            print(f"PASS: real local HTTPS Stash, two clients, CORS, read-back verification; {len(devices)} devices and {count} historical snapshots")
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    main()
