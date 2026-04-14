// CV module — derived view over vault_info + documents + work_history.
//
// Responsibilities:
//   1. build_cv_data(conn): reads the vault and returns a structured CvData
//      for the in-app CV view (serialized to JSON for the frontend).
//   2. render_cv_docx(data, path): writes a minimal valid .docx to the given
//      path, containing personal details, grouped certificates, and work
//      history as Word tables/paragraphs.
//
// The .docx is hand-crafted via the existing `zip` crate — no new dependency.
// A minimal docx only needs four files inside the zip:
//   [Content_Types].xml
//   _rels/.rels
//   word/document.xml
//   word/_rels/document.xml.rels
//
// Word opens this happily and shows our content with default formatting.

use crate::db;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Write;
use std::path::Path;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CvPersonal {
    pub name: String,
    pub rank: Option<String>,
    pub stcw_level: Option<String>,
    pub vessel_type: Option<String>,
    // Extended personal details (stored in vault_info as `personal_*` keys).
    // Used by the generated PDF CV to fill in the employment-application style form.
    pub surname: Option<String>,
    pub first_name: Option<String>,
    pub date_of_birth: Option<String>,
    pub place_of_birth: Option<String>,
    pub nationality: Option<String>,
    pub home_address: Option<String>,
    pub phones: Option<String>,
    pub nearest_airport: Option<String>,
    pub nearest_intl_airport: Option<String>,
    pub available_from: Option<String>,
    pub email: Option<String>,
    /// Path (relative to the vault root) to the seafarer photo if uploaded.
    pub photo_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CvCertificate {
    pub title: String,
    pub category: String,
    pub doc_number: Option<String>,
    pub issued_by: Option<String>,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub regulatory_basis: Option<String>,
    pub status: String, // "valid" | "warning" | "expired" | "none"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CvWorkEntry {
    pub vessel_name: String,
    pub vessel_type: Option<String>,
    pub imo: Option<String>,
    pub flag: Option<String>,
    pub company: Option<String>,
    pub position: String,
    pub sign_on: Option<String>,
    pub sign_off: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CvData {
    pub personal: CvPersonal,
    pub certificates: Vec<CvCertificate>,
    pub work_history: Vec<CvWorkEntry>,
    /// Days of sea time derived from work_history (rough: sum of sign_off - sign_on).
    pub total_sea_days: i64,
}

// -------- Build from DB ------------------------------------------------------

/// Classify a document by expiry relative to today:
///   - "none"     — no file and no valid_to set
///   - "expired"  — valid_to < today
///   - "warning"  — valid_to within 90 days
///   - "valid"    — valid_to > 90 days away or no expiry on a filled doc
fn classify_status(valid_to: Option<&str>, has_file: bool) -> String {
    use chrono::{Duration, NaiveDate, Utc};
    if valid_to.is_none() && !has_file {
        return "none".to_string();
    }
    let today = Utc::now().date_naive();
    match valid_to.and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()) {
        Some(d) => {
            if d < today {
                "expired".to_string()
            } else if d - today < Duration::days(90) {
                "warning".to_string()
            } else {
                "valid".to_string()
            }
        }
        None => "valid".to_string(),
    }
}

/// Assemble the CV data structure from an open DB connection.
pub fn build_cv_data(conn: &Connection) -> Result<CvData, String> {
    let info = db::get_vault_info(conn).map_err(|e| e.to_string())?;

    let p = |k: &str| db::get_vault_info_value(conn, k);
    let personal = CvPersonal {
        name: if info.name.is_empty() { "Seafarer".to_string() } else { info.name },
        rank: p("personal_rank").or(info.rank),
        stcw_level: p("stcw_level").map(|s| match s.as_str() {
            "support" => "Support".to_string(),
            "operational" => "Operational".to_string(),
            "management" => "Management".to_string(),
            other => other.to_string(),
        }),
        vessel_type: info.vessel_type,
        surname: p("personal_surname"),
        first_name: p("personal_first_name"),
        date_of_birth: p("personal_dob"),
        place_of_birth: p("personal_place_of_birth"),
        nationality: p("personal_nationality"),
        home_address: p("personal_home_address"),
        phones: p("personal_phones"),
        nearest_airport: p("personal_nearest_airport"),
        nearest_intl_airport: p("personal_nearest_intl_airport"),
        available_from: p("personal_available_from"),
        email: p("personal_email"),
        photo_path: p("personal_photo_path"),
    };

    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let certificates: Vec<CvCertificate> = docs
        .iter()
        // A CV should only show documents the seafarer actually has.
        // Skip truly empty slots (no file AND no metadata at all).
        .filter(|d| {
            d.file_name.is_some()
                || d.doc_number.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                || d.valid_to.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
        })
        .map(|d| CvCertificate {
            title: d.title.clone(),
            category: d.category.clone(),
            doc_number: d.doc_number.clone(),
            issued_by: d.issued_by.clone(),
            valid_from: d.valid_from.clone(),
            valid_to: d.valid_to.clone(),
            regulatory_basis: d.regulatory_basis.clone(),
            status: classify_status(d.valid_to.as_deref(), d.file_name.is_some()),
        })
        .collect();

    // get_work_history returns JSON values — unpack them into typed entries.
    let work_history: Vec<CvWorkEntry> = db::get_work_history(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|w| {
            let s = |k: &str| w.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
            let s_req = |k: &str| s(k).unwrap_or_default();
            CvWorkEntry {
                vessel_name: s_req("vessel_name"),
                vessel_type: s("vessel_type"),
                imo: s("imo"),
                flag: s("flag"),
                company: s("company"),
                position: s_req("position"),
                sign_on: s("sign_on"),
                sign_off: s("sign_off"),
            }
        })
        .collect();

    // Compute total sea days: rough sum of (sign_off - sign_on) across entries.
    let total_sea_days: i64 = {
        use chrono::NaiveDate;
        work_history
            .iter()
            .map(|w| {
                let on = w.sign_on.as_deref().and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok());
                let off = w.sign_off.as_deref().and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok());
                match (on, off) {
                    (Some(a), Some(b)) if b > a => (b - a).num_days(),
                    _ => 0,
                }
            })
            .sum()
    };

    Ok(CvData {
        personal,
        certificates,
        work_history,
        total_sea_days,
    })
}

// -------- DOCX generation ----------------------------------------------------

/// XML-escape a text run before embedding in Word XML.
fn x(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Build a Word paragraph with a single run. Optional bold + font size (half-points).
fn para(text: &str, bold: bool, size_half_pt: u32) -> String {
    let rpr = format!(
        "<w:rPr>{}{}</w:rPr>",
        if bold { "<w:b/>" } else { "" },
        if size_half_pt > 0 {
            format!("<w:sz w:val=\"{}\"/><w:szCs w:val=\"{}\"/>", size_half_pt, size_half_pt)
        } else {
            String::new()
        },
    );
    format!(
        "<w:p><w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        rpr,
        x(text)
    )
}

/// Empty spacer paragraph.
fn spacer() -> &'static str {
    "<w:p/>"
}

/// Section heading paragraph (bold, 14pt, pilcrow marker).
fn heading(text: &str) -> String {
    para(text, true, 28)
}

/// Generate the word/document.xml body XML from CvData.
fn build_document_xml(data: &CvData) -> String {
    let mut body = String::new();

    // Title
    body.push_str(&para(&data.personal.name, true, 40));
    body.push_str(&para("Seafarer CV", false, 22));
    body.push_str(spacer());

    // Personal info
    body.push_str(&heading("Personal details"));
    if let Some(ref r) = data.personal.rank {
        body.push_str(&para(&format!("Rank: {}", r), false, 22));
    }
    if let Some(ref l) = data.personal.stcw_level {
        body.push_str(&para(&format!("STCW level: {}", l), false, 22));
    }
    if let Some(ref v) = data.personal.vessel_type {
        body.push_str(&para(&format!("Vessel experience: {}", v), false, 22));
    }
    if data.total_sea_days > 0 {
        body.push_str(&para(
            &format!("Total recorded sea time: {} days", data.total_sea_days),
            false,
            22,
        ));
    }
    body.push_str(spacer());

    // Certificates — grouped by category for readability.
    body.push_str(&heading("Certificates & qualifications"));
    let mut by_cat: std::collections::BTreeMap<&str, Vec<&CvCertificate>> =
        std::collections::BTreeMap::new();
    for c in &data.certificates {
        by_cat.entry(c.category.as_str()).or_default().push(c);
    }
    for (cat, certs) in &by_cat {
        body.push_str(&para(cat, true, 24));
        for c in certs {
            let mut line = c.title.clone();
            if let Some(ref n) = c.doc_number {
                if !n.is_empty() {
                    line.push_str(&format!(" — №{}", n));
                }
            }
            if let Some(ref to) = c.valid_to {
                if !to.is_empty() {
                    line.push_str(&format!(" (valid until {})", to));
                }
            }
            let status_suffix = match c.status.as_str() {
                "expired" => "  [EXPIRED]",
                "warning" => "  [EXPIRING SOON]",
                _ => "",
            };
            if !status_suffix.is_empty() {
                line.push_str(status_suffix);
            }
            body.push_str(&para(&format!("  • {}", line), false, 22));
            if let Some(ref reg) = c.regulatory_basis {
                if !reg.is_empty() {
                    body.push_str(&para(&format!("      {}", reg), false, 18));
                }
            }
        }
    }
    if data.certificates.is_empty() {
        body.push_str(&para("(no certificates on file)", false, 22));
    }
    body.push_str(spacer());

    // Work history
    body.push_str(&heading("Sea-going experience"));
    if data.work_history.is_empty() {
        body.push_str(&para("(no work history recorded)", false, 22));
    } else {
        for w in &data.work_history {
            let period = match (&w.sign_on, &w.sign_off) {
                (Some(on), Some(off)) => format!("{} — {}", on, off),
                (Some(on), None) => format!("{} — present", on),
                _ => "dates unknown".to_string(),
            };
            body.push_str(&para(
                &format!("{} — {}", w.vessel_name, w.position),
                true,
                22,
            ));
            let mut line2 = period;
            if let Some(ref t) = w.vessel_type {
                if !t.is_empty() {
                    line2.push_str(&format!("  ·  {}", t));
                }
            }
            if let Some(ref f) = w.flag {
                if !f.is_empty() {
                    line2.push_str(&format!("  ·  flag {}", f));
                }
            }
            if let Some(ref imo) = w.imo {
                if !imo.is_empty() {
                    line2.push_str(&format!("  ·  IMO {}", imo));
                }
            }
            body.push_str(&para(&line2, false, 20));
            if let Some(ref c) = w.company {
                if !c.is_empty() {
                    body.push_str(&para(&format!("  {}", c), false, 20));
                }
            }
        }
    }
    body.push_str(spacer());

    // Footer
    body.push_str(&para(
        "Generated by Skipi — local-first maritime document management.",
        false,
        16,
    ));

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>{}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>"#,
        body
    )
}

/// Render the full CV as a .docx file at the given path.
/// Creates a minimal valid Word document containing all four required parts
/// inside a zip container.
pub fn render_cv_docx(data: &CvData, path: &Path) -> Result<(), String> {
    let file = File::create(path).map_err(|e| format!("Cannot create file: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // 1. [Content_Types].xml — tells Word what MIME types are inside
    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;
    zip.start_file("[Content_Types].xml", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(content_types.as_bytes())
        .map_err(|e| e.to_string())?;

    // 2. _rels/.rels — package root relationships
    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;
    zip.start_file("_rels/.rels", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(root_rels.as_bytes())
        .map_err(|e| e.to_string())?;

    // 3. word/_rels/document.xml.rels — document-level relationships (empty is fine)
    let doc_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>"#;
    zip.start_file("word/_rels/document.xml.rels", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(doc_rels.as_bytes())
        .map_err(|e| e.to_string())?;

    // 4. word/document.xml — the actual body
    let doc_xml = build_document_xml(data);
    zip.start_file("word/document.xml", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(doc_xml.as_bytes())
        .map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

// -------- PDF generation (printpdf) ------------------------------------------
//
// The PDF is modelled on a seafarer employment-application form. A4, portrait,
// built-in Helvetica font (no external fonts — keeps the binary tiny and avoids
// a font-file asset bundle). Layout is grid-based with labels in a lighter
// weight and values in regular. Sections: header strip, Personal Details,
// Documents summary, Certificates table, Sea Service table.

// Note: printpdf 0.7 uses `Mm(pub f32)`, so we cast at the wrapping sites.
// Helper signatures stay `f64` to minimise churn in call sites throughout
// this module. Drawing primitives in 0.7 are `Line` (stroke-only, via
// `add_line`) and `Polygon { rings, mode, winding_order }` (fill or
// stroke, via `add_polygon`).
use printpdf::{
    BuiltinFont, Color, Image, ImageTransform, IndirectFontRef, Line, Mm, PdfDocument,
    PdfDocumentReference, PdfLayerReference, Point, Polygon, Rgb,
};
// PaintMode + WindingOrder live under the `path` module in printpdf 0.7.
use printpdf::path::{PaintMode, WindingOrder};

/// Build a closed quadrilateral ring in mm for rectangular shapes.
fn rect_ring(x: f64, y: f64, w: f64, h: f64) -> Vec<(Point, bool)> {
    vec![
        (Point::new(Mm(x as f32), Mm(y as f32)), false),
        (Point::new(Mm((x + w) as f32), Mm(y as f32)), false),
        (Point::new(Mm((x + w) as f32), Mm((y + h) as f32)), false),
        (Point::new(Mm(x as f32), Mm((y + h) as f32)), false),
    ]
}

/// Draw a filled rectangle at (x, y) with width `w` and height `h` (all in mm).
fn pdf_fill_rect(layer: &PdfLayerReference, x: f64, y: f64, w: f64, h: f64, color: Color) {
    layer.set_fill_color(color);
    let poly = Polygon {
        rings: vec![rect_ring(x, y, w, h)],
        mode: PaintMode::Fill,
        winding_order: WindingOrder::NonZero,
    };
    layer.add_polygon(poly);
}

/// Draw a stroked rectangle (outline only).
fn pdf_stroke_rect(layer: &PdfLayerReference, x: f64, y: f64, w: f64, h: f64) {
    layer.set_outline_color(Color::Rgb(Rgb::new(0.55, 0.55, 0.6, None)));
    layer.set_outline_thickness(0.3);
    // In printpdf 0.7 `Line` is stroke-only and drawn with `add_line`.
    let line = Line {
        points: rect_ring(x, y, w, h),
        is_closed: true,
    };
    layer.add_line(line);
}

/// Write text at (x, y) in mm with the given size, font and color.
fn pdf_text(
    layer: &PdfLayerReference,
    text: &str,
    x: f64,
    y: f64,
    size: f64,
    font: &IndirectFontRef,
    color: Color,
) {
    layer.set_fill_color(color);
    // `use_text` takes `font_size: f32` in printpdf 0.7.
    layer.use_text(text, size as f32, Mm(x as f32), Mm(y as f32), font);
}

/// Truncate a string to approx `max_chars` characters, appending `…` if cut.
fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max_chars.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// Render a small two-line labelled cell: `label` in grey on top, `value` bold
/// on the second line. Draws the outline border too.
fn pdf_field(
    layer: &PdfLayerReference,
    label: &str,
    value: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    bold: &IndirectFontRef,
    reg: &IndirectFontRef,
) {
    pdf_stroke_rect(layer, x, y, w, h);
    let label_color = Color::Rgb(Rgb::new(0.45, 0.45, 0.5, None));
    let value_color = Color::Rgb(Rgb::new(0.10, 0.10, 0.12, None));
    pdf_text(layer, label, x + 1.5, y + h - 3.2, 7.0, reg, label_color);
    // Rough character budget based on width. Helvetica @9pt ≈ 1.8mm/char.
    let budget = ((w - 3.0) / 1.8).max(4.0) as usize;
    let v = truncate(value, budget);
    pdf_text(layer, &v, x + 1.5, y + 1.6, 9.0, bold, value_color);
}

fn blank(s: &Option<String>) -> &str {
    s.as_deref().filter(|v| !v.is_empty()).unwrap_or("—")
}

/// Attempt to load a JPEG/PNG photo from disk and embed it into the given
/// layer so it fits inside the box defined by (`x`, `y`, `w`, `h`) in mm.
/// Silent no-op on any failure — the outlined placeholder rectangle will then
/// remain visible on the page. We use the `image` crate to decode and scale
/// detection, then hand the DynamicImage to printpdf.
fn try_embed_photo(
    layer: &PdfLayerReference,
    photo_path: &Path,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    // Load and decode the photo. Format is inferred from the file header.
    // `image` 0.24 places the reader at `image::io::Reader` (the top-level
    // alias `image::ImageReader` only exists in 0.25+, which we cannot use
    // because printpdf 0.7 pins `image` at 0.24.x).
    let dyn_img = image::io::Reader::open(photo_path)
        .map_err(|e| format!("open photo: {}", e))?
        .with_guessed_format()
        .map_err(|e| format!("guess photo format: {}", e))?
        .decode()
        .map_err(|e| format!("decode photo: {}", e))?;

    let (px_w, px_h) = (dyn_img.width() as f64, dyn_img.height() as f64);
    if px_w <= 0.0 || px_h <= 0.0 {
        return Err("photo has zero pixel dimensions".into());
    }

    // DPI inside printpdf is 300 by default. 1 mm = 300/25.4 ≈ 11.811 px.
    // For our target box in mm we compute the scale factor that lets the
    // image fit entirely, letterboxing if the aspect ratio differs.
    let dpi = 300.0_f64;
    let mm_per_px = 25.4 / dpi;
    let native_w_mm = px_w * mm_per_px;
    let native_h_mm = px_h * mm_per_px;
    let scale = (w / native_w_mm).min(h / native_h_mm);
    let final_w_mm = native_w_mm * scale;
    let final_h_mm = native_h_mm * scale;
    // Centre the image inside the box
    let tx = x + (w - final_w_mm) / 2.0;
    let ty = y + (h - final_h_mm) / 2.0;

    let image = Image::from_dynamic_image(&dyn_img);
    image.add_to_layer(
        layer.clone(),
        ImageTransform {
            translate_x: Some(Mm(tx as f32)),
            translate_y: Some(Mm(ty as f32)),
            scale_x: Some(scale as f32),
            scale_y: Some(scale as f32),
            dpi: Some(dpi as f32),
            ..Default::default()
        },
    );
    Ok(())
}

/// Render the CV to a PDF file using printpdf. Built-in Helvetica is used to
/// keep this dependency-light. The layout mimics the seafarer
/// employment-application form used by crewing agencies. `photo_abs_path` is
/// the resolved absolute path to the seafarer photo (JPEG or PNG) — if set and
/// the file exists, it is embedded inside the photo placeholder.
pub fn render_cv_pdf(
    data: &CvData,
    path: &Path,
    photo_abs_path: Option<&Path>,
) -> Result<(), String> {
    // A4 portrait: 210 x 297 mm. Explicit `f64` annotations keep every
    // derived dimension (`margin`, `content_w`, `cursor_y`, column widths…)
    // in `f64` so the helper call sites don't need per-argument casts.
    let page_w: f64 = 210.0;
    let page_h: f64 = 297.0;
    let (doc, page1, layer1) =
        PdfDocument::new("Seafarer CV", Mm(page_w as f32), Mm(page_h as f32), "Page 1");
    let reg = doc
        .add_builtin_font(BuiltinFont::Helvetica)
        .map_err(|e| e.to_string())?;
    let bold = doc
        .add_builtin_font(BuiltinFont::HelveticaBold)
        .map_err(|e| e.to_string())?;
    let layer = doc.get_page(page1).get_layer(layer1);

    let accent = Color::Rgb(Rgb::new(0.12, 0.25, 0.55, None));
    let grey_bg = Color::Rgb(Rgb::new(0.93, 0.94, 0.97, None));
    let white = Color::Rgb(Rgb::new(1.0, 1.0, 1.0, None));
    let dark = Color::Rgb(Rgb::new(0.10, 0.10, 0.12, None));
    let subtle = Color::Rgb(Rgb::new(0.45, 0.45, 0.5, None));

    let margin = 15.0;
    let content_w = page_w - 2.0 * margin;

    // -------- Header strip --------
    let mut cursor_y = page_h - margin - 12.0;
    pdf_fill_rect(&layer, margin, cursor_y, content_w, 12.0, accent.clone());
    pdf_text(
        &layer,
        "EMPLOYMENT APPLICATION — SEAFARER CV",
        margin + 4.0,
        cursor_y + 4.0,
        12.0,
        &bold,
        white.clone(),
    );
    cursor_y -= 2.0;

    // -------- Rank / Available / Vessel row --------
    let row_h = 10.0;
    cursor_y -= row_h;
    let col_w = content_w / 3.0;
    pdf_field(
        &layer,
        "RANK",
        blank(&data.personal.rank),
        margin,
        cursor_y,
        col_w,
        row_h,
        &bold,
        &reg,
    );
    pdf_field(
        &layer,
        "DATE AVAILABLE",
        blank(&data.personal.available_from),
        margin + col_w,
        cursor_y,
        col_w,
        row_h,
        &bold,
        &reg,
    );
    pdf_field(
        &layer,
        "VESSEL TYPE",
        blank(&data.personal.vessel_type),
        margin + col_w * 2.0,
        cursor_y,
        col_w,
        row_h,
        &bold,
        &reg,
    );
    cursor_y -= 3.0;

    // -------- Section heading: Personal details --------
    let section_h = 7.0;
    cursor_y -= section_h;
    pdf_fill_rect(&layer, margin, cursor_y, content_w, section_h, grey_bg.clone());
    pdf_text(
        &layer,
        "PERSONAL DETAILS",
        margin + 3.0,
        cursor_y + 2.0,
        9.0,
        &bold,
        accent.clone(),
    );
    cursor_y -= 1.0;

    // -------- Personal details grid (photo placeholder on the right) --------
    let photo_w = 30.0;
    let photo_h = 40.0;
    let photo_x = page_w - margin - photo_w;
    let photo_y_top = cursor_y;
    let photo_y_bottom = photo_y_top - photo_h;
    // Try to embed the real photo. On failure, draw the "PHOTO" placeholder
    // so the layout still reads as an application form.
    let mut photo_drawn = false;
    if let Some(p) = photo_abs_path {
        if p.exists() {
            if try_embed_photo(&layer, p, photo_x, photo_y_bottom, photo_w, photo_h).is_ok() {
                photo_drawn = true;
            }
        }
    }
    pdf_stroke_rect(&layer, photo_x, photo_y_bottom, photo_w, photo_h);
    if !photo_drawn {
        pdf_text(
            &layer,
            "PHOTO",
            photo_x + photo_w / 2.0 - 6.0,
            photo_y_top - photo_h / 2.0,
            8.0,
            &reg,
            subtle.clone(),
        );
    }

    let info_w = content_w - photo_w - 3.0;
    // 4 rows x 2 cols of fields for personal details
    let field_h = 9.5;
    let col_a_w = info_w * 0.5;
    let col_b_w = info_w - col_a_w;
    let col_a_x = margin;
    let col_b_x = margin + col_a_w;
    let rows: Vec<(&str, &str, &str, &str)> = vec![
        (
            "SURNAME",
            blank(&data.personal.surname),
            "FIRST NAME",
            blank(&data.personal.first_name),
        ),
        (
            "DATE OF BIRTH",
            blank(&data.personal.date_of_birth),
            "PLACE OF BIRTH",
            blank(&data.personal.place_of_birth),
        ),
        (
            "NATIONALITY",
            blank(&data.personal.nationality),
            "PHONES",
            blank(&data.personal.phones),
        ),
        (
            "NEAREST AIRPORT",
            blank(&data.personal.nearest_airport),
            "NEAREST INTL AIRPORT",
            blank(&data.personal.nearest_intl_airport),
        ),
    ];
    let mut row_y = cursor_y - field_h;
    for (la, va, lb, vb) in rows {
        pdf_field(&layer, la, va, col_a_x, row_y, col_a_w, field_h, &bold, &reg);
        pdf_field(&layer, lb, vb, col_b_x, row_y, col_b_w, field_h, &bold, &reg);
        row_y -= field_h;
    }
    // Address row — single column spanning the full info width
    pdf_field(
        &layer,
        "HOME ADDRESS",
        blank(&data.personal.home_address),
        col_a_x,
        row_y,
        info_w,
        field_h,
        &bold,
        &reg,
    );
    row_y -= field_h;
    // Email row below address
    pdf_field(
        &layer,
        "EMAIL",
        blank(&data.personal.email),
        col_a_x,
        row_y,
        info_w,
        field_h,
        &bold,
        &reg,
    );
    row_y -= field_h;

    // Advance cursor_y below whichever is lower: the personal grid or the photo.
    let photo_bottom = photo_y_top - photo_h;
    cursor_y = row_y.min(photo_bottom) - 4.0;

    // -------- Section heading: Certificates --------
    cursor_y -= section_h;
    pdf_fill_rect(&layer, margin, cursor_y, content_w, section_h, grey_bg.clone());
    pdf_text(
        &layer,
        "CERTIFICATES",
        margin + 3.0,
        cursor_y + 2.0,
        9.0,
        &bold,
        accent.clone(),
    );
    cursor_y -= 1.0;

    // -------- Certificates table --------
    // Columns: Title (flex) | Doc No | Issued | Expiry
    let cert_row_h = 6.5;
    let col_title = content_w * 0.52;
    let col_no = content_w * 0.15;
    let col_issued = content_w * 0.16;
    let _col_expiry = content_w - col_title - col_no - col_issued;
    // Header row
    cursor_y -= cert_row_h;
    pdf_fill_rect(&layer, margin, cursor_y, content_w, cert_row_h, Color::Rgb(Rgb::new(0.85, 0.88, 0.94, None)));
    pdf_text(&layer, "TITLE", margin + 2.0, cursor_y + 2.0, 7.5, &bold, dark.clone());
    pdf_text(&layer, "DOC NO", margin + col_title + 2.0, cursor_y + 2.0, 7.5, &bold, dark.clone());
    pdf_text(
        &layer,
        "ISSUED",
        margin + col_title + col_no + 2.0,
        cursor_y + 2.0,
        7.5,
        &bold,
        dark.clone(),
    );
    pdf_text(
        &layer,
        "EXPIRY",
        margin + col_title + col_no + col_issued + 2.0,
        cursor_y + 2.0,
        7.5,
        &bold,
        dark.clone(),
    );

    for cert in &data.certificates {
        if cursor_y < margin + 30.0 {
            break; // Page 1 budget — v1 is single page
        }
        cursor_y -= cert_row_h;
        pdf_stroke_rect(&layer, margin, cursor_y, content_w, cert_row_h);
        pdf_text(
            &layer,
            &truncate(&cert.title, 55),
            margin + 2.0,
            cursor_y + 2.0,
            8.0,
            &reg,
            dark.clone(),
        );
        pdf_text(
            &layer,
            &truncate(cert.doc_number.as_deref().unwrap_or("—"), 16),
            margin + col_title + 2.0,
            cursor_y + 2.0,
            8.0,
            &reg,
            dark.clone(),
        );
        pdf_text(
            &layer,
            cert.valid_from.as_deref().unwrap_or("—"),
            margin + col_title + col_no + 2.0,
            cursor_y + 2.0,
            8.0,
            &reg,
            dark.clone(),
        );
        let expiry_text = cert.valid_to.as_deref().unwrap_or("—");
        let expiry_color = match cert.status.as_str() {
            "expired" => Color::Rgb(Rgb::new(0.80, 0.20, 0.20, None)),
            "warning" => Color::Rgb(Rgb::new(0.85, 0.55, 0.10, None)),
            _ => dark.clone(),
        };
        pdf_text(
            &layer,
            expiry_text,
            margin + col_title + col_no + col_issued + 2.0,
            cursor_y + 2.0,
            8.0,
            &reg,
            expiry_color,
        );
    }

    cursor_y -= 4.0;

    // -------- Section heading: Sea Service --------
    if cursor_y > margin + 40.0 {
        cursor_y -= section_h;
        pdf_fill_rect(&layer, margin, cursor_y, content_w, section_h, grey_bg.clone());
        pdf_text(
            &layer,
            "SEA SERVICE RECORD",
            margin + 3.0,
            cursor_y + 2.0,
            9.0,
            &bold,
            accent.clone(),
        );
        cursor_y -= 1.0;

        // Columns: Vessel | IMO | Position | From | To
        let col_vessel = content_w * 0.32;
        let col_imo = content_w * 0.12;
        let col_pos = content_w * 0.26;
        let col_from = content_w * 0.15;
        let _col_to = content_w - col_vessel - col_imo - col_pos - col_from;

        cursor_y -= cert_row_h;
        pdf_fill_rect(
            &layer,
            margin,
            cursor_y,
            content_w,
            cert_row_h,
            Color::Rgb(Rgb::new(0.85, 0.88, 0.94, None)),
        );
        pdf_text(&layer, "VESSEL", margin + 2.0, cursor_y + 2.0, 7.5, &bold, dark.clone());
        pdf_text(
            &layer,
            "IMO",
            margin + col_vessel + 2.0,
            cursor_y + 2.0,
            7.5,
            &bold,
            dark.clone(),
        );
        pdf_text(
            &layer,
            "POSITION",
            margin + col_vessel + col_imo + 2.0,
            cursor_y + 2.0,
            7.5,
            &bold,
            dark.clone(),
        );
        pdf_text(
            &layer,
            "SIGN ON",
            margin + col_vessel + col_imo + col_pos + 2.0,
            cursor_y + 2.0,
            7.5,
            &bold,
            dark.clone(),
        );
        pdf_text(
            &layer,
            "SIGN OFF",
            margin + col_vessel + col_imo + col_pos + col_from + 2.0,
            cursor_y + 2.0,
            7.5,
            &bold,
            dark.clone(),
        );

        for w in &data.work_history {
            if cursor_y < margin + 10.0 {
                break;
            }
            cursor_y -= cert_row_h;
            pdf_stroke_rect(&layer, margin, cursor_y, content_w, cert_row_h);
            pdf_text(
                &layer,
                &truncate(&w.vessel_name, 28),
                margin + 2.0,
                cursor_y + 2.0,
                8.0,
                &reg,
                dark.clone(),
            );
            pdf_text(
                &layer,
                w.imo.as_deref().unwrap_or("—"),
                margin + col_vessel + 2.0,
                cursor_y + 2.0,
                8.0,
                &reg,
                dark.clone(),
            );
            pdf_text(
                &layer,
                &truncate(&w.position, 22),
                margin + col_vessel + col_imo + 2.0,
                cursor_y + 2.0,
                8.0,
                &reg,
                dark.clone(),
            );
            pdf_text(
                &layer,
                w.sign_on.as_deref().unwrap_or("—"),
                margin + col_vessel + col_imo + col_pos + 2.0,
                cursor_y + 2.0,
                8.0,
                &reg,
                dark.clone(),
            );
            pdf_text(
                &layer,
                w.sign_off.as_deref().unwrap_or("present"),
                margin + col_vessel + col_imo + col_pos + col_from + 2.0,
                cursor_y + 2.0,
                8.0,
                &reg,
                dark.clone(),
            );
        }
    }

    // -------- Footer --------
    pdf_text(
        &layer,
        &format!(
            "Total sea time (tracked): {} days",
            data.total_sea_days
        ),
        margin,
        margin + 5.0,
        8.0,
        &reg,
        subtle.clone(),
    );
    pdf_text(
        &layer,
        "Generated by Skipi — Maritime Document Management",
        margin,
        margin + 1.5,
        7.0,
        &reg,
        subtle.clone(),
    );

    // -------- Save --------
    let file = File::create(path).map_err(|e| e.to_string())?;
    let mut writer = std::io::BufWriter::new(file);
    save_pdf(doc, &mut writer)?;
    Ok(())
}

/// Persist the document. printpdf wants a BufWriter<File>, not a generic Write.
fn save_pdf(doc: PdfDocumentReference, writer: &mut std::io::BufWriter<File>) -> Result<(), String> {
    doc.save(writer).map_err(|e| e.to_string())
}
