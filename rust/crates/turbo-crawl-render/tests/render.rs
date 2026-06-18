//! Render-tier integration tests. These drive deno_core (which boots V8 its own
//! way), so they live in a SEPARATE test binary from the lib unit tests — the
//! vendored `browser_env_upstream.rs` smoke test boots a standalone V8 platform in
//! the lib binary, and the two platform initializations must not share a process.

use turbo_crawl_render::{
    render_html, render_html_async, render_hydrate, render_page, render_page_with_budget,
    run_with_dom,
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
