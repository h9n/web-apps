# Web Apps

Small, dependency-free web applications hosted at `apps.octofi.sh`.

## Applications

- [`/scratch/`](scratch/) — a local-only plain-text notebook. Notes are stored in the browser with IndexedDB and are never committed to this repository or sent to the server.

## Structure

Each application lives in its own directory and uses relative URLs so it can be developed locally and published under the same path.

## Local preview

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080/`.
