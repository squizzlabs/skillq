#!/usr/bin/env python3
"""Local dev server with GitHub Pages-style 404 handling.

Unknown extensionless paths return the project's 404.html so the same client-
side redirect to index.html happens locally and on GitHub Pages.
"""

from __future__ import annotations

import argparse
import io
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


class SpaFallbackHandler(SimpleHTTPRequestHandler):
    """Serve static assets and return 404.html for unknown app routes."""

    def serve_404_page(self):
        fallback_path = Path(self.directory) / "404.html"
        if not fallback_path.is_file():
            return super().send_error(404)

        content = fallback_path.read_bytes()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        return io.BytesIO(content)

    def send_head(self):
        parsed = urlparse(self.path)
        request_path = unquote(parsed.path)

        # Serve real files when present.
        fs_path = Path(self.directory) / request_path.lstrip("/")
        if fs_path.is_file():
            return super().send_head()

        # Serve real directories only when they contain an index.html.
        if fs_path.is_dir():
            if (fs_path / "index.html").is_file():
                return super().send_head()
            return self.serve_404_page()

        # For extensionless app routes, return the custom 404 page.
        route_name = Path(request_path.rstrip("/")).name
        if "." not in route_name:
            return self.serve_404_page()

        # Keep normal 404 behavior for unknown asset paths.
        self.send_error(404)
        return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a local static server with SPA route fallback."
    )
    parser.add_argument(
        "--host",
        default="localhost",
        help="Bind host (default: localhost)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=22222,
        help="Bind port (default: 22222)",
    )
    parser.add_argument(
        "--dir",
        default=".",
        help="Directory to serve (default: current directory)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    directory = str(Path(args.dir).resolve())

    class Handler(SpaFallbackHandler):
        def __init__(self, *handler_args, **handler_kwargs):
            super().__init__(*handler_args, directory=directory, **handler_kwargs)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Serving {directory} at http://{args.host}:{args.port}")
    print("Custom 404 redirect behavior is enabled for unknown routes.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
