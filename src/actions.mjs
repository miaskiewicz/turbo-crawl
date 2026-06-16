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

// Selected <option> [name,value] pairs for a <select> control.
function selectPairs(el, name) {
  const out = [];
  const opts = el.querySelectorAll("option");
  for (let j = 0; j < opts.length; j++) {
    if (opts[j].selected) {
      out.push([name, opts[j].getAttribute("value") ?? opts[j].textContent.trim()]);
    }
  }
  return out;
}

function isSubmitControl(tag, type) {
  return tag === "button" || (tag === "input" && SUBMIT_TYPES.has(type));
}

function isCheckable(tag, type) {
  return tag === "input" && (type === "checkbox" || type === "radio");
}

// [name,value] pairs for a typed (non-submit/non-select) control.
function typedPairs(el, name, tag, type) {
  if (isCheckable(tag, type)) {
    return el.checked ? [[name, el.getAttribute("value") ?? "on"]] : [];
  }
  if (tag === "select") return selectPairs(el, name);
  return [[name, controlValue(el)]];
}

// Classify one control into its successful [name,value] pairs (possibly none).
// Mirrors the HTML successful-controls rules; `submitter` is the activated button.
function controlPairs(el, submitter) {
  const name = el.getAttribute("name");
  if (!name || el.getAttribute("disabled") !== null) return [];

  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute("type")?.toLowerCase();

  if (isSubmitControl(tag, type)) {
    // Only the activated submitter is successful.
    return el === submitter ? [[name, controlValue(el)]] : [];
  }
  return typedPairs(el, name, tag, type);
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
    for (const pair of controlPairs(controls[i], submitter)) pairs.push(pair);
  }
  return pairs;
}

/**
 * Build the navigation a form submit produces.
 * @returns {{ method:"GET"|"POST", url:string, body?:string, contentType?:string }}
 */
function buildGet(actionUrl, params) {
  const u = new URL(actionUrl);
  u.search = params.toString();
  return { method: "GET", url: u.href };
}

function buildPost(actionUrl, params) {
  return {
    method: "POST",
    url: actionUrl,
    body: params.toString(),
    contentType: "application/x-www-form-urlencoded",
  };
}

function formMethod(form) {
  return (form.getAttribute("method") || "GET").toUpperCase() === "POST" ? "POST" : "GET";
}

function formActionUrl(form, baseUrl) {
  return resolve(baseUrl, form.getAttribute("action") ?? "") ?? baseUrl;
}

export function buildSubmission(form, baseUrl, submitter) {
  const actionUrl = formActionUrl(form, baseUrl);
  const params = new URLSearchParams(serializeForm(form, submitter));

  return formMethod(form) === "POST" ? buildPost(actionUrl, params) : buildGet(actionUrl, params);
}
