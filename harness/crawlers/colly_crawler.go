// Colly crawler for the crawl benchmark. The Node harness shells out with:
//
//	go run . -start=URL -selector=CSS -pages=N -host=HOST
//
// It does a same-host crawl capped at `pages`, counts matches of the SAME CSS
// selector every other engine uses (fairness), and prints one JSON line
// {"pages":N,"items":M} to stdout. First run downloads colly via the module
// cache (absorbed by the harness's untimed warmup iteration).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"sync"
	"time"

	"github.com/gocolly/colly/v2"
)

func main() {
	start := flag.String("start", "", "start URL")
	selector := flag.String("selector", "", "item CSS selector")
	pages := flag.Int("pages", 20, "page cap")
	host := flag.String("host", "", "same-host filter")
	flag.Parse()

	var mu sync.Mutex
	pageCount := 0
	itemCount := 0

	c := colly.NewCollector(colly.AllowedDomains(*host), colly.Async(true))
	_ = c.Limit(&colly.LimitRule{DomainGlob: "*", Parallelism: 2, Delay: 150 * time.Millisecond})

	// One handler per fetched page: count it + its selector matches (under the cap).
	c.OnHTML("html", func(e *colly.HTMLElement) {
		mu.Lock()
		defer mu.Unlock()
		if pageCount >= *pages {
			return
		}
		pageCount++
		itemCount += len(e.DOM.Find(*selector).Nodes)
	})

	// Same-host link discovery (skip once we've hit the cap).
	c.OnHTML("a[href]", func(e *colly.HTMLElement) {
		mu.Lock()
		over := pageCount >= *pages
		mu.Unlock()
		if over {
			return
		}
		link := e.Request.AbsoluteURL(e.Attr("href"))
		if link == "" {
			return
		}
		if u, err := url.Parse(link); err == nil && u.Host == *host {
			_ = c.Visit(link)
		}
	})

	_ = c.Visit(*start)
	c.Wait()

	out, _ := json.Marshal(map[string]int{"pages": pageCount, "items": itemCount})
	fmt.Println(string(out))
}
