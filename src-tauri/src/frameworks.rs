use crate::db::DocRecord;
use crate::profiles;
use uuid::Uuid;

struct DocTemplate {
    category: &'static str,
    title: &'static str,
    has_expiry: bool,
    typical_years: Option<u32>,
    notes: &'static str,
}

fn make_record(t: &DocTemplate) -> DocRecord {
    let valid_to = t.typical_years.map(|y| {
        let now = chrono::Utc::now();
        let future = now + chrono::Duration::days(365 * y as i64);
        future.format("%Y-%m-%d").to_string()
    });
    DocRecord {
        id: Uuid::new_v4().to_string(),
        category: t.category.to_string(),
        valid_from: None,
        issued_by: None,
        doc_number: None,
        title: t.title.to_string(),
        file_name: None,
        has_expiry: t.has_expiry,
        valid_to,
        notes: if t.notes.is_empty() {
            None
        } else {
            Some(t.notes.to_string())
        },
        field_statuses: None,
        regulatory_basis: None,
        template_id: None,
        sha256: None,
        file_size: None,
        content_type: None,
        visibility: "private".to_string(),
        is_national: false,
    }
}

/// Convert a profiles::DocTemplate into a DocRecord with regulatory basis populated.
pub fn record_from_profile_template(t: &profiles::DocTemplate) -> DocRecord {
    let valid_to = t.typical_years.map(|y| {
        let now = chrono::Utc::now();
        let future = now + chrono::Duration::days(365 * y as i64);
        future.format("%Y-%m-%d").to_string()
    });
    DocRecord {
        id: Uuid::new_v4().to_string(),
        category: t.category.to_string(),
        title: t.title.to_string(),
        file_name: None,
        has_expiry: t.has_expiry,
        valid_from: None,
        valid_to,
        issued_by: None,
        doc_number: None,
        notes: if t.notes.is_empty() {
            None
        } else {
            Some(t.notes.to_string())
        },
        field_statuses: None,
        regulatory_basis: Some(t.regulatory_basis.to_string()),
        template_id: Some(t.id.to_string()),
        // Phase-2 readiness — empty until a file is actually attached.
        // See docs/ARCHITECTURE_PHASE2.md I-4, I-5.
        sha256: None,
        file_size: None,
        content_type: None,
        visibility: "private".to_string(),
        is_national: false,
    }
}

const SOLAS_BASE: &[DocTemplate] = &[
    // Statutory Certificates
    DocTemplate {
        category: "Statutory Certificates",
        title: "Certificate of Registry",
        has_expiry: false,
        typical_years: None,
        notes: "Flag State",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "International Tonnage Certificate (ITC 1969)",
        has_expiry: false,
        typical_years: None,
        notes: "",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "International Load Line Certificate (ILLC)",
        has_expiry: true,
        typical_years: Some(5),
        notes: "Annual/renewal survey",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "Safety Management Certificate (SMC)",
        has_expiry: true,
        typical_years: Some(5),
        notes: "ISM Code",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "Document of Compliance (DOC)",
        has_expiry: true,
        typical_years: Some(5),
        notes: "ISM Code, company",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "International Ship Security Certificate (ISSC)",
        has_expiry: true,
        typical_years: Some(5),
        notes: "ISPS Code",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "Minimum Safe Manning Certificate",
        has_expiry: false,
        typical_years: None,
        notes: "Flag State",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "IOPP Certificate",
        has_expiry: true,
        typical_years: Some(5),
        notes: "MARPOL Annex I",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "ISPP Certificate",
        has_expiry: true,
        typical_years: Some(5),
        notes: "MARPOL Annex IV",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "IAPP Certificate",
        has_expiry: true,
        typical_years: Some(5),
        notes: "MARPOL Annex VI",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "IEE Certificate",
        has_expiry: false,
        typical_years: None,
        notes: "MARPOL Annex VI",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "CLC Certificate",
        has_expiry: true,
        typical_years: Some(1),
        notes: "Oil pollution liability",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "Bunker Convention Certificate",
        has_expiry: true,
        typical_years: Some(1),
        notes: "",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "Wreck Removal Convention Certificate",
        has_expiry: true,
        typical_years: Some(1),
        notes: "",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "Maritime Labour Certificate (MLC)",
        has_expiry: true,
        typical_years: Some(5),
        notes: "MLC 2006",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "DMLC Part I",
        has_expiry: false,
        typical_years: None,
        notes: "Flag State",
    },
    DocTemplate {
        category: "Statutory Certificates",
        title: "DMLC Part II",
        has_expiry: false,
        typical_years: None,
        notes: "Shipowner",
    },
    // Class Certificates
    DocTemplate {
        category: "Class Certificates",
        title: "Classification Certificate",
        has_expiry: true,
        typical_years: Some(5),
        notes: "Class society",
    },
    DocTemplate {
        category: "Class Certificates",
        title: "Safety Equipment Certificate (SEC)",
        has_expiry: true,
        typical_years: Some(5),
        notes: "SOLAS Ch. III",
    },
    DocTemplate {
        category: "Class Certificates",
        title: "Safety Radio Certificate (SRC)",
        has_expiry: true,
        typical_years: Some(5),
        notes: "SOLAS Ch. IV",
    },
    DocTemplate {
        category: "Class Certificates",
        title: "Safety Construction Certificate (SCC)",
        has_expiry: true,
        typical_years: Some(5),
        notes: "SOLAS Ch. II",
    },
    // Safety Equipment
    DocTemplate {
        category: "Safety Equipment",
        title: "Liferaft Service Certificates",
        has_expiry: true,
        typical_years: Some(1),
        notes: "Annual service",
    },
    DocTemplate {
        category: "Safety Equipment",
        title: "Fire Extinguisher Inspection",
        has_expiry: true,
        typical_years: Some(1),
        notes: "",
    },
    DocTemplate {
        category: "Safety Equipment",
        title: "EPIRB Test Certificate",
        has_expiry: true,
        typical_years: Some(1),
        notes: "",
    },
    DocTemplate {
        category: "Safety Equipment",
        title: "Mooring Lines Certificates",
        has_expiry: true,
        typical_years: Some(1),
        notes: "OCIMF",
    },
    // Insurance
    DocTemplate {
        category: "Insurance & P&I",
        title: "P&I Club Certificate of Entry",
        has_expiry: true,
        typical_years: Some(1),
        notes: "Renewed annually",
    },
    DocTemplate {
        category: "Insurance & P&I",
        title: "Hull & Machinery Insurance",
        has_expiry: true,
        typical_years: Some(1),
        notes: "",
    },
    DocTemplate {
        category: "Insurance & P&I",
        title: "War Risk Insurance",
        has_expiry: true,
        typical_years: Some(1),
        notes: "",
    },
    // Operations
    DocTemplate {
        category: "Operations & Logs",
        title: "Ship Security Plan (SSP)",
        has_expiry: false,
        typical_years: None,
        notes: "ISPS Code",
    },
    DocTemplate {
        category: "Operations & Logs",
        title: "SOPEP",
        has_expiry: false,
        typical_years: None,
        notes: "MARPOL Annex I",
    },
    DocTemplate {
        category: "Operations & Logs",
        title: "SEEMP",
        has_expiry: false,
        typical_years: None,
        notes: "MARPOL Annex VI",
    },
    DocTemplate {
        category: "Operations & Logs",
        title: "Stability Booklet (Approved)",
        has_expiry: false,
        typical_years: None,
        notes: "",
    },
    DocTemplate {
        category: "Operations & Logs",
        title: "Continuous Synopsis Record (CSR)",
        has_expiry: false,
        typical_years: None,
        notes: "SOLAS Ch. XI-1",
    },
];

const BULK_EXTRAS: &[DocTemplate] = &[
    DocTemplate {
        category: "Bulk Carrier Specific",
        title: "Document of Authorization (Grain)",
        has_expiry: false,
        typical_years: None,
        notes: "Grain Code",
    },
    DocTemplate {
        category: "Bulk Carrier Specific",
        title: "Cargo Securing Manual (CSM)",
        has_expiry: false,
        typical_years: None,
        notes: "",
    },
    DocTemplate {
        category: "Bulk Carrier Specific",
        title: "Hatch Cover Tightness Test",
        has_expiry: true,
        typical_years: Some(1),
        notes: "Ultrasonic/hose",
    },
    DocTemplate {
        category: "Bulk Carrier Specific",
        title: "Enhanced Survey Report (ESP)",
        has_expiry: true,
        typical_years: Some(1),
        notes: "",
    },
];

const TANKER_EXTRAS: &[DocTemplate] = &[
    DocTemplate {
        category: "Tanker Specific",
        title: "Certificate of Fitness",
        has_expiry: true,
        typical_years: Some(5),
        notes: "IBC/IGC Code",
    },
    DocTemplate {
        category: "Tanker Specific",
        title: "Inert Gas System Certificate",
        has_expiry: true,
        typical_years: Some(1),
        notes: "",
    },
    DocTemplate {
        category: "Tanker Specific",
        title: "SIRE/CDI Inspection Report",
        has_expiry: true,
        typical_years: Some(1),
        notes: "OCIMF/CDI",
    },
    DocTemplate {
        category: "Tanker Specific",
        title: "P&A Manual (Tanker)",
        has_expiry: false,
        typical_years: None,
        notes: "MARPOL Annex I",
    },
];

// Seafarer base: minimum to be a seafarer
const SEAFARER_BASE: &[DocTemplate] = &[
    DocTemplate {
        category: "Passport",
        title: "Passport (Travel)",
        has_expiry: true,
        typical_years: Some(10),
        notes: "National travel passport",
    },
    DocTemplate {
        category: "Seaman's Book",
        title: "Seafarer's Identity Document / Seaman's Book",
        has_expiry: true,
        typical_years: Some(5),
        notes: "Primary seafarer identity/seaman book document",
    },
    DocTemplate {
        category: "Safety",
        title: "Basic Safety Training (BST / STCW VI/1)",
        has_expiry: true,
        typical_years: Some(5),
        notes: "PST, FPFF, EFA, PSSR",
    },
];

pub fn get_vessel_framework(vessel_type: Option<&str>) -> Vec<DocRecord> {
    let mut docs: Vec<DocRecord> = SOLAS_BASE.iter().map(make_record).collect();
    match vessel_type.unwrap_or("") {
        "Bulk Carrier" => docs.extend(BULK_EXTRAS.iter().map(make_record)),
        "Oil Tanker" | "Chemical Tanker" | "Gas Carrier" => {
            docs.extend(TANKER_EXTRAS.iter().map(make_record))
        }
        _ => {}
    }
    docs
}

pub fn get_seafarer_framework(_rank: Option<&str>) -> Vec<DocRecord> {
    // Start with 3 base documents. Rank-specific extensions will be added later.
    SEAFARER_BASE.iter().map(make_record).collect()
}

pub fn vessel_types() -> Vec<&'static str> {
    vec![
        "Bulk Carrier",
        "Oil Tanker",
        "Chemical Tanker",
        "Gas Carrier",
        "Container Ship",
        "General Cargo",
        "Passenger Ship",
    ]
}

pub fn seafarer_ranks() -> Vec<&'static str> {
    vec![
        "Master",
        "Chief Officer",
        "2nd Officer",
        "3rd Officer",
        "Chief Engineer",
        "2nd Engineer",
        "3rd Engineer",
        "4th Engineer",
        "ETO",
        "Bosun",
        "AB",
        "OS",
        "Motorman",
        "Cook",
    ]
}
