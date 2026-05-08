// Demo vault — Second Officer on a bulker.
//
// Purpose: give users and developers a one-click way to see Skipi with realistic
// data without filling the wizard every time. The demo vault contains:
//   * Seafarer identity (name, STCW level, vessel type, position)
//   * A full framework of required documents for the profile
//   * Pre-filled metadata on ~15 documents with a realistic mix of statuses
//     (valid / warning / expired / no-file) so the dashboard looks interesting
//   * Synthetic placeholder PDF attached to every filled document (same file,
//     reused from build_demo_pdf). Real AI scanning will fail on this demo PDF,
//     and that is fine — demo is for UI exploration, not scanning.
//   * Three entries of work history across different vessels.
//
// The demo is idempotent: re-running on the same path wipes existing rows so
// the user sees a clean state. File directories are preserved (cheap).

use crate::db;
use crate::frameworks;
use crate::profiles;
use rusqlite::Connection;
use std::fs;
use std::io::Cursor;
use std::path::Path;
use uuid::Uuid;

static PACKAGED_DEMO_VAULT: &[u8] = include_bytes!("../resources/demo-vault.zip");

fn extract_packaged_demo_vault(vault_path: &Path) -> Result<(), String> {
    let parent = vault_path
        .parent()
        .ok_or_else(|| "Demo vault target must have a parent folder".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let temp = parent.join(format!(".skipi-demo-{}", Uuid::new_v4()));
    if temp.exists() {
        let _ = fs::remove_dir_all(&temp);
    }
    fs::create_dir_all(&temp).map_err(|e| e.to_string())?;

    let result = (|| -> Result<(), String> {
        let reader = Cursor::new(PACKAGED_DEMO_VAULT);
        let mut archive =
            zip::ZipArchive::new(reader).map_err(|e| format!("invalid demo vault zip: {}", e))?;
        let mut saw_db = false;

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let enclosed = entry
                .enclosed_name()
                .ok_or_else(|| format!("Unsafe path in demo vault: {}", entry.name()))?;
            if enclosed.as_os_str().is_empty() {
                continue;
            }

            if enclosed == Path::new("skipi.db") {
                saw_db = true;
            }

            let out_path = temp.join(&enclosed);
            if entry.is_dir() {
                fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
                continue;
            }

            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = fs::File::create(&out_path)
                .map_err(|e| format!("create {}: {}", out_path.display(), e))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("extract {}: {}", entry.name(), e))?;
        }

        if !saw_db {
            return Err("Packaged demo vault does not contain skipi.db".to_string());
        }

        {
            let conn = db::open_db(&temp).map_err(|e| format!("open packaged demo db: {}", e))?;
            let _ = db::get_vault_info(&conn)
                .map_err(|e| format!("read packaged demo metadata: {}", e))?;
            db::set_vault_info(&conn, "is_demo", "1").map_err(|e| e.to_string())?;
        }

        if vault_path.exists() {
            fs::remove_dir_all(vault_path).map_err(|e| e.to_string())?;
        }
        fs::rename(&temp, vault_path).map_err(|e| format!("finalize demo vault: {}", e))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    }
    result
}

pub fn populate_demo_vault(vault_path: &Path) -> Result<Connection, String> {
    match extract_packaged_demo_vault(vault_path) {
        Ok(()) => db::open_db(vault_path).map_err(|e| e.to_string()),
        Err(err) => {
            eprintln!(
                "Packaged demo vault unavailable; falling back to synthetic demo: {}",
                err
            );
            populate_synthetic_demo_vault(vault_path)
        }
    }
}

// ---------- PDF generation ---------------------------------------------------

/// Build a minimal valid 1-page PDF with "Skipi DEMO" text.
/// Bytes are generated with dynamic xref offsets so the file is well-formed.
/// Result is ~450 bytes, opens in every major PDF reader.
pub fn build_demo_pdf(title: &str) -> Vec<u8> {
    // Sanitize the title for use inside a PDF literal string.
    // Parentheses and backslashes must be escaped per PDF spec.
    let safe: String = title
        .chars()
        .filter(|c| c.is_ascii() && !c.is_control())
        .map(|c| match c {
            '(' | ')' | '\\' => format!("\\{}", c),
            other => other.to_string(),
        })
        .collect();

    let stream = format!(
        "BT /F1 24 Tf 60 720 Td (Skipi DEMO) Tj 0 -36 Td /F1 14 Tf ({}) Tj ET",
        safe
    );

    let mut pdf: Vec<u8> = Vec::new();
    let mut offsets: Vec<usize> = Vec::new();

    pdf.extend_from_slice(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");

    // obj 1 — Catalog
    offsets.push(pdf.len());
    pdf.extend_from_slice(b"1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n");

    // obj 2 — Pages
    offsets.push(pdf.len());
    pdf.extend_from_slice(b"2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n");

    // obj 3 — Page
    offsets.push(pdf.len());
    pdf.extend_from_slice(
        b"3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
          /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>\nendobj\n",
    );

    // obj 4 — Contents stream
    offsets.push(pdf.len());
    let obj4 = format!(
        "4 0 obj\n<</Length {}>>\nstream\n{}\nendstream\nendobj\n",
        stream.len(),
        stream
    );
    pdf.extend_from_slice(obj4.as_bytes());

    // obj 5 — Font
    offsets.push(pdf.len());
    pdf.extend_from_slice(
        b"5 0 obj\n<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>\nendobj\n",
    );

    // xref table
    let xref_offset = pdf.len();
    pdf.extend_from_slice(b"xref\n0 6\n");
    pdf.extend_from_slice(b"0000000000 65535 f \n");
    for off in &offsets {
        pdf.extend_from_slice(format!("{:010} 00000 n \n", off).as_bytes());
    }

    // trailer
    let trailer = format!(
        "trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n{}\n%%EOF\n",
        xref_offset
    );
    pdf.extend_from_slice(trailer.as_bytes());

    pdf
}

// ---------- Seed data --------------------------------------------------------

/// A single demo document override. `template_id` matches the profile catalog
/// so we can find the framework-generated row and enrich it with realistic
/// metadata + attach a synthetic PDF.
struct DemoFill {
    template_id: &'static str,
    doc_number: &'static str,
    issued_by: &'static str,
    valid_from: &'static str,
    valid_to: Option<&'static str>, // None = no expiry (e.g. yellow fever)
}

/// The full list of documents we pre-fill. Designed for Support level / bulker /
/// Second Officer profile. Dates are set relative to 2026 so statuses are
/// distributed: some expired, some in warning window, most valid.
fn demo_fills() -> Vec<DemoFill> {
    vec![
        // Identity
        DemoFill {
            template_id: "passport",
            doc_number: "FT123456",
            issued_by: "State Migration Service",
            valid_from: "2021-05-10",
            valid_to: Some("2031-05-09"),
        },
        DemoFill {
            template_id: "sid",
            doc_number: "2110/UA-0042",
            issued_by: "Seafarers Registry 2110",
            valid_from: "2019-08-14",
            valid_to: Some("2029-08-13"),
        },
        DemoFill {
            template_id: "seamans_book",
            doc_number: "AB516117",
            issued_by: "PORT ODESA",
            valid_from: "2020-06-01",
            valid_to: Some("2025-12-31"), // EXPIRED — shows red
        },
        // Medical
        DemoFill {
            template_id: "medical_cert",
            doc_number: "MED-2024-8821",
            issued_by: "Maritime Medical Centre",
            valid_from: "2024-09-01",
            valid_to: Some("2026-08-31"), // WARNING — ~4 months out
        },
        DemoFill {
            template_id: "yellow_fever",
            doc_number: "YF-UA-33112",
            issued_by: "Kyiv Travel Clinic",
            valid_from: "2018-03-15",
            valid_to: None, // no expiry per WHO rules
        },
        // STCW level base
        DemoFill {
            template_id: "bst",
            doc_number: "BST-UA-0945",
            issued_by: "Maritime Training Centre Odesa",
            valid_from: "2021-03-15",
            valid_to: Some("2026-03-14"), // EXPIRED
        },
        DemoFill {
            template_id: "pscrb",
            doc_number: "PSCRB-0123",
            issued_by: "Maritime Training Centre Odesa",
            valid_from: "2023-01-10",
            valid_to: Some("2028-01-09"),
        },
        DemoFill {
            template_id: "sec_awareness",
            doc_number: "SA-2023-7712",
            issued_by: "Maritime Training Centre Odesa",
            valid_from: "2023-02-20",
            valid_to: Some("2028-02-19"),
        },
        DemoFill {
            template_id: "advanced_ff",
            doc_number: "AFF-2024-0611",
            issued_by: "Maritime Training Centre Odesa",
            valid_from: "2024-06-01",
            valid_to: Some("2029-05-31"),
        },
        DemoFill {
            template_id: "medical_first_aid",
            doc_number: "MFA-2024-0712",
            issued_by: "Maritime Training Centre Odesa",
            valid_from: "2024-07-12",
            valid_to: Some("2029-07-11"),
        },
        // Position-specific CoC (Officer in Charge of a Navigational Watch)
        DemoFill {
            template_id: "coc_oow",
            doc_number: "CoC-OOW-UA-9914",
            issued_by: "Maritime Administration of Ukraine",
            valid_from: "2023-11-20",
            valid_to: Some("2028-11-19"),
        },
        DemoFill {
            template_id: "gmdss_goc",
            doc_number: "GOC-UA-3312",
            issued_by: "Maritime Administration of Ukraine",
            valid_from: "2023-04-12",
            valid_to: Some("2028-04-11"),
        },
        DemoFill {
            template_id: "ecdis",
            doc_number: "ECDIS-2023-4421",
            issued_by: "Maritime Training Centre Odesa",
            valid_from: "2023-03-18",
            valid_to: Some("2028-03-17"),
        },
        DemoFill {
            template_id: "brm",
            doc_number: "BRM-2023-1205",
            issued_by: "Maritime Training Centre Odesa",
            valid_from: "2023-12-05",
            valid_to: Some("2028-12-04"),
        },
    ]
}

/// Three past vessel assignments for work history.
struct DemoWork {
    vessel_name: &'static str,
    vessel_type: &'static str,
    imo: &'static str,
    flag: &'static str,
    company: &'static str,
    position: &'static str,
    sign_on: &'static str,
    sign_off: &'static str,
    dwt: &'static str,
    teu: &'static str,
}

fn demo_work_entries() -> Vec<DemoWork> {
    vec![
        DemoWork {
            vessel_name: "MV Demo Horizon",
            vessel_type: "Bulk carrier",
            imo: "9876543",
            flag: "Panama",
            company: "Demo Shipping Ltd",
            position: "Second Officer",
            sign_on: "2024-02-12",
            sign_off: "2024-09-30",
            dwt: "82000",
            teu: "",
        },
        DemoWork {
            vessel_name: "MV Demo Pioneer",
            vessel_type: "Bulk carrier",
            imo: "9765432",
            flag: "Marshall Islands",
            company: "Ocean Demo Group",
            position: "Third Officer",
            sign_on: "2023-05-01",
            sign_off: "2023-12-15",
            dwt: "76500",
            teu: "",
        },
        DemoWork {
            vessel_name: "MV Demo Breeze",
            vessel_type: "General cargo",
            imo: "9654321",
            flag: "Liberia",
            company: "Demo Navigation",
            position: "Deck Cadet",
            sign_on: "2022-03-10",
            sign_off: "2022-10-20",
            dwt: "12500",
            teu: "",
        },
    ]
}

// ---------- Main entry point -------------------------------------------------

/// Create or overwrite a demo seafarer vault at `vault_path`.
/// Returns the newly opened SQLite connection — the caller is responsible for
/// storing it in AppState.
fn populate_synthetic_demo_vault(vault_path: &Path) -> Result<Connection, String> {
    fs::create_dir_all(vault_path).map_err(|e| e.to_string())?;
    let conn = db::open_db(vault_path).map_err(|e| e.to_string())?;

    // Wipe previous demo content if any (keeps schema_migrations intact).
    let _ = conn.execute("DELETE FROM documents", []);
    let _ = conn.execute("DELETE FROM vault_info", []);
    let _ = conn.execute("DELETE FROM work_history", []);
    let _ = conn.execute("DELETE FROM work_history_files", []);

    // Vault identity — Second Officer / bulker / Operational level.
    db::set_vault_info(&conn, "account_type", "seafarer").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "name", "Demo Seafarer").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "stcw_level", "operational").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "vessel_category", "bulker").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "position", "second_officer").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "rank", "Second Officer").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "vessel_type", "Bulk carrier").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "is_demo", "1").map_err(|e| e.to_string())?;

    // Seafarer personal data — populates the profile and CV.
    db::set_vault_info(&conn, "personal_surname", "Seaborne").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_first_name", "Adrian").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_dob", "1992-07-15").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_place_of_birth", "Odesa").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_nationality", "Ukrainian").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_nationality_code", "UKR").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_phones", "+380 50 123 4567").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_email", "a.seaborne@demo.skipi.app")
        .map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_home_address", "Odesa, Ukraine")
        .map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_rank", "Second Officer").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_nearest_airport", "Odesa (ODS)")
        .map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_nearest_intl_airport", "Istanbul (IST)")
        .map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_available_from", "2026-05-15")
        .map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_min_salary", "4500").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_currency", "USD").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_ready_for_offers", "false").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_preferred_messenger", "WhatsApp")
        .map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_english_level", "Fluent").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_marital_status", "Single").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_height_cm", "182").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_weight_kg", "78").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_coverall_size", "L").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_shoe_size_eu", "43").map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "personal_blood_type", "A+").map_err(|e| e.to_string())?;

    // Build the full framework from profile templates — same pipeline as real
    // seafarer creation, so nothing drifts.
    let level = profiles::StcwLevel::from_id("operational")
        .ok_or_else(|| "demo: missing operational level".to_string())?;
    let templates = profiles::required_docs_for_profile(level, "bulker", "second_officer");

    let fills = demo_fills();
    let fill_by_template: std::collections::HashMap<&str, &DemoFill> =
        fills.iter().map(|f| (f.template_id, f)).collect();

    let mut categories_seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for t in &templates {
        let mut rec = frameworks::record_from_profile_template(t);

        // Ensure category folder exists
        if categories_seen.insert(rec.category.clone()) {
            let cat_dir = vault_path.join(&rec.category);
            fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;
        }

        // If this template has a demo fill, enrich the record and drop a PDF.
        if let Some(fill) = fill_by_template.get(t.id) {
            rec.doc_number = Some(fill.doc_number.to_string());
            rec.issued_by = Some(fill.issued_by.to_string());
            rec.valid_from = Some(fill.valid_from.to_string());
            rec.valid_to = fill.valid_to.map(|s| s.to_string());

            // Mark all filled fields as 'verified' so the UI shows green dots.
            let statuses = serde_json::json!({
                "doc_number": "verified",
                "issued_by": "verified",
                "valid_from": "verified",
                "valid_to": "verified",
            });
            rec.field_statuses = Some(statuses.to_string());

            // Write a synthetic placeholder PDF into the category folder.
            let safe_title: String = rec
                .title
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || c == ' ' || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let file_name = format!("{}.pdf", safe_title.trim());
            let file_path = vault_path.join(&rec.category).join(&file_name);
            let pdf_bytes = build_demo_pdf(&rec.title);
            fs::write(&file_path, &pdf_bytes).map_err(|e| e.to_string())?;
            rec.file_name = Some(file_name);
        }

        db::insert_doc(&conn, &rec).map_err(|e| e.to_string())?;
    }

    // Seed work history.
    for w in demo_work_entries() {
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO work_history (id, vessel_name, vessel_type, imo, flag, company, position, sign_on, sign_off, dwt, teu, notes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, datetime('now'))",
            rusqlite::params![
                id,
                w.vessel_name,
                w.vessel_type,
                w.imo,
                w.flag,
                w.company,
                w.position,
                w.sign_on,
                w.sign_off,
                w.dwt,
                w.teu,
                "Demo entry",
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_demo_vault_has_db_and_no_runtime_secrets() {
        let reader = Cursor::new(PACKAGED_DEMO_VAULT);
        let mut archive = zip::ZipArchive::new(reader).expect("demo zip opens");
        let mut names = Vec::new();
        for i in 0..archive.len() {
            names.push(archive.by_index(i).unwrap().name().to_string());
        }

        assert!(names.iter().any(|n| n == "skipi.db"));
        assert!(names.iter().any(|n| n == "_profile/photo.jpg"));
        assert!(!names.iter().any(|n| n.starts_with("_identity/")));
        assert!(!names.iter().any(|n| n.starts_with("_packages/")));
        assert!(!names.iter().any(|n| n.starts_with("_dispatch/")));
        assert!(!names.iter().any(|n| n == "skipi.db-wal"));
        assert!(!names.iter().any(|n| n == "skipi.db-shm"));
    }
}
