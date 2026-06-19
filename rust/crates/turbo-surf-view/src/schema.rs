//! Structured extraction (port of `src/schema.mjs`, SPEC §7.4). Read a typed
//! object out of the page by a selector-bound schema — the "give me name, price,
//! rating" path that skips the click dance. Scoped (relative) selectors resolve
//! against the matched container via turbo-dom `NodeRef`.
//!
//! The JS `transform` hook (an arbitrary function) is intentionally omitted —
//! Rust callers compose post-processing over the returned `serde_json::Value`.

use serde_json::{Map, Value};
use std::collections::BTreeMap;
use turbo_dom_parser::rtdom::serialize::serialize_inner;
use turbo_dom_parser::rtdom::{DocumentExt, NodeRef, Tree};
use turbo_surf_core::url::resolve;

const URL_ATTRS: &[&str] = &["href", "src", "action", "poster", "data-src"];

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub enum FieldType {
    #[default]
    String,
    Number,
    Boolean,
}

/// A schema field. `selector` is relative to the container (None = the container
/// itself). `attr`: None/"text" → text, "html" → innerHTML, else an attribute
/// (url-bearing attrs are absolutized). `fields` makes it a nested object;
/// `list` makes it an array.
#[derive(Clone, Debug, Default)]
pub struct Field {
    pub selector: Option<String>,
    pub attr: Option<String>,
    pub ftype: FieldType,
    pub list: bool,
    pub fields: Option<BTreeMap<String, Field>>,
}

fn coerce(raw: Option<String>, ty: FieldType) -> Value {
    let Some(v) = raw else { return Value::Null };
    match ty {
        FieldType::Number => coerce_number(&v),
        FieldType::Boolean => Value::Bool(!v.is_empty()),
        FieldType::String => Value::String(v),
    }
}

fn coerce_number(v: &str) -> Value {
    let filtered: String = v
        .chars()
        .filter(|c| c.is_ascii_digit() || matches!(c, '.' | '+' | '-'))
        .collect();
    match filtered.parse::<f64>() {
        Ok(n) => serde_json::Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

fn collapse_text(node: &NodeRef) -> String {
    node.text_content()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn read_attr(node: &NodeRef, attr: &str, base: &str) -> Option<String> {
    let raw = node.get_attribute(attr)?;
    if URL_ATTRS.contains(&attr) {
        Some(resolve(base, raw).unwrap_or_else(|| raw.to_string()))
    } else {
        Some(raw.to_string())
    }
}

fn read_node(tree: &Tree, node: &NodeRef, spec: &Field, base: &str) -> Value {
    let attr = spec.attr.as_deref().unwrap_or("text");
    let raw = match attr {
        "text" => Some(collapse_text(node)),
        "html" => Some(serialize_inner(tree, node.handle())),
        other => read_attr(node, other, base),
    };
    coerce(raw, spec.ftype)
}

// scoped first match: relative selector against `root`, or `root` itself.
fn first<'a>(root: &NodeRef<'a>, spec: &Field) -> Option<NodeRef<'a>> {
    match &spec.selector {
        Some(sel) => root.query_selector(sel),
        None => Some(*root),
    }
}

fn extract_scalar(tree: &Tree, root: &NodeRef, spec: &Field, base: &str) -> Value {
    match first(root, spec) {
        Some(el) => read_node(tree, &el, spec, base),
        None => Value::Null,
    }
}

fn extract_scalar_list(tree: &Tree, root: &NodeRef, spec: &Field, base: &str) -> Value {
    let sel = spec.selector.as_deref().unwrap_or("*");
    let items = root
        .query_selector_all(sel)
        .iter()
        .map(|el| read_node(tree, el, spec, base))
        .collect();
    Value::Array(items)
}

fn extract_object_list(tree: &Tree, root: &NodeRef, spec: &Field, base: &str) -> Value {
    let fields = spec.fields.as_ref().unwrap();
    let items: Vec<Value> = match &spec.selector {
        Some(sel) => root
            .query_selector_all(sel)
            .iter()
            .map(|el| extract_object(tree, el, fields, base))
            .collect(),
        None => vec![extract_object(tree, root, fields, base)],
    };
    Value::Array(items)
}

fn extract_nested_object(tree: &Tree, root: &NodeRef, spec: &Field, base: &str) -> Value {
    let fields = spec.fields.as_ref().unwrap();
    match first(root, spec) {
        Some(container) => extract_object(tree, &container, fields, base),
        None => Value::Null,
    }
}

fn extract_field(tree: &Tree, root: &NodeRef, spec: &Field, base: &str) -> Value {
    match (spec.fields.is_some(), spec.list) {
        (true, true) => extract_object_list(tree, root, spec, base),
        (true, false) => extract_nested_object(tree, root, spec, base),
        (false, true) => extract_scalar_list(tree, root, spec, base),
        (false, false) => extract_scalar(tree, root, spec, base),
    }
}

fn extract_object(
    tree: &Tree,
    root: &NodeRef,
    fields: &BTreeMap<String, Field>,
    base: &str,
) -> Value {
    let mut obj = Map::new();
    for (key, spec) in fields {
        obj.insert(key.clone(), extract_field(tree, root, spec, base));
    }
    Value::Object(obj)
}

/// Extract a typed object from the document per `schema`.
pub fn extract_schema(tree: &Tree, schema: &BTreeMap<String, Field>, base: &str) -> Value {
    let root = tree.document();
    extract_object(tree, &root, schema, base)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(selector: &str) -> Field {
        Field {
            selector: Some(selector.to_string()),
            ..Default::default()
        }
    }

    fn schema(pairs: Vec<(&str, Field)>) -> BTreeMap<String, Field> {
        pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }

    const BASE: &str = "https://x.test/";

    #[test]
    fn scalar_text_number_and_url() {
        let tree = Tree::parse(
            "<h1>Widget</h1><span class='p'>$ 19.99</span><a class='l' href='/buy'>buy</a>",
        );
        let s = schema(vec![
            ("name", field("h1")),
            (
                "price",
                Field {
                    selector: Some(".p".into()),
                    ftype: FieldType::Number,
                    ..Default::default()
                },
            ),
            (
                "link",
                Field {
                    selector: Some(".l".into()),
                    attr: Some("href".into()),
                    ..Default::default()
                },
            ),
        ]);
        let v = extract_schema(&tree, &s, BASE);
        assert_eq!(v["name"], Value::String("Widget".into()));
        assert_eq!(v["price"], serde_json::json!(19.99));
        assert_eq!(v["link"], Value::String("https://x.test/buy".into()));
    }

    #[test]
    fn missing_selector_is_null() {
        let tree = Tree::parse("<p>x</p>");
        let s = schema(vec![("gone", field(".nope"))]);
        assert_eq!(extract_schema(&tree, &s, BASE)["gone"], Value::Null);
    }

    #[test]
    fn scalar_list() {
        let tree = Tree::parse("<ul><li>a</li><li>b</li><li>c</li></ul>");
        let s = schema(vec![(
            "items",
            Field {
                selector: Some("li".into()),
                list: true,
                ..Default::default()
            },
        )]);
        assert_eq!(
            extract_schema(&tree, &s, BASE)["items"],
            serde_json::json!(["a", "b", "c"])
        );
    }

    #[test]
    fn object_list_with_nested_scoped_fields() {
        let tree = Tree::parse(
            "<div class='card'><h2>One</h2><span class='q'>10</span></div>
             <div class='card'><h2>Two</h2><span class='q'>20</span></div>",
        );
        let inner = schema(vec![
            ("title", field("h2")),
            (
                "qty",
                Field {
                    selector: Some(".q".into()),
                    ftype: FieldType::Number,
                    ..Default::default()
                },
            ),
        ]);
        let s = schema(vec![(
            "cards",
            Field {
                selector: Some(".card".into()),
                list: true,
                fields: Some(inner),
                ..Default::default()
            },
        )]);
        let v = extract_schema(&tree, &s, BASE);
        assert_eq!(v["cards"][0]["title"], Value::String("One".into()));
        assert_eq!(v["cards"][1]["qty"], serde_json::json!(20.0));
    }

    #[test]
    fn nested_single_object_and_html_attr() {
        let tree = Tree::parse("<div id='box'><b>bold</b></div>");
        let inner = schema(vec![(
            "raw",
            Field {
                attr: Some("html".into()),
                ..Default::default()
            },
        )]);
        let s = schema(vec![(
            "box",
            Field {
                selector: Some("#box".into()),
                fields: Some(inner),
                ..Default::default()
            },
        )]);
        let v = extract_schema(&tree, &s, BASE);
        assert!(v["box"]["raw"].as_str().unwrap().contains("<b>bold</b>"));
    }

    #[test]
    fn boolean_and_bad_number() {
        let tree = Tree::parse("<span class='b'>yes</span><span class='n'>n/a</span>");
        let s = schema(vec![
            (
                "flag",
                Field {
                    selector: Some(".b".into()),
                    ftype: FieldType::Boolean,
                    ..Default::default()
                },
            ),
            (
                "num",
                Field {
                    selector: Some(".n".into()),
                    ftype: FieldType::Number,
                    ..Default::default()
                },
            ),
        ]);
        let v = extract_schema(&tree, &s, BASE);
        assert_eq!(v["flag"], Value::Bool(true));
        assert_eq!(v["num"], Value::Null); // "n/a" → no digits → null
    }

    #[test]
    fn non_url_attribute_read_verbatim() {
        let tree = Tree::parse("<div data-id='abc'>x</div>");
        let s = schema(vec![(
            "id",
            Field {
                selector: Some("div".into()),
                attr: Some("data-id".into()),
                ..Default::default()
            },
        )]);
        assert_eq!(
            extract_schema(&tree, &s, BASE)["id"],
            Value::String("abc".into())
        );
    }

    #[test]
    fn object_list_without_selector_wraps_root() {
        let tree = Tree::parse("<h1>Solo</h1>");
        let inner = schema(vec![("title", field("h1"))]);
        let s = schema(vec![(
            "all",
            Field {
                selector: None, // no selector → single object over the root
                list: true,
                fields: Some(inner),
                ..Default::default()
            },
        )]);
        let v = extract_schema(&tree, &s, BASE);
        assert_eq!(v["all"][0]["title"], Value::String("Solo".into()));
    }

    #[test]
    fn missing_nested_container_is_null() {
        let tree = Tree::parse("<p>x</p>");
        let inner = schema(vec![("t", field("h2"))]);
        let s = schema(vec![(
            "box",
            Field {
                selector: Some("#nope".into()),
                fields: Some(inner),
                ..Default::default()
            },
        )]);
        assert_eq!(extract_schema(&tree, &s, BASE)["box"], Value::Null);
    }
}
