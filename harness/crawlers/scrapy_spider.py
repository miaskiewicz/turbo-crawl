# Scrapy spider for the crawl benchmark. Run via the Scrapy CLI so it executes
# inside Scrapy's own (pipx/venv) environment — the Node harness shells out with:
#
#   scrapy runspider scrapy_spider.py \
#       -a start=URL -a selector=CSS -a pages=N -a host=HOST \
#       -s LOG_ENABLED=False -s CONCURRENT_REQUESTS=2 -s DOWNLOAD_DELAY=0.15
#
# It does a same-host BFS capped at `pages`, counts CSS-selector matches with the
# SAME selector every other engine uses (fairness), and prints one JSON line
# {"pages": N, "items": M} to stdout on close. All Scrapy logging is on stderr.
import json
from urllib.parse import urlparse

import scrapy


class BenchSpider(scrapy.Spider):
    name = "bench"

    def __init__(self, start=None, selector=None, pages="20", host=None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.start_urls = [start]
        self.sel = selector
        self.max_pages = int(pages)
        self.host = host
        self.pages = 0
        self.items = 0
        self.seen = {start}

    def parse(self, response):
        if self.pages >= self.max_pages:
            return
        self.pages += 1
        self.items += len(response.css(self.sel))
        for href in response.css("a::attr(href)").getall():
            url = response.urljoin(href).split("#")[0]
            if urlparse(url).hostname != self.host:
                continue
            if url not in self.seen and len(self.seen) < self.max_pages * 50:
                self.seen.add(url)
                yield scrapy.Request(url, callback=self.parse)

    def closed(self, reason):
        print(json.dumps({"pages": self.pages, "items": self.items}))
