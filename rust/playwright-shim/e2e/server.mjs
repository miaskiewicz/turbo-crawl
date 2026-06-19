// A small server-rendered app for the e2e drop-in specs: home, a login form that
// sets a session cookie, a cookie-gated dashboard, and a product list/detail.
// Server-rendered on purpose — the no-browser engine reads what the server sends.
import { createServer } from "node:http";

const page = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const nav = `<nav>
  <a href="/" data-testid="nav-home">Home</a>
  <a href="/products" data-testid="nav-products">Products</a>
  <a href="/login" data-testid="nav-login">Login</a>
</nav>`;

const PRODUCTS = [
  { id: "1", name: "Widget", price: "9.99" },
  { id: "2", name: "Gadget", price: "19.99" },
  { id: "3", name: "Gizmo", price: "29.99" },
];

function home() {
  return page(
    "Home",
    `${nav}<main><h1>Welcome</h1><p class="tagline">Shop the catalog.</p></main>`,
  );
}

function loginForm(error) {
  return page(
    "Login",
    `${nav}<main><h1>Sign in</h1>
      ${error ? `<p role="alert" data-testid="error">${error}</p>` : ""}
      <form action="/login" method="post">
        <label for="email">Email</label><input id="email" name="email" data-testid="email">
        <label for="password">Password</label><input id="password" name="password" type="password" data-testid="password">
        <button type="submit" data-testid="submit">Sign in</button>
      </form></main>`,
  );
}

function dashboard(user) {
  if (!user) return page("Login", loginGate());
  return page(
    "Dashboard",
    `${nav}<main><h1>Dashboard</h1>
      <p data-testid="greeting">Welcome back, ${user}</p>
      <button data-testid="logout">Log out</button></main>`,
  );
}
const loginGate = () =>
  `${nav}<main><h1>Sign in</h1><p data-testid="gate">Please log in to continue.</p></main>`;

function productList() {
  const items = PRODUCTS.map(
    (p) =>
      `<li data-testid="product-${p.id}"><a href="/products/${p.id}">${p.name}</a> <span class="price">$${p.price}</span></li>`,
  ).join("");
  return page(
    "Products",
    `${nav}<main><h1>Products</h1><ul data-testid="product-list">${items}</ul></main>`,
  );
}

function productDetail(id) {
  const p = PRODUCTS.find((x) => x.id === id);
  if (!p) return null;
  return page(
    `Product ${p.name}`,
    `${nav}<main><h1 data-testid="product-name">${p.name}</h1>
      <p data-testid="product-price">$${p.price}</p>
      <button data-testid="add-to-cart">Add to cart</button></main>`,
  );
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

function userFromCookie(req) {
  const m = /sid=([^;]+)/.exec(req.headers.cookie ?? "");
  return m ? decodeURIComponent(m[1]) : null;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const html = (status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "text/html", ...headers });
    res.end(body);
  };

  if (url.pathname === "/login" && req.method === "POST") {
    const params = new URLSearchParams(await readBody(req));
    const email = params.get("email");
    const password = params.get("password");
    if (email === "alice@example.com" && password === "secret") {
      const user = encodeURIComponent("alice");
      return html(200, dashboard("alice"), { "set-cookie": `sid=${user}; Path=/` });
    }
    return html(200, loginForm("Invalid credentials"));
  }

  const routes = {
    "/": () => html(200, home()),
    "/login": () => html(200, loginForm()),
    "/products": () => html(200, productList()),
    "/dashboard": () => html(200, dashboard(userFromCookie(req))),
  };
  if (routes[url.pathname]) return routes[url.pathname]();

  const pm = /^\/products\/(\w+)$/.exec(url.pathname);
  if (pm) {
    const detail = productDetail(pm[1]);
    return detail ? html(200, detail) : html(404, page("Not found", "<h1>404</h1>"));
  }
  html(404, page("Not found", "<h1>404</h1>"));
}

export async function startServer() {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500);
      res.end("error");
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}
