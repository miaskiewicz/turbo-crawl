//! Render-tier integration tests. These drive deno_core (which boots V8 its own
//! way), so they live in a SEPARATE test binary from the lib unit tests — the
//! vendored `browser_env_upstream.rs` smoke test boots a standalone V8 platform in
//! the lib binary, and the two platform initializations must not share a process.

use turbo_crawl_render::{
    render_html, render_html_async, render_hydrate, render_page, render_page_with_budget,
    run_with_dom, PageSession, DEFAULT_RENDER_BUDGET_MS,
};

// --- reads over a real parsed DOM -------------------------------------------
#[test]
fn reads_real_parsed_dom() {
    assert_eq!(
        run_with_dom(
            "<html><body><h1 id='title'>Hello</h1></body></html>",
            "document.querySelector('h1').textContent"
        )
        .unwrap(),
        "Hello"
    );
    assert_eq!(
        run_with_dom(
            "<html><body><h1 id='title'>Hello</h1></body></html>",
            "document.getElementById('title').getAttribute('id')"
        )
        .unwrap(),
        "title"
    );
}

#[test]
fn query_selector_all_returns_list() {
    let n = run_with_dom(
        "<ul><li>a</li><li>b</li><li>c</li></ul>",
        "String(document.querySelectorAll('li').length)",
    )
    .unwrap();
    assert_eq!(n, "3");
}

#[test]
fn scoped_query_within_element() {
    let txt = run_with_dom(
        "<div id='a'><span class='x'>1</span></div><span class='x'>2</span>",
        "document.getElementById('a').querySelector('.x').textContent",
    )
    .unwrap();
    assert_eq!(txt, "1");
}

#[test]
fn element_api_surface() {
    // tagName / innerHTML / outerHTML / body / mutate + reserialize, all within one
    // render (the binding holds the tree for the life of the install).
    let out = run_with_dom(
        "<html><body><div id='a' class='c'>hi</div></body></html>",
        r#"
        const el = document.querySelector('#a');
        el.setAttribute('data-x', '1');
        el.id = 'b';
        JSON.stringify({
          tag: el.tagName,
          inner: el.innerHTML,
          outer: el.outerHTML,
          hasBody: document.body !== null,
          dataX: el.getAttribute('data-x'),
          byNewId: document.getElementById('b') !== null,
        });
        "#,
    )
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["tag"], "DIV", "{out}");
    assert!(v["inner"].as_str().unwrap().contains("hi"), "{out}");
    assert!(
        v["outer"].as_str().unwrap().contains("class=\"c\""),
        "{out}"
    );
    assert_eq!(v["hasBody"], true, "{out}");
    assert_eq!(v["dataX"], "1", "{out}");
    assert_eq!(v["byNewId"], true, "{out}");
}

#[test]
fn window_and_navigator_present() {
    assert_eq!(
        run_with_dom("<body></body>", "navigator.userAgent").unwrap(),
        "turbo-crawl"
    );
    assert_eq!(
        run_with_dom("<body></body>", "String(window === globalThis)").unwrap(),
        "true"
    );
}

// Setting `location.href` must DECOMPOSE the URL into pathname/search/hash/host/etc.
// Next's app-router reads usePathname()/useSearchParams() off these; a static location
// (browser_env's plain object) left pathname at "/" so the payroll login route guard saw
// a protected route and rendered "Redirecting…" instead of the form.
#[test]
fn location_href_decomposes_into_components() {
    let out = run_with_dom(
        "<body></body>",
        r#"
        location.href = "https://app.example/login?next=%2Fhome&x=1#frag";
        JSON.stringify({
          pathname: location.pathname, search: location.search, hash: location.hash,
          host: location.host, hostname: location.hostname, protocol: location.protocol,
          origin: location.origin,
        });
        "#,
    )
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["pathname"], "/login", "{out}");
    assert_eq!(v["search"], "?next=%2Fhome&x=1", "{out}");
    assert_eq!(v["hash"], "#frag", "{out}");
    assert_eq!(v["host"], "app.example", "{out}");
    assert_eq!(v["protocol"], "https:", "{out}");
    assert_eq!(v["origin"], "https://app.example", "{out}");
}

// FormData — PropelAuth + form libs build credential payloads with it during hydration;
// deno_core ships none, so the login bundle crashed with "FormData is not defined".
#[test]
fn form_data_present_and_spec_shaped() {
    let out = run_with_dom(
        "<body></body>",
        r#"
        const fd = new FormData();
        fd.append("a", "1"); fd.append("a", "2"); fd.set("b", "3"); fd.set("a", "9");
        JSON.stringify({
          a: fd.getAll("a"), b: fd.get("b"), hasB: fd.has("b"),
          entries: [...fd.entries()],
        });
        "#,
    )
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        v["a"],
        serde_json::json!(["9"]),
        "set must replace all: {out}"
    );
    assert_eq!(v["b"], "3", "{out}");
    assert_eq!(v["hasB"], true, "{out}");
}

// The interactive-SPA capability: a LIVE PageSession keeps the hydrated app's JS alive,
// so a dispatched event re-enters a delegated listener (the way React 17+ delegates all
// events at the root) and the re-render is observable — none of which works on the
// stateless render_* paths (they serialize + reset, killing the running app). This is
// the foundation for driving an authenticated SPA login through the shim.
#[tokio::test]
async fn live_session_dispatches_events_into_running_app() {
    // A root-delegated click listener (React-style): one listener on `document`, the
    // handler reads event.target and re-renders. Clicking the (deep) button must bubble
    // up to it. Also a controlled-input-style `input` listener mirroring value → text.
    let html = r#"<body>
      <div id="app">
        <button id="btn">+</button>
        <span data-test-id="count">0</span>
        <input id="field" />
        <span data-test-id="echo"></span>
      </div>
      <script>
        let n = 0;
        document.addEventListener('click', (e) => {
          if (e.target && e.target.id === 'btn') {
            n++;
            document.querySelector('[data-test-id="count"]').textContent = String(n);
          }
        });
        document.addEventListener('input', (e) => {
          if (e.target && e.target.id === 'field') {
            document.querySelector('[data-test-id="echo"]').textContent = e.target.value;
          }
        });
      </script>
    </body>"#;

    let mut session = PageSession::open(
        html,
        "https://example.test/",
        "",
        "",
        DEFAULT_RENDER_BUDGET_MS,
    )
    .await
    .expect("session opens");

    // Dispatch a bubbling click on the deep button — must reach the document listener.
    let click = r#"document.getElementById('btn').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }));"#;
    session.eval(click).await.unwrap();
    assert!(
        session.serialize().contains(r#"data-test-id="count">1<"#),
        "delegated click handler must run + re-render: {}",
        session.serialize()
    );

    // State persists across ops — a second click increments again (proves the app is
    // alive between calls, not re-hydrated from a string each time).
    session.eval(click).await.unwrap();
    assert!(
        session.serialize().contains(r#"data-test-id="count">2<"#),
        "running app state must persist across ops: {}",
        session.serialize()
    );

    // Controlled-input: set value + dispatch `input` → the delegated handler mirrors it.
    let fill = r#"const f = document.getElementById('field'); f.value = 'hello';
        f.dispatchEvent(new InputEvent('input', { bubbles: true }));"#;
    session.eval(fill).await.unwrap();
    assert!(
        session
            .serialize()
            .contains(r#"data-test-id="echo">hello<"#),
        "input event must reach the controlled-input handler: {}",
        session.serialize()
    );

    session.close();
}

// Mirrors the payroll /login hydration crash: the page's client JS (Next.js +
// the PropelAuth SDK) uses WHATWG `URL` / `URLSearchParams` while building the
// login form. deno_core doesn't ship those globals, so hydration died with
// "ReferenceError: URL is not defined" and the `login-email-input` never
// rendered. The render tier must provide them.
#[test]
fn whatwg_url_available_for_hydration() {
    let html = render_html(
        "<body><div id='root'></div></body>",
        r#"
        const u = new URL("https://app.example/login?next=%2Fhome");
        const sp = new URLSearchParams(u.search);
        const root = document.getElementById('root');
        const input = document.createElement('input');
        input.setAttribute('data-testid', 'login-email-input');
        input.setAttribute('data-next', sp.get('next'));
        input.setAttribute('data-host', u.hostname);
        input.setAttribute('data-proto', u.protocol);
        root.appendChild(input);
        "#,
    )
    .unwrap();
    assert!(
        html.contains(r#"data-testid="login-email-input""#),
        "login form should render after hydration: {html}"
    );
    assert!(
        html.contains(r#"data-next="/home""#),
        "URLSearchParams.get must decode: {html}"
    );
    assert!(
        html.contains(r#"data-host="app.example""#),
        "URL.hostname must parse: {html}"
    );
    assert!(
        html.contains(r#"data-proto="https:""#),
        "URL.protocol must parse: {html}"
    );
}

// document.createTreeWalker — MUI's DataGrid / focus-trap walks the tree with it; its
// absence threw "createTreeWalker is not a function" and blanked the whole page.
#[test]
fn create_tree_walker_walks_the_dom() {
    let out = run_with_dom(
        "<body><div id='r'><a id='a1'>1</a><span><a id='a2'>2</a></span><a id='a3'>3</a></div></body>",
        r#"
        const root = document.getElementById('r');
        const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
          acceptNode: (n) => n.tagName === 'A' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
        });
        const ids = [];
        let n; while ((n = w.nextNode())) ids.push(n.getAttribute('id'));
        ids.join(',');
        "#,
    )
    .unwrap();
    assert_eq!(
        out, "a1,a2,a3",
        "TreeWalker must visit accepted <a> in document order"
    );
}

// Next.js's webpack runtime resolves chunk paths via `document.currentScript`
// (getPathFromScript → currentScript.getAttribute(...)). Our tier ran scripts as
// one blob with no currentScript, so hydration crashed with "Cannot read
// properties of undefined (reading 'getAttribute')". currentScript must be a real
// element so that read is safe.
#[test]
fn document_current_script_is_present_for_webpack() {
    let out = run_with_dom(
        "<body><div id='root'></div></body>",
        r#"
        const cs = document.currentScript;
        // webpack does currentScript.getAttribute('src').replace(...) — must be a string.
        const src = cs && typeof cs.getAttribute === 'function' ? cs.getAttribute('src') : 'MISSING';
        const safe = typeof src === 'string' ? src.replace(/x/g, 'x') : 'NOT-A-STRING';
        document.getElementById('root').setAttribute('data-cs', safe);
        document.getElementById('root').getAttribute('data-cs');
        "#,
    )
    .unwrap();
    assert_eq!(
        out, "http://localhost/",
        "currentScript.getAttribute('src') must be the page URL string, got {out}"
    );
}

// Embeddable widgets (PropelAuth's login) render into a Shadow DOM via
// host.attachShadow(). rtdom has no shadow tree, so we fall back to the light DOM —
// attachShadow returns the host, content lands in the serialized document. Without
// it, hydration crashed with "attachShadow is not a function".
#[test]
fn attach_shadow_falls_back_to_light_dom() {
    let html = render_html(
        "<body><div id='host'></div></body>",
        r#"
        const host = document.createElement('div'); // React creates the shadow host
        document.getElementById('host').appendChild(host);
        const root = host.attachShadow({ mode: 'open' });
        // code reads shadowRoot.host to get the host back (Next devtools theme code)
        root.host.setAttribute('data-host-ok', '1');
        const input = document.createElement('input');
        input.setAttribute('data-testid', 'shadow-input');
        root.appendChild(input);
        "#,
    )
    .unwrap();
    assert!(
        html.contains(r#"data-testid="shadow-input""#),
        "content rendered into a shadow root must reach the serialized light DOM: {html}"
    );
    assert!(
        html.contains(r#"data-host-ok="1""#),
        "shadowRoot.host must point back to the host element: {html}"
    );
}

// The React Server Components client reads the flight payload as a ReadableStream,
// and fetch/abortable work needs AbortController. deno_core ships neither.
#[tokio::test]
async fn readable_stream_and_abort_controller_present() {
    let html = render_page(
        "<body><div id='root'></div></body>",
        "about:blank",
        r#"
        (async () => {
          const rs = new ReadableStream({
            start(c) { c.enqueue("alpha"); c.enqueue("beta"); c.close(); },
          });
          const reader = rs.getReader();
          let parts = [];
          for (;;) { const { value, done } = await reader.read(); if (done) break; parts.push(value); }
          const ac = new AbortController();
          const aborted0 = ac.signal.aborted;
          ac.abort();
          document.getElementById('root').setAttribute('data-parts', parts.join(','));
          document.getElementById('root').setAttribute('data-abort', String(aborted0) + '->' + String(ac.signal.aborted));
        })();
        "#,
    )
    .await
    .unwrap();
    assert!(
        html.contains(r#"data-parts="alpha,beta""#),
        "ReadableStream reader must yield chunks: {html}"
    );
    assert!(
        html.contains(r#"data-abort="false->true""#),
        "AbortController.abort must flip signal: {html}"
    );
}

// RSC flight is a STREAMING producer: the controller is enqueued/closed LATER than the
// first read() (flight rows arrive as `__next_f` pushes; close fires on DOMContentLoaded).
// A read() that hits an empty-but-OPEN stream must PARK until the next enqueue/close —
// returning {done:true} there truncates the flight mid-stream and the render never
// converges. This drives the producer from a timer AFTER the reader has already parked.
#[tokio::test]
async fn readable_stream_parks_for_async_producer() {
    let html = render_page(
        "<body><div id='root'></div></body>",
        "about:blank",
        r#"
        (async () => {
          let ctrl;
          const rs = new ReadableStream({ start(c) { ctrl = c; } }); // empty at start
          // Producer runs on later turns, AFTER read() has parked on the empty stream.
          setTimeout(() => ctrl.enqueue("one"), 0);
          setTimeout(() => ctrl.enqueue("two"), 0);
          setTimeout(() => ctrl.close(), 0);
          const reader = rs.getReader();
          const parts = [];
          for (;;) { const { value, done } = await reader.read(); if (done) break; parts.push(value); }
          document.getElementById('root').setAttribute('data-parts', parts.join(','));
        })();
        "#,
    )
    .await
    .unwrap();
    assert!(
        html.contains(r#"data-parts="one,two""#),
        "reader must park on an empty-open stream and resume on later enqueue/close, \
         not report EOF early: {html}"
    );
}

// File / Blob / FileReader / Headers — auth SDKs + analytics (PostHog) reference these
// during hydration; their absence aborted PostHog init ("File/Headers is not defined")
// and a fetch Response with no `headers` crashed Next's RSC client navigation
// (`res.headers.get('content-type')`). Verify the globals exist and the fetch Response
// exposes a working `headers`.
#[tokio::test]
async fn web_platform_globals_for_hydration() {
    let out = render_html(
        "<body><div id='root'></div></body>",
        r#"
        const fr = new FileReader();
        const f = new File(["hi"], "a.txt", { type: "text/plain" });
        const h = new Headers({ "Content-Type": "text/x-component" });
        const out = document.getElementById('root');
        out.setAttribute('data-file', String(f.name) + ":" + String(f.size));
        out.setAttribute('data-blob', String(new Blob(["abcd"]).size));
        out.setAttribute('data-hdr', String(h.get("content-type")));   // case-insensitive
        out.setAttribute('data-types', [typeof File, typeof Blob, typeof FileReader, typeof Headers].join(','));
        "#,
    )
    .unwrap();
    assert!(out.contains(r#"data-file="a.txt:2""#), "File: {out}");
    assert!(out.contains(r#"data-blob="4""#), "Blob.size: {out}");
    assert!(
        out.contains(r#"data-hdr="text/x-component""#),
        "Headers.get (ci): {out}"
    );
    assert!(
        out.contains(r#"data-types="function,function,function,function""#),
        "all four globals defined: {out}"
    );
}

// crypto.subtle.digest (real SHA-256), BroadcastChannel, and WebSocket — auth SDKs
// (PropelAuth) + analytics use these during hydration. WebSocket must not hang/throw.
#[tokio::test]
async fn crypto_subtle_websocket_broadcastchannel_present() {
    let html = render_page(
        "<body><div id='root'></div></body>",
        "about:blank",
        r#"
        (async () => {
          const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
          const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
          const root = document.getElementById("root");
          root.setAttribute("data-sha", hex);
          root.setAttribute("data-ws", typeof WebSocket);
          root.setAttribute("data-bc", typeof BroadcastChannel);
          const ws = new WebSocket("wss://x/y"); // must not throw or hang
          root.setAttribute("data-ws-state", String(ws.readyState));
          const bc = new BroadcastChannel("t"); let got = "";
          const bc2 = new BroadcastChannel("t"); bc2.onmessage = (e) => { got = e.data; root.setAttribute("data-bc-msg", got); };
          bc.postMessage("ping");
        })();
        "#,
    )
    .await
    .unwrap();
    assert!(
        html.contains(
            r#"data-sha="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad""#
        ),
        "SHA-256(\"abc\") must match the known vector: {html}"
    );
    assert!(
        html.contains(r#"data-ws="function""#) && html.contains(r#"data-ws-state="0""#),
        "WebSocket stub present + CONNECTING: {html}"
    );
    assert!(
        html.contains(r#"data-bc="function""#),
        "BroadcastChannel present: {html}"
    );
    assert!(
        html.contains(r#"data-bc-msg="ping""#),
        "BroadcastChannel delivers same-name messages: {html}"
    );
}

// Web globals deno_core lacks but app bundles use (TextEncoder/Decoder round-trip,
// crypto.getRandomValues, btoa/atob). A bundle touching any of these mid-hydration
// would otherwise crash with "X is not defined".
#[test]
fn encoding_crypto_base64_globals_present() {
    let out = run_with_dom(
        "<body></body>",
        r#"
        const enc = new TextEncoder().encode("héllo");
        const back = new TextDecoder().decode(enc);
        const rnd = new Uint8Array(4); crypto.getRandomValues(rnd);
        JSON.stringify({ roundtrip: back, bytes: enc.length, uuid: typeof crypto.randomUUID(), b64: btoa("hi"), un: atob(btoa("hi")) });
        "#,
    )
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["roundtrip"], "héllo", "{out}");
    assert_eq!(v["bytes"], 6, "héllo is 6 UTF-8 bytes: {out}");
    assert_eq!(v["b64"], "aGk=", "{out}");
    assert_eq!(v["un"], "hi", "{out}");
}

// React 18's scheduler drains its work queue via a MessageChannel (port2.postMessage
// → port1.onmessage). Without it, scheduled work (the hydration/mount the entry
// queues) never runs and nothing paints. MessageChannel must route a message to the
// other port's onmessage, drained by the timer/hydration pump.
#[test]
fn message_channel_drives_scheduled_work() {
    let html = render_html(
        "<body><div id='root'></div></body>",
        r#"
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          const i = document.createElement('input');
          i.setAttribute('data-testid', 'scheduled');
          document.getElementById('root').appendChild(i);
        };
        ch.port2.postMessage(null); // schedule work — must reach port1.onmessage
        "#,
    )
    .unwrap();
    assert!(
        html.contains(r#"data-testid="scheduled""#),
        "MessageChannel must deliver to the other port's onmessage: {html}"
    );
}

// --- hydration (the headline tier-3 capability) -----------------------------
#[test]
fn page_script_hydrates_then_serializes() {
    let html = render_html(
        "<html><body><div id='app'></div></body></html>",
        r#"
        const app = document.getElementById('app');
        app.innerHTML = '<p class="msg">hydrated</p>';
        setTimeout(() => {
          const span = document.createElement('span');
          span.textContent = 'fromtimer';
          app.appendChild(span);
        }, 10);
        "#,
    )
    .unwrap();
    assert!(
        html.contains(r#"<p class="msg">hydrated</p>"#),
        "got: {html}"
    );
    assert!(html.contains("<span>fromtimer</span>"), "got: {html}");
}

#[tokio::test]
async fn mock_spa_hydrates_into_root() {
    // A framework-shaped bundle: mounts into #root, holds state, re-renders after an
    // effect (setTimeout) — the SPA hydration path end to end.
    let bundle = r#"
        const root = document.getElementById('root');
        let state = { count: 0, items: ['a', 'b'] };
        function render() {
          root.innerHTML = '';
          const app = document.createElement('div');
          app.setAttribute('class', 'app');
          const h = document.createElement('h1');
          h.textContent = 'Count: ' + state.count;
          app.appendChild(h);
          const ul = document.createElement('ul');
          for (const it of state.items) {
            const li = document.createElement('li');
            li.textContent = it;
            ul.appendChild(li);
          }
          app.appendChild(ul);
          root.appendChild(app);
        }
        render();                                   // initial mount
        setTimeout(() => {                          // effect → setState → re-render
          state.count = 5;
          state.items.push('c');
          render();
        }, 10);
    "#;
    let html = render_page(
        "<html><body><div id='root'></div></body></html>",
        "https://x.test/",
        bundle,
    )
    .await
    .unwrap()
    .replace("&nbsp;", " ");
    assert!(html.contains(r#"<div class="app">"#), "got: {html}");
    assert!(html.contains("<h1>Count: 5</h1>"), "got: {html}");
    assert!(html.contains("<li>c</li>"), "got: {html}");
}

#[tokio::test]
async fn async_promise_hydration_resolves() {
    let html = render_html_async(
        "<html><body><div id='app'></div></body></html>",
        r#"
        Promise.resolve().then(() => {
          document.getElementById('app').innerHTML = '<p>micro</p>';
        });
        (async () => {
          await new Promise((r) => setTimeout(r, 5));
          const s = document.createElement('span');
          s.textContent = 'awaited';
          document.getElementById('app').appendChild(s);
        })();
        "#,
    )
    .await
    .unwrap();
    assert!(html.contains("<p>micro</p>"), "got: {html}");
    assert!(html.contains("<span>awaited</span>"), "got: {html}");
}

// --- DOM shims the render tier adds for real-world bundles (jQuery etc.) -----
#[test]
fn get_elements_by_tag_name_on_detached_subtree() {
    // jQuery's support probe builds a DETACHED div and reads
    // `div.getElementsByTagName('input')[0]`; the native query matches only
    // connected nodes, so the extension walks `children` instead.
    let out = run_with_dom(
        "<body></body>",
        r#"
        const div = document.createElement('div');
        div.innerHTML = '<input type="checkbox"><span>x</span><input>';
        JSON.stringify({
          inputs: div.getElementsByTagName('input').length,
          all: div.getElementsByTagName('*').length,
          last: div.lastChild ? String(div.lastChild.tagName) : null,
          lastEl: div.lastElementChild ? String(div.lastElementChild.tagName) : null,
        });
        "#,
    )
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["inputs"], 2, "{out}");
    assert_eq!(v["all"], 3, "{out}");
    assert_eq!(v["last"], "INPUT", "{out}");
    assert_eq!(v["lastEl"], "INPUT", "{out}");
}

#[test]
fn document_write_appends_to_body() {
    let html = render_html(
        "<html><body></body></html>",
        r#"
        document.write("<div class='quote'>one</div>");
        document.write("<div class='quote'>two</div>");
        "#,
    )
    .unwrap();
    let n = html.matches(r#"class="quote""#).count();
    assert_eq!(n, 2, "got: {html}");
    assert!(
        html.contains(">one<") && html.contains(">two<"),
        "got: {html}"
    );
}

// The SPA differentiator: webpack's `__webpack_require__.e` injects a <script src>
// chunk at runtime and waits for its `onload` before mounting the app. A node DOM
// that only appends the <script> never runs it → the loader hangs → nothing paints.
// render_hydrate must FETCH + EXECUTE the injected chunk and fire onload, so the
// form (login-email-input) the onload builds actually renders.
#[tokio::test]
async fn dynamic_script_injection_runs_and_fires_onload() {
    let port = spawn_json_server("globalThis.__chunkRan = true;").await;
    let html = r#"<body><div id="root"></div>
      <script>
        const s = document.createElement('script');
        s.src = '/chunk.js';
        s.onload = () => {
          const i = document.createElement('input');
          i.setAttribute('data-testid', 'login-email-input');
          i.setAttribute('data-chunk', String(globalThis.__chunkRan === true));
          document.getElementById('root').appendChild(i);
        };
        document.head.appendChild(s);
      </script></body>"#;
    let out = render_hydrate(html, &base(port)).await.unwrap();
    assert!(
        out.contains(r#"data-testid="login-email-input""#),
        "injected chunk's onload must run and render the form: {out}"
    );
    assert!(
        out.contains(r#"data-chunk="true""#),
        "the injected chunk's own code must have executed: {out}"
    );
}

// Module-capable runtimes (us, every modern browser) SKIP `<script nomodule>` and
// run the module build instead. The hydration pump must honor this: a page's legacy
// polyfill bundle (e.g. Next's core-js `polyfill-nomodule`) overwrites native
// Promise/queueMicrotask with impls whose microtask scheduler is inert here, so
// running it makes the page's promises never settle and the render never converges.
// Both spellings appear in the wild: `nomodule` (HTML) and `noModule` (Next's
// server-rendered serialization of the React `noModule` prop).
#[tokio::test]
async fn nomodule_scripts_are_skipped() {
    for attr in ["nomodule", "noModule=\"\""] {
        let html = format!(
            r#"<body><div id="root"></div>
              <script {attr}>
                const bad = document.createElement('input');
                bad.setAttribute('data-testid', 'nomodule-ran');
                document.getElementById('root').appendChild(bad);
              </script>
              <script>
                const ok = document.createElement('input');
                ok.setAttribute('data-testid', 'module-ran');
                document.getElementById('root').appendChild(ok);
              </script></body>"#
        );
        let out = render_hydrate(&html, "https://example.test/")
            .await
            .unwrap();
        assert!(
            !out.contains(r#"data-testid="nomodule-ran""#),
            "[{attr}] nomodule script must NOT run: {out}"
        );
        assert!(
            out.contains(r#"data-testid="module-ran""#),
            "[{attr}] the non-nomodule script must still run: {out}"
        );
    }
}

// --- network: fetch / XHR over the tier-1 stack -----------------------------
#[tokio::test]
async fn mock_spa_fetches_data_via_xhr() {
    let port = spawn_json_server(r#"{"title":"From XHR"}"#).await;
    let bundle = r#"
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/data.json');
        xhr.onload = () => {
          const d = JSON.parse(xhr.responseText);
          document.getElementById('root').textContent = d.title;
        };
        xhr.send();
    "#;
    let html = render_page(
        "<body><div id='root'>loading</div></body>",
        &base(port),
        bundle,
    )
    .await
    .unwrap()
    .replace("&nbsp;", " ");
    assert!(html.contains("From XHR"), "got: {html}");
}

#[tokio::test]
async fn fetch_over_net_hydrates_from_localhost() {
    let port = spawn_json_server(r#"{"msg":"from-fetch"}"#).await;
    let html = render_page(
        "<html><body><div id='app'></div></body></html>",
        &base(port),
        r#"
        (async () => {
          const r = await fetch('/data.json');
          const j = await r.json();
          document.getElementById('app').textContent = j.msg + ':' + r.status;
        })();
        "#,
    )
    .await
    .unwrap();
    assert!(html.contains("from-fetch:200"), "got: {html}");
}

#[tokio::test]
async fn fetch_failure_surfaces_as_failed_response() {
    // Nothing listening → fetch resolves to a failed Response (no throw).
    let html = render_page(
        "<html><body><div id='app'></div></body></html>",
        "http://127.0.0.1:1/",
        r#"
        (async () => {
          const r = await fetch('/x');
          document.getElementById('app').textContent = 'ok=' + r.ok + '/st=' + r.status;
        })();
        "#,
    )
    .await
    .unwrap();
    assert!(html.contains("ok=false/st=0"), "got: {html}");
}

// --- cookies + budget -------------------------------------------------------
#[tokio::test]
async fn document_cookie_bridge_roundtrips() {
    let html = render_page(
        "<html><body></body></html>",
        "https://x.test/",
        "document.cookie = 'a=1'; document.body.textContent = document.cookie;",
    )
    .await
    .unwrap();
    assert!(html.contains("a=1"), "got: {html}");
}

#[tokio::test]
async fn runaway_script_hits_render_budget() {
    let err = render_page_with_budget(
        "<body><div id='app'></div></body>",
        "https://x.test/",
        "while (true) {}",
        200,
    )
    .await
    .unwrap_err();
    assert!(err.contains("budget exceeded"), "got: {err}");
}

// --- helpers ----------------------------------------------------------------
async fn spawn_json_server(body: &'static str) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            let mut b = [0u8; 512];
            let _ = s.read(&mut b).await;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}"
            );
            let _ = s.write_all(resp.as_bytes()).await;
            let _ = s.flush().await;
        }
    });
    port
}

fn base(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}
