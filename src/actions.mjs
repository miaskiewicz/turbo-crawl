// Interaction = link/form graph traversal (SPEC §6). No JS runs, so we resolve
// the page's *intent graph* rather than firing synthetic events:
//   - <a href>            → navigate to the resolved URL
//   - <form action method> → serialize successful controls, navigate (GET=query, POST=body)
//   - everything else      → inert in Lane A (flagged jsHandler upstream)
//
// These are pure helpers over turbo-dom nodes; Page wires them to its navigation.

import { resolve } from "./url.mjs";

const SUBMIT_TYPES = new Set(["submit", "button", "reset", "image"]);

/** Set a control's live value (and checked state for checkbox/radio). */
export function fillValue(el, value) {
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute("type")?.toLowerCase();
  if (tag === "input" && (type === "checkbox" || type === "radio")) {
    el.checked = Boolean(value);
    return;
  }
  el.value = value == null ? "" : String(value);
}

// Per-control current value: prefer the live `.value` property (reflects fill()),
// fall back to the attribute for elements whose property turbo-dom leaves unset.
function controlValue(el) {
  const v = el.value;
  if (v !== undefined && v !== null) return String(v);
  return el.getAttribute("value") ?? "";
}

/**
 * Collect a form's *successful controls* (HTML form-submission subset) as
 * [name, value] pairs. `submitter` (the activated submit button), if given and
 * named, contributes its name/value.
 */
export function serializeForm(form, submitter) {
  const pairs = [];
  const controls = form.elements ?? form.querySelectorAll("input,select,textarea,button");
  for (let i = 0; i < controls.length; i++) {
    const el = controls[i];
    const name = el.getAttribute("name");
    if (!name) continue;
    if (el.getAttribute("disabled") !== null) continue;

    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type")?.toLowerCase();

    if (tag === "button" || (tag === "input" && SUBMIT_TYPES.has(type))) {
      // Only the activated submitter is successful.
      if (el === submitter) pairs.push([name, controlValue(el)]);
      continue;
    }
    if (tag === "input" && (type === "checkbox" || type === "radio")) {
      if (el.checked) pairs.push([name, el.getAttribute("value") ?? "on"]);
      continue;
    }
    if (tag === "select") {
      const opts = el.querySelectorAll("option");
      for (let j = 0; j < opts.length; j++) {
        if (opts[j].selected) {
          pairs.push([name, opts[j].getAttribute("value") ?? opts[j].textContent.trim()]);
        }
      }
      continue;
    }
    pairs.push([name, controlValue(el)]);
  }
  return pairs;
}

/**
 * Build the navigation a form submit produces.
 * @returns {{ method:"GET"|"POST", url:string, body?:string, contentType?:string }}
 */
export function buildSubmission(form, baseUrl, submitter) {
  const method = (form.getAttribute("method") || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const action = form.getAttribute("action");
  const actionUrl = resolve(baseUrl, action ?? "") ?? baseUrl;
  const params = new URLSearchParams(serializeForm(form, submitter));

  if (method === "GET") {
    const u = new URL(actionUrl);
    u.search = params.toString();
    return { method, url: u.href };
  }
  return {
    method,
    url: actionUrl,
    body: params.toString(),
    contentType: "application/x-www-form-urlencoded",
  };
}
