//! Synthetic screenshots for turbo-surf: turn an HTML **snapshot** into a PNG or
//! SVG image with no browser and no rendering surface of our own.
//!
//! The engine borrows turbo-html2pdf's native HTML/CSS **layout** (block/inline/
//! flex/table + real font shaping over bundled faces) to turn a raw HTML string
//! into a positioned [`Fragment`] display list, then paints that list two ways:
//! a raster [`paint_png`] (tiny-skia) and a vector [`paint_svg`]. Both walk the
//! same fragments in document order, so they agree.
//!
//! This is a *reasonably representative* render, not a pixel-faithful browser:
//! there is no stacking-context/z-index model (fragments paint in DOM order), no
//! JS-driven visual state beyond whatever produced the snapshot, and `<img>`
//! bytes are drawn as neutral placeholders (layout has their box, not their
//! pixels). It runs only when asked — never on the fetch/extract hot path.
//!
//! Because the input is just an HTML string, any snapshot works: the initial
//! fetch, or any entry in a hydration trail.

mod glyph;
mod paint_png;
mod paint_svg;
mod style_extract;

use turbo_html2pdf_core::text::FontRegistry;
use turbo_html2pdf_core::{layout_html, Diagnostics, Fragment};

/// The layout viewport a snapshot is rendered against. `width` drives CSS layout
/// (line wrapping, `%` widths); the image is `width × height` px and content
/// past the bottom edge is clipped, matching a browser viewport screenshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

impl Viewport {
    /// A common desktop default (overridable per call / per session).
    pub const DEFAULT: Viewport = Viewport {
        width: 1280,
        height: 800,
    };
}

impl Default for Viewport {
    fn default() -> Self {
        Viewport::DEFAULT
    }
}

/// Output encoding for a screenshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Png,
    Svg,
}

/// Lay `html` out at `viewport` and paint it into a PNG. Returns encoded bytes.
pub fn screenshot_png(html: &str, viewport: Viewport) -> Result<Vec<u8>, String> {
    let galley = lay_out(html, viewport.width)?;
    paint_png::paint(&galley, viewport.width, viewport.height)
}

/// Lay `html` out at `viewport` and paint it into a standalone SVG document.
pub fn screenshot_svg(html: &str, viewport: Viewport) -> Result<String, String> {
    let galley = lay_out(html, viewport.width)?;
    Ok(paint_svg::paint(&galley, viewport.width, viewport.height))
}

/// Dispatch by [`Format`]; SVG bytes are UTF-8 of the document.
pub fn screenshot(html: &str, viewport: Viewport, format: Format) -> Result<Vec<u8>, String> {
    match format {
        Format::Png => screenshot_png(html, viewport),
        Format::Svg => screenshot_svg(html, viewport).map(String::into_bytes),
    }
}

/// Drive the borrowed layout engine: recover the page's own `<style>` sheets
/// (html5ever drops `<head>`, so we scrape them from the raw source) and lay the
/// body out at content width `width` over the bundled font set.
fn lay_out(html: &str, width: u32) -> Result<Fragment, String> {
    let author_css = style_extract::collect_style_blocks(html);
    let mut diags = Diagnostics::default();
    layout_html(
        html,
        &author_css,
        width as f32,
        &FontRegistry::new(),
        &mut diags,
    )
    .map_err(|e| format!("layout failed: {e}"))
}
