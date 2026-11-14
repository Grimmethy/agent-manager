"""gzip for the dashboard's text responses (HTML, JS, CSS, JSON).

Nothing the dashboard serves was compressed: the 17 tab scripts are ~420 KB raw but ~130 KB gzipped, the
unmerged-branches JSON is ~140 KB, and the chat plugin's files come through the plugin proxy. On a phone over a
cellular link that weight, not any broken file, is what made the page crawl and the chat's module import time out.

`compress_response` is registered once as an `after_request` hook in app.py, so it covers the page, Flask's static
route and every blueprint (the plugin proxy included). It leaves alone anything that must not be buffered or that has
no body worth compressing: streams (the chat's Server-Sent Events), anything but a 200, replies that are already
encoded, small bodies, and clients that did not ask for gzip.
"""
import gzip

from flask import request

MIN_BYTES = 1024
GZIP_LEVEL = 6
_COMPRESSIBLE = ("text/", "application/json", "application/javascript")


def _compressible(mimetype: str) -> bool:
    # text/event-stream starts with "text/" but is a live stream: buffering it to compress it would stall the chat.
    return mimetype != "text/event-stream" and mimetype.startswith(_COMPRESSIBLE)


def compress_response(response):
    if response.status_code != 200 or response.headers.get("Content-Encoding"):
        return response
    if not _compressible(response.mimetype):
        return response
    # A generator body is a stream. Flask's static route is also "streamed" (a file wrapper) but is a plain file
    # with a known size, so it is the one streamed shape that is worth reading in full.
    if response.is_streamed and not response.direct_passthrough:
        return response
    response.vary.add("Accept-Encoding")
    if not request.accept_encodings.quality("gzip"):
        return response
    response.direct_passthrough = False
    body = response.get_data()
    if len(body) < MIN_BYTES:
        return response
    response.set_data(gzip.compress(body, compresslevel=GZIP_LEVEL, mtime=0))
    response.headers["Content-Encoding"] = "gzip"
    tag, _weak = response.get_etag()
    if tag:
        # The compressed bytes are a different representation of the same resource: a weak tag still revalidates
        # (If-None-Match uses weak comparison) without claiming the two are byte-identical.
        response.set_etag(tag, weak=True)
    return response
