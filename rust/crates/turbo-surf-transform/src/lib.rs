//! swc transform (G14): compile TS / JSX (and modern ESM syntax) down to classic
//! JS that the deno_core render tier can evaluate. The render tier runs classic
//! scripts; this lets a page bundle written in TS/JSX run unchanged.
//!
//! `transform(src, ts, jsx)` → emitted JS, or `Err` on a parse error.

use swc_core::common::comments::SingleThreadedComments;
use swc_core::common::sync::Lrc;
use swc_core::common::{FileName, Globals, Mark, SourceMap, GLOBALS};
use swc_core::ecma::ast::Pass;
use swc_core::ecma::ast::Program;
use swc_core::ecma::codegen::text_writer::JsWriter;
use swc_core::ecma::codegen::Emitter;
use swc_core::ecma::parser::{lexer::Lexer, EsSyntax, Parser, StringInput, Syntax, TsSyntax};
use swc_core::ecma::transforms::base::resolver;
use swc_core::ecma::transforms::react::{react, Options as ReactOptions};
use swc_core::ecma::transforms::typescript::strip;

fn syntax(ts: bool, jsx: bool) -> Syntax {
    if ts {
        Syntax::Typescript(TsSyntax {
            tsx: jsx,
            ..Default::default()
        })
    } else {
        Syntax::Es(EsSyntax {
            jsx,
            ..Default::default()
        })
    }
}

/// Transform `src` (TS when `ts`, JSX when `jsx`) into classic JS.
pub fn transform(src: &str, ts: bool, jsx: bool) -> Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let comments = SingleThreadedComments::default();
    let fm = cm.new_source_file(Lrc::new(FileName::Anon), src.to_string());

    let lexer = Lexer::new(
        syntax(ts, jsx),
        Default::default(),
        StringInput::from(&*fm),
        Some(&comments),
    );
    let mut parser = Parser::new_from(lexer);
    let program = parser
        .parse_program()
        .map_err(|e| format!("parse error: {e:?}"))?;

    GLOBALS.set(&Globals::new(), || {
        let unresolved = Mark::new();
        let top_level = Mark::new();
        let mut program: Program = program;
        resolver(unresolved, top_level, ts).process(&mut program);
        if ts {
            strip(unresolved, top_level).process(&mut program);
        }
        if jsx {
            react(
                cm.clone(),
                Some(&comments),
                ReactOptions::default(),
                top_level,
                unresolved,
            )
            .process(&mut program);
        }
        emit(&cm, &program)
    })
}

fn emit(cm: &Lrc<SourceMap>, program: &Program) -> Result<String, String> {
    let mut buf = Vec::new();
    {
        let writer = JsWriter::new(cm.clone(), "\n", &mut buf, None);
        let mut emitter = Emitter {
            cfg: Default::default(),
            cm: cm.clone(),
            comments: None,
            wr: writer,
        };
        emitter
            .emit_program(program)
            .map_err(|e| format!("codegen error: {e}"))?;
    }
    String::from_utf8(buf).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_typescript_types() {
        let out = transform(
            "const x: number = 1; function f(a: string): void {}",
            true,
            false,
        )
        .unwrap();
        assert!(!out.contains(": number"), "types stripped: {out}");
        assert!(out.contains("const x = 1"), "got: {out}");
    }

    #[test]
    fn compiles_jsx() {
        let out = transform("const el = <div className='a'>hi</div>;", false, true).unwrap();
        // JSX → React.createElement(...)
        assert!(out.contains("createElement"), "got: {out}");
    }

    #[test]
    fn plain_js_passes_through() {
        let out = transform("const y = 2 + 2;", false, false).unwrap();
        assert!(out.contains("const y"), "got: {out}");
    }

    #[test]
    fn parse_error_surfaces() {
        assert!(transform("const = ;", false, false).is_err());
    }
}
