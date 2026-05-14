// Profile system — the new structural foundation.
//
// Based on user vision 2026-04-10: a seafarer is an entity composed of documents.
// A profile is a specific set of documents determined by (STCW level × vessel type × position).
// Each document template references the regulatory basis (STCW regulation, ILO convention, etc).
//
// This module is additive: existing frameworks.rs still works. New Tauri commands use this module
// to power the onboarding wizard and profile completeness calculations.

use serde::{Deserialize, Serialize};

// --- STCW levels ---------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum StcwLevel {
    Support,     // matrosy, motoristy, cooks, bosun, welders
    Operational, // OOW, watchkeeping engineers, ETO
    Management,  // Master, Chief Officer, Chief Engineer, 2nd Engineer
}

impl StcwLevel {
    pub fn id(&self) -> &'static str {
        match self {
            StcwLevel::Support => "support",
            StcwLevel::Operational => "operational",
            StcwLevel::Management => "management",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            StcwLevel::Support => "Support Level",
            StcwLevel::Operational => "Operational Level",
            StcwLevel::Management => "Management Level",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "support" => Some(StcwLevel::Support),
            "operational" => Some(StcwLevel::Operational),
            "management" => Some(StcwLevel::Management),
            _ => None,
        }
    }

    pub fn all() -> &'static [StcwLevel] {
        &[
            StcwLevel::Support,
            StcwLevel::Operational,
            StcwLevel::Management,
        ]
    }
}

// --- Vessel type tree ----------------------------------------------------

// Tree structure: root categories with specialized subtypes.
// Example: "tanker" -> "oil_tanker" / "chemical_tanker" / "gas_carrier"

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VesselNode {
    pub id: &'static str,
    pub label: &'static str,
    pub parent: Option<&'static str>,
    pub is_leaf: bool,
}

pub fn vessel_tree() -> Vec<VesselNode> {
    vec![
        // Root groups
        VesselNode {
            id: "cargo",
            label: "Dry Cargo",
            parent: None,
            is_leaf: false,
        },
        VesselNode {
            id: "tanker",
            label: "Tanker",
            parent: None,
            is_leaf: false,
        },
        VesselNode {
            id: "passenger",
            label: "Passenger Ship",
            parent: None,
            is_leaf: true,
        },
        VesselNode {
            id: "offshore",
            label: "Offshore / Special Purpose",
            parent: None,
            is_leaf: true,
        },
        // Dry cargo children
        VesselNode {
            id: "bulker",
            label: "Bulk Carrier",
            parent: Some("cargo"),
            is_leaf: true,
        },
        VesselNode {
            id: "container",
            label: "Container Ship",
            parent: Some("cargo"),
            is_leaf: true,
        },
        VesselNode {
            id: "general_cargo",
            label: "General Cargo",
            parent: Some("cargo"),
            is_leaf: true,
        },
        VesselNode {
            id: "car_carrier",
            label: "Car Carrier / RoRo",
            parent: Some("cargo"),
            is_leaf: true,
        },
        VesselNode {
            id: "reefer",
            label: "Refrigerated Cargo",
            parent: Some("cargo"),
            is_leaf: true,
        },
        // Tanker children
        VesselNode {
            id: "oil_tanker",
            label: "Oil Tanker",
            parent: Some("tanker"),
            is_leaf: true,
        },
        VesselNode {
            id: "chemical_tanker",
            label: "Chemical Tanker",
            parent: Some("tanker"),
            is_leaf: true,
        },
        VesselNode {
            id: "gas_carrier",
            label: "Gas Carrier (LNG/LPG)",
            parent: Some("tanker"),
            is_leaf: true,
        },
    ]
}

fn normalized_lookup_key(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

pub fn vessel_id_from_label_or_id(value: &str) -> Option<&'static str> {
    let first = value.split(',').next().unwrap_or(value).trim();
    if first.is_empty() {
        return None;
    }

    let key = normalized_lookup_key(first);
    for v in vessel_tree() {
        if normalized_lookup_key(v.id) == key || normalized_lookup_key(v.label) == key {
            return Some(v.id);
        }
    }

    match key.as_str() {
        "bulk" | "bulker" | "bulkcarrier" => Some("bulker"),
        "container" | "containership" => Some("container"),
        "generalcargo" | "generalcargoship" => Some("general_cargo"),
        "roro" | "roroship" | "carcarrier" | "carcarrierroro" => Some("car_carrier"),
        "reefer" | "refrigeratedcargo" => Some("reefer"),
        "oil" | "oiltanker" => Some("oil_tanker"),
        "chemical" | "chemicaltanker" => Some("chemical_tanker"),
        "gas" | "lng" | "lpg" | "lnglpg" | "gascarrier" => Some("gas_carrier"),
        "passenger" | "passengership" | "cruise" | "cruiseship" => Some("passenger"),
        "offshore" | "osv" | "specialpurpose" | "offshorespecialpurpose" => Some("offshore"),
        _ => None,
    }
}

pub fn vessel_label(id: &str) -> Option<&'static str> {
    vessel_tree()
        .into_iter()
        .find(|v| v.id == id)
        .map(|v| v.label)
}

// --- Positions -----------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub id: &'static str,
    pub label: &'static str,
    pub level: StcwLevel,
    pub dept: &'static str, // "deck" / "engine" / "catering" / "other"
}

pub fn positions() -> Vec<Position> {
    use StcwLevel::*;
    vec![
        // Management
        Position {
            id: "master",
            label: "Master",
            level: Management,
            dept: "deck",
        },
        Position {
            id: "chief_officer",
            label: "Chief Officer",
            level: Management,
            dept: "deck",
        },
        Position {
            id: "chief_engineer",
            label: "Chief Engineer",
            level: Management,
            dept: "engine",
        },
        Position {
            id: "second_engineer",
            label: "Second Engineer",
            level: Management,
            dept: "engine",
        },
        // Operational
        Position {
            id: "second_officer",
            label: "Second Officer",
            level: Operational,
            dept: "deck",
        },
        Position {
            id: "third_officer",
            label: "Third Officer",
            level: Operational,
            dept: "deck",
        },
        Position {
            id: "third_engineer",
            label: "Third Engineer",
            level: Operational,
            dept: "engine",
        },
        Position {
            id: "fourth_engineer",
            label: "Fourth Engineer",
            level: Operational,
            dept: "engine",
        },
        Position {
            id: "eto",
            label: "Electro-Technical Officer (ETO)",
            level: Operational,
            dept: "engine",
        },
        // Support
        Position {
            id: "bosun",
            label: "Bosun",
            level: Support,
            dept: "deck",
        },
        Position {
            id: "ab",
            label: "Able Seaman (AB)",
            level: Support,
            dept: "deck",
        },
        Position {
            id: "os",
            label: "Ordinary Seaman (OS)",
            level: Support,
            dept: "deck",
        },
        Position {
            id: "motorman",
            label: "Motorman",
            level: Support,
            dept: "engine",
        },
        Position {
            id: "wiper",
            label: "Wiper",
            level: Support,
            dept: "engine",
        },
        Position {
            id: "ete",
            label: "Electro-Technical Rating",
            level: Support,
            dept: "engine",
        },
        Position {
            id: "fitter",
            label: "Fitter",
            level: Support,
            dept: "engine",
        },
        Position {
            id: "cook",
            label: "Cook",
            level: Support,
            dept: "catering",
        },
        Position {
            id: "messman",
            label: "Messman / Steward",
            level: Support,
            dept: "catering",
        },
    ]
}

pub fn position(id: &str) -> Option<Position> {
    positions().into_iter().find(|p| p.id == id)
}

pub fn position_id_from_rank_label(value: &str) -> Option<&'static str> {
    let key = normalized_lookup_key(value);
    if key.is_empty() {
        return None;
    }

    for p in positions() {
        if normalized_lookup_key(p.id) == key || normalized_lookup_key(p.label) == key {
            return Some(p.id);
        }
    }

    match key.as_str() {
        "captain" | "capt" | "mastermariner" => Some("master"),
        "chiefmate" | "1stofficer" | "firstofficer" | "1o" | "co" => Some("chief_officer"),
        "secondmate" | "2ndofficer" | "2officer" | "2o" => Some("second_officer"),
        "thirdmate" | "3rdofficer" | "3officer" | "3o" => Some("third_officer"),
        "electrotechnicalofficer" | "electrotechnicalofficereto" => Some("eto"),
        "electrician" | "electrotechnicalrating" | "etr" => Some("ete"),
        "ableseaman" | "ablebodiedseaman" => Some("ab"),
        "ordinaryseaman" => Some("os"),
        "chiefcook" => Some("cook"),
        "steward" => Some("messman"),
        "oiler" => Some("motorman"),
        _ => None,
    }
}

// --- Document templates with regulatory basis ----------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocTemplate {
    pub id: &'static str,
    pub title: &'static str,
    pub category: &'static str,
    pub regulatory_basis: &'static str, // e.g. "STCW VI/1" or "ILO C185"
    pub has_expiry: bool,
    pub typical_years: Option<u32>,
    pub notes: &'static str,
}

// --- Universal base: every seafarer needs these regardless of role -------

pub fn universal_base() -> Vec<DocTemplate> {
    vec![
        // Passport
        DocTemplate {
            id: "passport",
            title: "Passport (Travel)",
            category: "Passport",
            regulatory_basis: "ICAO 9303",
            has_expiry: true,
            typical_years: Some(10),
            notes: "National travel passport",
        },
        // Seafarer's Identity Document / national seaman book slot. In many
        // administrations this is the same practical document for the user.
        DocTemplate {
            id: "sid",
            title: "Seafarer's Identity Document / Seaman's Book",
            category: "Seaman's Book",
            regulatory_basis: "ILO C185",
            has_expiry: true,
            typical_years: Some(5),
            notes: "Primary seafarer identity/seaman book document. Additional flag-state books can be added separately.",
        },
        // Medical
        DocTemplate {
            id: "medical_cert",
            title: "Medical Fitness Certificate",
            category: "Medical",
            regulatory_basis: "STCW I/9; MLC 2006 A1.2",
            has_expiry: true,
            typical_years: Some(2),
            notes: "ENG1 or equivalent",
        },
        DocTemplate {
            id: "yellow_fever",
            title: "Yellow Fever Vaccination",
            category: "Medical",
            regulatory_basis: "WHO IHR 2005",
            has_expiry: false,
            typical_years: None,
            notes: "Depending on trading area",
        },
    ]
}

// --- STCW level base: everyone at this level must have ------------------

pub fn level_base(level: StcwLevel) -> Vec<DocTemplate> {
    let mut out: Vec<DocTemplate> = vec![
        DocTemplate {
            id: "bst",
            title: "Basic Safety Training (BST)",
            category: "STCW Mandatory",
            regulatory_basis: "STCW VI/1",
            has_expiry: true,
            typical_years: Some(5),
            notes: "PST, FPFF, EFA, PSSR",
        },
        DocTemplate {
            id: "pscrb",
            title: "Proficiency in Survival Craft and Rescue Boats (PSCRB)",
            category: "STCW Mandatory",
            regulatory_basis: "STCW VI/2",
            has_expiry: true,
            typical_years: Some(5),
            notes: "",
        },
        DocTemplate {
            id: "sec_awareness",
            title: "Security Awareness Training",
            category: "STCW Mandatory",
            regulatory_basis: "STCW VI/6-1",
            has_expiry: false,
            typical_years: None,
            notes: "ISPS",
        },
    ];

    if matches!(level, StcwLevel::Operational | StcwLevel::Management) {
        out.push(DocTemplate {
            id: "advanced_ff",
            title: "Advanced Firefighting",
            category: "STCW Mandatory",
            regulatory_basis: "STCW VI/3",
            has_expiry: true,
            typical_years: Some(5),
            notes: "",
        });
        out.push(DocTemplate {
            id: "medical_first_aid",
            title: "Medical First Aid",
            category: "STCW Mandatory",
            regulatory_basis: "STCW VI/4-1",
            has_expiry: false,
            typical_years: None,
            notes: "",
        });
    }

    if matches!(level, StcwLevel::Management) {
        out.push(DocTemplate {
            id: "medical_care",
            title: "Medical Care on Board",
            category: "STCW Mandatory",
            regulatory_basis: "STCW VI/4-2",
            has_expiry: false,
            typical_years: None,
            notes: "",
        });
        out.push(DocTemplate {
            id: "dsd",
            title: "Designated Security Duties",
            category: "STCW Mandatory",
            regulatory_basis: "STCW VI/6-2",
            has_expiry: false,
            typical_years: None,
            notes: "",
        });
    }

    out
}

// --- Position-specific documents (Certificates of Competency etc) -------

pub fn position_docs(pos_id: &str) -> Vec<DocTemplate> {
    match pos_id {
        // Management - Deck
        "master" => vec![
            DocTemplate { id: "coc_master", title: "Certificate of Competency — Master Mariner",
                category: "Certificate of Competency", regulatory_basis: "STCW II/2",
                has_expiry: true, typical_years: Some(5), notes: "Master on ships >= 3000 GT" },
            DocTemplate { id: "gmdss_goc", title: "GMDSS General Operator's Certificate (GOC)",
                category: "Certificate of Competency", regulatory_basis: "STCW IV/2",
                has_expiry: true, typical_years: Some(5), notes: "" },
            DocTemplate { id: "ecdis", title: "ECDIS Generic Training",
                category: "Deck Training", regulatory_basis: "STCW A-II/1, A-II/2",
                has_expiry: false, typical_years: None, notes: "Generic ECDIS competence required for deck officers. Equipment/type-specific ECDIS certificates are added separately." },
            DocTemplate { id: "radar_arpa", title: "Radar Navigation, Radar Plotting and ARPA",
                category: "Deck Training", regulatory_basis: "STCW A-II/1, A-II/2",
                has_expiry: false, typical_years: None, notes: "Radar observer / ARPA training" },
            DocTemplate { id: "brm", title: "Bridge Resource Management (BRM)",
                category: "Deck Training", regulatory_basis: "STCW A-II/1, A-II/2",
                has_expiry: false, typical_years: None, notes: "" },
            DocTemplate { id: "sso", title: "Ship Security Officer (SSO)",
                category: "STCW Mandatory", regulatory_basis: "STCW VI/5",
                has_expiry: false, typical_years: None, notes: "ISPS Code" },
        ],
        "chief_officer" => vec![
            DocTemplate { id: "coc_chief_officer", title: "Certificate of Competency — Chief Mate",
                category: "Certificate of Competency", regulatory_basis: "STCW II/2",
                has_expiry: true, typical_years: Some(5), notes: "Chief Mate on ships >= 3000 GT" },
            DocTemplate { id: "gmdss_goc", title: "GMDSS General Operator's Certificate (GOC)",
                category: "Certificate of Competency", regulatory_basis: "STCW IV/2",
                has_expiry: true, typical_years: Some(5), notes: "" },
            DocTemplate { id: "ecdis", title: "ECDIS Generic Training",
                category: "Deck Training", regulatory_basis: "STCW A-II/1, A-II/2",
                has_expiry: false, typical_years: None, notes: "Generic ECDIS competence required for deck officers. Equipment/type-specific ECDIS certificates are added separately." },
            DocTemplate { id: "radar_arpa", title: "Radar Navigation, Radar Plotting and ARPA",
                category: "Deck Training", regulatory_basis: "STCW A-II/1, A-II/2",
                has_expiry: false, typical_years: None, notes: "Radar observer / ARPA training" },
            DocTemplate { id: "brm", title: "Bridge Resource Management (BRM)",
                category: "Deck Training", regulatory_basis: "STCW A-II/1, A-II/2",
                has_expiry: false, typical_years: None, notes: "" },
        ],
        "second_officer" | "third_officer" => vec![
            DocTemplate { id: "coc_oow", title: "Certificate of Competency — Officer in Charge of a Navigational Watch",
                category: "Certificate of Competency", regulatory_basis: "STCW II/1",
                has_expiry: true, typical_years: Some(5), notes: "OOW Deck" },
            DocTemplate { id: "gmdss_goc", title: "GMDSS General Operator's Certificate (GOC)",
                category: "Certificate of Competency", regulatory_basis: "STCW IV/2",
                has_expiry: true, typical_years: Some(5), notes: "" },
            DocTemplate { id: "ecdis", title: "ECDIS Generic Training",
                category: "Deck Training", regulatory_basis: "STCW A-II/1",
                has_expiry: false, typical_years: None, notes: "Generic ECDIS competence required for deck officers. Equipment/type-specific ECDIS certificates are added separately." },
            DocTemplate { id: "radar_arpa", title: "Radar Navigation, Radar Plotting and ARPA",
                category: "Deck Training", regulatory_basis: "STCW A-II/1",
                has_expiry: false, typical_years: None, notes: "Radar observer / ARPA training" },
        ],

        // Management - Engine
        "chief_engineer" => vec![
            DocTemplate { id: "coc_chief_eng", title: "Certificate of Competency — Chief Engineer Officer",
                category: "Certificate of Competency", regulatory_basis: "STCW III/2",
                has_expiry: true, typical_years: Some(5), notes: "Power >= 3000 kW" },
            DocTemplate { id: "erm", title: "Engine Room Resource Management (ERM)",
                category: "Engine Training", regulatory_basis: "STCW A-III/1, A-III/2",
                has_expiry: false, typical_years: None, notes: "" },
            DocTemplate { id: "high_voltage_mgmt", title: "High Voltage Operations (Management)",
                category: "Engine Training", regulatory_basis: "STCW A-III/2",
                has_expiry: false, typical_years: None, notes: "If HV installation aboard" },
        ],
        "second_engineer" => vec![
            DocTemplate { id: "coc_second_eng", title: "Certificate of Competency — Second Engineer Officer",
                category: "Certificate of Competency", regulatory_basis: "STCW III/2",
                has_expiry: true, typical_years: Some(5), notes: "" },
            DocTemplate { id: "erm", title: "Engine Room Resource Management (ERM)",
                category: "Engine Training", regulatory_basis: "STCW A-III/2",
                has_expiry: false, typical_years: None, notes: "" },
        ],
        "third_engineer" | "fourth_engineer" => vec![
            DocTemplate { id: "coc_eoow", title: "Certificate of Competency — Engineer Officer in Charge of a Watch",
                category: "Certificate of Competency", regulatory_basis: "STCW III/1",
                has_expiry: true, typical_years: Some(5), notes: "EOOW" },
            DocTemplate { id: "erm", title: "Engine Room Resource Management (ERM)",
                category: "Engine Training", regulatory_basis: "STCW A-III/1",
                has_expiry: false, typical_years: None, notes: "" },
        ],
        "eto" => vec![
            DocTemplate { id: "coc_eto", title: "Certificate of Competency — Electro-Technical Officer",
                category: "Certificate of Competency", regulatory_basis: "STCW III/6",
                has_expiry: true, typical_years: Some(5), notes: "" },
            DocTemplate { id: "high_voltage_op", title: "High Voltage Operations",
                category: "Engine Training", regulatory_basis: "STCW A-III/6",
                has_expiry: false, typical_years: None, notes: "" },
        ],

        // Support
        "bosun" | "ab" => vec![
            DocTemplate { id: "able_seafarer_deck", title: "Able Seafarer Deck",
                category: "Ratings Certificate", regulatory_basis: "STCW II/5",
                has_expiry: true, typical_years: Some(5), notes: "" },
            DocTemplate { id: "rating_navwatch", title: "Rating Forming Part of a Navigational Watch",
                category: "Ratings Certificate", regulatory_basis: "STCW II/4",
                has_expiry: true, typical_years: Some(5), notes: "" },
        ],
        "os" => vec![
            DocTemplate { id: "rating_navwatch", title: "Rating Forming Part of a Navigational Watch",
                category: "Ratings Certificate", regulatory_basis: "STCW II/4",
                has_expiry: true, typical_years: Some(5), notes: "" },
        ],
        "motorman" => vec![
            DocTemplate { id: "able_seafarer_engine", title: "Able Seafarer Engine",
                category: "Ratings Certificate", regulatory_basis: "STCW III/5",
                has_expiry: true, typical_years: Some(5), notes: "" },
            DocTemplate { id: "rating_engwatch", title: "Rating Forming Part of an Engine Room Watch",
                category: "Ratings Certificate", regulatory_basis: "STCW III/4",
                has_expiry: true, typical_years: Some(5), notes: "" },
        ],
        "wiper" => vec![
            DocTemplate { id: "rating_engwatch", title: "Rating Forming Part of an Engine Room Watch",
                category: "Ratings Certificate", regulatory_basis: "STCW III/4",
                has_expiry: true, typical_years: Some(5), notes: "" },
        ],
        "ete" => vec![
            DocTemplate { id: "rating_eto", title: "Electro-Technical Rating",
                category: "Ratings Certificate", regulatory_basis: "STCW III/7",
                has_expiry: true, typical_years: Some(5), notes: "" },
        ],
        "cook" => vec![
            DocTemplate { id: "ships_cook", title: "Ship's Cook Certificate",
                category: "Catering", regulatory_basis: "MLC 2006 A3.2",
                has_expiry: false, typical_years: None, notes: "" },
            DocTemplate { id: "food_hygiene", title: "Food Safety & Hygiene",
                category: "Catering", regulatory_basis: "MLC 2006 A3.2",
                has_expiry: true, typical_years: Some(5), notes: "" },
        ],
        _ => vec![],
    }
}

// --- Vessel-specific extras ---------------------------------------------

pub fn vessel_extras(vessel_id: &str, level: StcwLevel) -> Vec<DocTemplate> {
    use StcwLevel::*;
    match (vessel_id, level) {
        // Oil / Chemical tankers — basic training covers both (grouped in STCW V/1-1)
        ("oil_tanker", Support) | ("chemical_tanker", Support) => vec![DocTemplate {
            id: "tank_basic_oilchem",
            title: "Basic Training for Oil and Chemical Tanker Cargo Operations",
            category: "Tanker Training",
            regulatory_basis: "STCW V/1-1-1",
            has_expiry: false,
            typical_years: None,
            notes: "",
        }],
        ("oil_tanker", Operational) | ("oil_tanker", Management) => vec![
            DocTemplate {
                id: "tank_basic_oilchem",
                title: "Basic Training for Oil and Chemical Tanker Cargo Operations",
                category: "Tanker Training",
                regulatory_basis: "STCW V/1-1-1",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
            DocTemplate {
                id: "tank_adv_oil",
                title: "Advanced Training for Oil Tanker Cargo Operations",
                category: "Tanker Training",
                regulatory_basis: "STCW V/1-1-2",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
            DocTemplate {
                id: "cof_oil",
                title: "Certificate of Fitness (Oil)",
                category: "Tanker Documents",
                regulatory_basis: "MARPOL Annex I",
                has_expiry: true,
                typical_years: Some(5),
                notes: "Vessel-level, listed for reference",
            },
        ],
        ("chemical_tanker", Operational) | ("chemical_tanker", Management) => vec![
            DocTemplate {
                id: "tank_basic_oilchem",
                title: "Basic Training for Oil and Chemical Tanker Cargo Operations",
                category: "Tanker Training",
                regulatory_basis: "STCW V/1-1-1",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
            DocTemplate {
                id: "tank_adv_chem",
                title: "Advanced Training for Chemical Tanker Cargo Operations",
                category: "Tanker Training",
                regulatory_basis: "STCW V/1-1-3",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
        ],
        ("gas_carrier", Support) => vec![DocTemplate {
            id: "tank_basic_gas",
            title: "Basic Training for Liquefied Gas Tanker Cargo Operations",
            category: "Tanker Training",
            regulatory_basis: "STCW V/1-2-1",
            has_expiry: false,
            typical_years: None,
            notes: "",
        }],
        ("gas_carrier", Operational) | ("gas_carrier", Management) => vec![
            DocTemplate {
                id: "tank_basic_gas",
                title: "Basic Training for Liquefied Gas Tanker Cargo Operations",
                category: "Tanker Training",
                regulatory_basis: "STCW V/1-2-1",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
            DocTemplate {
                id: "tank_adv_gas",
                title: "Advanced Training for Liquefied Gas Tanker Cargo Operations",
                category: "Tanker Training",
                regulatory_basis: "STCW V/1-2-2",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
        ],

        // Passenger ships
        ("passenger", _) => vec![
            DocTemplate {
                id: "pax_crowd",
                title: "Crowd Management Training",
                category: "Passenger Ship Training",
                regulatory_basis: "STCW V/2",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
            DocTemplate {
                id: "pax_crisis",
                title: "Crisis Management and Human Behaviour Training",
                category: "Passenger Ship Training",
                regulatory_basis: "STCW V/2",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
            DocTemplate {
                id: "pax_safety",
                title: "Passenger Safety, Cargo Safety and Hull Integrity Training",
                category: "Passenger Ship Training",
                regulatory_basis: "STCW V/2",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
        ],

        _ => vec![],
    }
}

// --- Optional categories -------------------------------------------------
//
// Docs in these categories are pre-seeded (same as mandatory), but the UI
// should NOT mark them red when file is missing, and should place them at
// the end of the document tree. Banking is the canonical example — every
// seafarer has a bank account, but filling it in is not a regulatory
// requirement and shouldn't display as "missing mandatory doc".

pub fn optional_categories() -> Vec<&'static str> {
    vec!["Banking"]
}

// --- Build a complete required set for a profile ------------------------

fn merge(
    out: &mut Vec<DocTemplate>,
    seen: &mut std::collections::HashSet<&'static str>,
    v: Vec<DocTemplate>,
) {
    for t in v {
        if seen.insert(t.id) {
            out.push(t);
        }
    }
}

pub fn required_docs_for_profile(
    level: StcwLevel,
    vessel_id: &str,
    pos_id: &str,
) -> Vec<DocTemplate> {
    let mut out: Vec<DocTemplate> = Vec::new();
    let mut seen: std::collections::HashSet<&'static str> = std::collections::HashSet::new();
    merge(&mut out, &mut seen, universal_base());
    merge(&mut out, &mut seen, level_base(level));
    merge(&mut out, &mut seen, position_docs(pos_id));
    merge(&mut out, &mut seen, vessel_extras(vessel_id, level));
    out
}

pub fn all_seafarer_doc_templates() -> Vec<DocTemplate> {
    let mut out: Vec<DocTemplate> = Vec::new();
    let mut seen: std::collections::HashSet<&'static str> = std::collections::HashSet::new();
    merge(&mut out, &mut seen, universal_base());
    for level in StcwLevel::all() {
        merge(&mut out, &mut seen, level_base(*level));
    }
    for pos in positions() {
        merge(&mut out, &mut seen, position_docs(pos.id));
    }
    for vessel in vessel_tree().into_iter().filter(|v| v.is_leaf) {
        for level in StcwLevel::all() {
            merge(&mut out, &mut seen, vessel_extras(vessel.id, *level));
        }
    }
    merge(&mut out, &mut seen, conditional_seafarer_doc_templates());
    merge(&mut out, &mut seen, catalog_only_seafarer_doc_templates());
    out
}

pub fn conditional_seafarer_doc_templates() -> Vec<DocTemplate> {
    vec![
        DocTemplate { id: "polar_basic", title: "Basic Training for Ships Operating in Polar Waters",
            category: "STCW Specific", regulatory_basis: "STCW V/4; Polar Code",
            has_expiry: true, typical_years: Some(5), notes: "Required when serving on ships operating in polar waters, by role and duties" },
        DocTemplate { id: "polar_advanced", title: "Advanced Training for Ships Operating in Polar Waters",
            category: "STCW Specific", regulatory_basis: "STCW V/4; Polar Code",
            has_expiry: true, typical_years: Some(5), notes: "Advanced polar/ice navigation training for masters and officers with operational duties in polar waters" },
        DocTemplate { id: "flag_coc_endorsement", title: "Flag CoC Endorsement",
            category: "Flag CoC Endorsement", regulatory_basis: "STCW I/10; Flag State",
            has_expiry: true, typical_years: Some(5), notes: "Flag-state recognition/endorsement of a foreign Certificate of Competency. Usually needed when ship flag differs from the seafarer's issuing administration." },
        DocTemplate { id: "flag_seamans_book", title: "Flag Seaman's Book",
            category: "Flag Seaman's Book", regulatory_basis: "Flag State",
            has_expiry: true, typical_years: Some(5), notes: "Flag-state seaman's book/discharge book. Usually needed when serving under a flag different from the seafarer's national book." },
    ]
}

pub fn catalog_only_seafarer_doc_templates() -> Vec<DocTemplate> {
    vec![
        DocTemplate { id: "seamans_book", title: "Seaman's Book (Discharge Book)",
            category: "Seaman's Book", regulatory_basis: "National (flag state)",
            has_expiry: false, typical_years: None, notes: "Additional national or discharge book if separate from the primary seafarer identity document." },
        DocTemplate { id: "visa_us", title: "USA Visa (C1/D)",
            category: "Visas", regulatory_basis: "US Immigration and Nationality Act",
            has_expiry: true, typical_years: Some(10), notes: "Transit/crewman visa. Optional unless a vacancy, flag, port call, or employer specifically requires it." },
        DocTemplate { id: "visa_schengen", title: "Schengen Visa",
            category: "Visas", regulatory_basis: "EU Regulation 810/2009 (Visa Code)",
            has_expiry: true, typical_years: Some(5), notes: "Useful for crew changes in EU ports. Optional unless a vacancy, route, or employer specifically requires it." },
        DocTemplate { id: "dangerous_hazardous_substances", title: "Dangerous and Hazardous Substances (Solid Bulk and Packaged)",
            category: "Bulk Carrier Specific", regulatory_basis: "STCW B-V/b, B-V/c; IMDG/IMSBC Code",
            has_expiry: true, typical_years: Some(5), notes: "Cargo-specific training for ships carrying dangerous and hazardous substances in solid bulk or packaged form" },
    ]
}

pub fn doc_template_by_title_or_id(value: &str) -> Option<DocTemplate> {
    let key = normalized_lookup_key(value);
    if key.is_empty() {
        return None;
    }
    let alias_id = match key.as_str() {
        "sso" | "shipsecurityofficer" | "shipsecurityofficersso" => Some("sso"),
        "dsd" | "designatedsecurityduties" => Some("dsd"),
        "ecdis" | "ecdistraining" | "ecdisgeneric" | "ecdisgenerictraining" => Some("ecdis"),
        "radar" | "arpa" | "radararpa" | "radarnavigationradarplottingandarpa" => {
            Some("radar_arpa")
        }
        "polar" | "polarwaters" | "polarcode" | "ice" | "icenavigation" => Some("polar_basic"),
        "polaradvanced"
        | "polarwatersadvanced"
        | "polarcodeadvanced"
        | "iceadvanced"
        | "icenavigationadvanced"
        | "icenavigationadvancedtraining"
        | "advancedtrainingforshipsoperatinginpolarwaters" => Some("polar_advanced"),
        "polarbasic"
        | "polarwatersbasic"
        | "polarcodebasic"
        | "basictrainingforshipsoperatinginpolarwaters" => Some("polar_basic"),
        "dangerousgoods"
        | "dangerouscargo"
        | "hazmat"
        | "hazardoussubstances"
        | "dangerousandhazardoussubstances"
        | "dangerousandhazardoussubstancessolidbulkandpackaged"
        | "shipscarryingdangerousandhazardoussubstancesinsolidformbulkandpackagedform"
        | "shipscarryingdangerousandhazardoussubstancesinsolidforminbulkandinpackagedform"
        | "solidbulkdangerousgoods"
        | "bulkcarrierdangerousgoods" => Some("dangerous_hazardous_substances"),
        "flagcocendorsement"
        | "flagstatecocendorsement"
        | "cocendorsement"
        | "certificateofendorsement"
        | "flagendorsement"
        | "endorsementcertificate"
        | "flagstateendorsement" => Some("flag_coc_endorsement"),
        "flagseamansbook"
        | "flagseamanbook"
        | "flagdischargebook"
        | "flagbook"
        | "flagstateseamansbook"
        | "flagstateseamanbook" => Some("flag_seamans_book"),
        "sid" | "seafarersidentitydocument" | "seafarersidentitydocumentsid" => Some("sid"),
        "goc" | "gmdssgoc" | "gmdssgeneraloperatorscertificate" => Some("gmdss_goc"),
        _ => None,
    };
    all_seafarer_doc_templates().into_iter().find(|t| {
        Some(t.id) == alias_id
            || normalized_lookup_key(t.id) == key
            || normalized_lookup_key(t.title) == key
    })
}

// ================================================================================
// Applicable regulatory frameworks
// ================================================================================
//
// A "framework" is a high-level instrument (convention, code, national law) whose
// provisions apply to a specific profile. The wizard renders these as a panel so the
// user can see WHY a document set was generated — e.g. "Second Officer on a bulker
// is governed by STCW II/1, SOLAS V/14, MLC 2006, MARPOL Annex V + VI, and the flag
// state's national CoC regime."
//
// Keep strings terse: short_name is what fits on a chip; articles[] lists the exact
// regulations or chapters; note is a one-liner users actually read.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Framework {
    pub short_name: &'static str,    // "STCW"
    pub full_name: &'static str, // "Standards of Training, Certification and Watchkeeping, 1978 as amended"
    pub scope: &'static str,     // "seafarer" | "vessel" | "both"
    pub articles: Vec<&'static str>, // ["II/1", "VI/1", "A-II/1"]
    pub note: &'static str,      // human-readable one-liner
    pub requires: Vec<&'static str>, // certificates / documents mandated by this framework
    pub explanation: &'static str, // 1–2 sentence plain-English "why it applies & what it mandates"
}

fn fw(
    short: &'static str,
    full: &'static str,
    scope: &'static str,
    articles: &[&'static str],
    note: &'static str,
) -> Framework {
    Framework {
        short_name: short,
        full_name: full,
        scope,
        articles: articles.to_vec(),
        note,
        requires: Vec::new(),
        explanation: "",
    }
}

fn fw_req(
    short: &'static str,
    full: &'static str,
    scope: &'static str,
    articles: &[&'static str],
    note: &'static str,
    requires: &[&'static str],
    explanation: &'static str,
) -> Framework {
    Framework {
        short_name: short,
        full_name: full,
        scope,
        articles: articles.to_vec(),
        note,
        requires: requires.to_vec(),
        explanation,
    }
}

/// Frameworks applicable to a seafarer profile.
/// Always includes: STCW (competency + safety), MLC (labour+medical), WHO IHR,
/// ILO C185, ICAO 9303, flag state. Adds SOLAS for deck OOW+, MARPOL chapters for
/// tankers, STCW V/2 for passenger ships, STCW V/1-x for tanker variants.
pub fn applicable_frameworks_for_seafarer(
    level: StcwLevel,
    vessel_id: &str,
    pos_id: &str,
) -> Vec<Framework> {
    let mut out: Vec<Framework> = Vec::new();

    // Universal identity
    out.push(fw_req("ICAO 9303", "Machine Readable Travel Documents", "seafarer",
        &["Part 4"],
        "Sets the standard for the seafarer's travel passport.",
        &["Passport (MRP)"],
        "ICAO Doc 9303 mandates that every crew member crossing borders holds a machine-readable travel document — i.e. a passport."));
    out.push(fw_req("ILO C185", "Seafarers' Identity Documents Convention (Revised), 2003", "seafarer",
        &["Art. 2–5"],
        "Governs the biometric Seafarer's Identity Document (SID).",
        &["Seafarer's Identity Document (SID)"],
        "ILO C185 requires the flag state to issue a biometric SID, which port states accept for shore leave."));
    out.push(fw_req("Flag State", "National legislation of the flag administration", "both",
        &["Seaman's Book", "Certificate of Competency endorsement"],
        "Seaman's Book and endorsement of CoCs are issued under national law.",
        &["Seaman's Book / Discharge Book", "CoC Flag-State Endorsement"],
        "The flag state requires a Seaman's Book (service record) and endorsement of any foreign Certificate of Competency before the seafarer can sign on."));

    // Medical & labour
    out.push(fw_req("MLC 2006", "Maritime Labour Convention, 2006 (as amended)", "both",
        &["Regulation 1.2", "Regulation 4.1", "A1.2 / A3.2"],
        "Medical fitness, accommodation, food, hours of rest, employment contract.",
        &["Medical Fitness Certificate (MLC/STCW)", "Seafarer Employment Agreement (SEA)"],
        "MLC 2006 requires every seafarer to hold a valid medical fitness certificate and a written Seafarer Employment Agreement before going to sea."));
    out.push(fw_req("WHO IHR 2005", "International Health Regulations (2005)", "seafarer",
        &["Annex 6 – Vaccination Certificates"],
        "Yellow fever and other vaccinations required for port calls.",
        &["International Certificate of Vaccination (Yellow Card)"],
        "IHR 2005 requires an International Certificate of Vaccination (Yellow Fever and others) for seafarers calling at endemic ports."));

    // STCW — always applies, but the articles cited depend on role
    let mut stcw_articles: Vec<&'static str> = Vec::new();
    stcw_articles.push("Chapter VI — Emergency, occupational safety, medical & survival functions");
    stcw_articles.push("VI/1 Basic Safety Training");
    stcw_articles.push("VI/2 Survival Craft & Rescue Boats");
    stcw_articles.push("VI/6-1 Security Awareness");
    if matches!(level, StcwLevel::Operational | StcwLevel::Management) {
        stcw_articles.push("VI/3 Advanced Firefighting");
        stcw_articles.push("VI/4-1 Medical First Aid");
    }
    if matches!(level, StcwLevel::Management) {
        stcw_articles.push("VI/4-2 Medical Care");
        stcw_articles.push("VI/6-2 Designated Security Duties");
    }

    // Deck
    if matches!(pos_id, "master" | "chief_officer") {
        stcw_articles.push("II/2 Master and Chief Mate ≥ 500 GT");
        stcw_articles.push("IV/2 GMDSS General Operator");
        stcw_articles.push("A-II/1, A-II/2 ECDIS, Radar/ARPA, BRM");
    } else if matches!(pos_id, "second_officer" | "third_officer") {
        stcw_articles.push("II/1 Officer in Charge of a Navigational Watch");
        stcw_articles.push("IV/2 GMDSS General Operator");
        stcw_articles.push("A-II/1 ECDIS, Radar/ARPA, BRM");
    } else if matches!(pos_id, "bosun" | "ab") {
        stcw_articles.push("II/4 Rating forming part of a Navigational Watch");
        stcw_articles.push("II/5 Able Seafarer Deck");
    } else if pos_id == "os" {
        stcw_articles.push("II/4 Rating forming part of a Navigational Watch");
    }
    // Engine
    else if matches!(pos_id, "chief_engineer" | "second_engineer") {
        stcw_articles.push("III/2 Chief Engineer and Second Engineer ≥ 3000 kW");
        stcw_articles.push("A-III/2 Engine Room Resource Management");
    } else if matches!(pos_id, "third_engineer" | "fourth_engineer") {
        stcw_articles.push("III/1 Officer in Charge of an Engineering Watch");
        stcw_articles.push("A-III/1 Engine Room Resource Management");
    } else if pos_id == "eto" {
        stcw_articles.push("III/6 Electro-Technical Officer");
        stcw_articles.push("A-III/6 High Voltage Operations");
    } else if pos_id == "motorman" {
        stcw_articles.push("III/4 Rating forming part of an Engine Watch");
        stcw_articles.push("III/5 Able Seafarer Engine");
    } else if pos_id == "wiper" {
        stcw_articles.push("III/4 Rating forming part of an Engine Watch");
    } else if pos_id == "ete" {
        stcw_articles.push("III/7 Electro-Technical Rating");
    }

    // Vessel-specific STCW endorsements
    match vessel_id {
        "oil_tanker" => {
            stcw_articles.push("V/1-1-1 Basic Oil & Chemical Tanker Training");
            if matches!(level, StcwLevel::Operational | StcwLevel::Management) {
                stcw_articles.push("V/1-1-2 Advanced Oil Tanker Training");
            }
        }
        "chemical_tanker" => {
            stcw_articles.push("V/1-1-1 Basic Oil & Chemical Tanker Training");
            if matches!(level, StcwLevel::Operational | StcwLevel::Management) {
                stcw_articles.push("V/1-1-3 Advanced Chemical Tanker Training");
            }
        }
        "gas_carrier" => {
            stcw_articles.push("V/1-2-1 Basic Liquefied Gas Tanker Training");
            if matches!(level, StcwLevel::Operational | StcwLevel::Management) {
                stcw_articles.push("V/1-2-2 Advanced Liquefied Gas Tanker Training");
            }
        }
        "passenger" => {
            stcw_articles.push("V/2 Passenger Ship Training (crowd, crisis, safety)");
        }
        _ => {}
    }

    // STCW certificates change with role — build a per-role `requires` list.
    let mut stcw_requires: Vec<&'static str> = vec![
        "Certificate of Competency (CoC)",
        "Basic Safety Training (VI/1)",
        "Proficiency in Survival Craft & Rescue Boats (VI/2)",
        "Security Awareness (VI/6-1)",
    ];
    if matches!(level, StcwLevel::Operational | StcwLevel::Management) {
        stcw_requires.push("Advanced Fire Fighting (VI/3)");
        stcw_requires.push("Medical First Aid (VI/4-1)");
        stcw_requires.push("GMDSS General Operator (IV/2)");
    }
    if matches!(level, StcwLevel::Management) {
        stcw_requires.push("Medical Care on Board (VI/4-2)");
        stcw_requires.push("Designated Security Duties (VI/6-2)");
    }
    if matches!(pos_id, "master" | "chief_officer" | "second_officer" | "third_officer") {
        stcw_requires.push("ECDIS Training Certificate");
        stcw_requires.push("Radar / ARPA Training");
    }
    if matches!(pos_id, "master" | "chief_officer") {
        stcw_requires.push("Bridge Resource Management");
    }
    if matches!(
        pos_id,
        "chief_engineer" | "second_engineer" | "third_engineer" | "fourth_engineer"
    ) {
        stcw_requires.push("Engine Room Resource Management");
    }
    if pos_id == "eto" {
        stcw_requires.push("High Voltage Operations Certificate");
    }
    match vessel_id {
        "oil_tanker" => {
            stcw_requires.push("Basic Oil & Chemical Tanker Training (V/1-1-1)");
            if matches!(level, StcwLevel::Operational | StcwLevel::Management) {
                stcw_requires.push("Advanced Oil Tanker Training (V/1-1-2)");
            }
        }
        "chemical_tanker" => {
            stcw_requires.push("Basic Oil & Chemical Tanker Training (V/1-1-1)");
            if matches!(level, StcwLevel::Operational | StcwLevel::Management) {
                stcw_requires.push("Advanced Chemical Tanker Training (V/1-1-3)");
            }
        }
        "gas_carrier" => {
            stcw_requires.push("Basic Liquefied Gas Tanker Training (V/1-2-1)");
            if matches!(level, StcwLevel::Operational | StcwLevel::Management) {
                stcw_requires.push("Advanced Liquefied Gas Tanker Training (V/1-2-2)");
            }
        }
        "passenger" => {
            stcw_requires.push("Passenger Ship Training (V/2)");
        }
        _ => {}
    }

    out.push(Framework {
        short_name: "STCW",
        full_name: "Standards of Training, Certification and Watchkeeping, 1978 as amended (Manila 2010)",
        scope: "seafarer",
        articles: stcw_articles,
        note: "Defines competency, watchkeeping and safety training for all crew.",
        requires: stcw_requires,
        explanation: "STCW sets the global minimum for seafarer competency: every crew member needs the core safety cluster (VI/1–VI/6), and each rank/department adds specialised tickets. Tanker/passenger service adds further endorsements before sign-on.",
    });

    // SOLAS / ISPS — any seafarer serving on a SOLAS ship is subject to these
    out.push(fw_req("SOLAS", "International Convention for the Safety of Life at Sea, 1974", "both",
        &["Chapter V/14 Manning", "Chapter III Life-saving", "Chapter XI-1/XI-2 ISPS"],
        "Safety of navigation, life-saving appliances, ship security.",
        &["Familiarisation with ship-specific LSA/FFA", "Muster-list position assignment"],
        "SOLAS requires that every seafarer joining a SOLAS ship receives documented familiarisation with its life-saving and fire-fighting appliances before taking up watchkeeping duties."));
    out.push(fw_req("ISPS Code", "International Ship and Port Facility Security Code", "both",
        &["Part A", "Section 13 Training and drills"],
        "Security awareness (VI/6-1) and designated security duties (VI/6-2).",
        &["Security Awareness Training (VI/6-1)"],
        "ISPS requires that every crew member holds Security Awareness training; officers with security duties additionally need Designated Security Duties (VI/6-2)."));

    // Cook-specific MLC A3.2
    if pos_id == "cook" {
        out.push(fw_req("MLC 2006 A3.2", "Food and catering — Certified Ship's Cook", "seafarer",
            &["Standard A3.2 paragraphs 2–4"],
            "Ship's Cook must hold a certificate recognised by the flag state.",
            &["Ship's Cook Certificate"],
            "MLC A3.2 mandates that ships operating with a prescribed manning of ten or more must carry a fully qualified Ship's Cook holding a flag-state-recognised certificate."));
    }

    // ISM applies indirectly via the employer's SMS
    out.push(fw_req("ISM Code", "International Safety Management Code", "both",
        &["Chapter 6 Resources and Personnel"],
        "Every seafarer must be familiarised with the company SMS before assuming duties.",
        &["SMS Familiarisation Record", "Ship-specific Familiarisation Checklist"],
        "The ISM Code requires the company to give each seafarer documented familiarisation with its Safety Management System and ship-specific procedures before taking up duties."));

    out
}

// ================================================================================
// Vessel profile system
// ================================================================================

/// Vessel size band (GT) — drives applicability of SOLAS, Load Line, Manning rules.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VesselSize {
    Under500,   // < 500 GT — reduced SOLAS applicability
    Under3000,  // 500–2999 GT
    Under10000, // 3000–9999 GT
    Under50000, // 10000–49999 GT
    Over50000,  // ≥ 50000 GT
}

impl VesselSize {
    pub fn id(&self) -> &'static str {
        match self {
            VesselSize::Under500 => "under_500",
            VesselSize::Under3000 => "under_3000",
            VesselSize::Under10000 => "under_10000",
            VesselSize::Under50000 => "under_50000",
            VesselSize::Over50000 => "over_50000",
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            VesselSize::Under500 => "< 500 GT",
            VesselSize::Under3000 => "500 – 2 999 GT",
            VesselSize::Under10000 => "3 000 – 9 999 GT",
            VesselSize::Under50000 => "10 000 – 49 999 GT",
            VesselSize::Over50000 => "≥ 50 000 GT",
        }
    }
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "under_500" => Some(VesselSize::Under500),
            "under_3000" => Some(VesselSize::Under3000),
            "under_10000" => Some(VesselSize::Under10000),
            "under_50000" => Some(VesselSize::Under50000),
            "over_50000" => Some(VesselSize::Over50000),
            _ => None,
        }
    }
    pub fn all() -> &'static [VesselSize] {
        &[
            VesselSize::Under500,
            VesselSize::Under3000,
            VesselSize::Under10000,
            VesselSize::Under50000,
            VesselSize::Over50000,
        ]
    }
    pub fn is_solas(&self) -> bool {
        !matches!(self, VesselSize::Under500)
    }
}

/// Trading area — affects Load Line, MARPOL Annex VI ECA, ISPS port-state controls.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TradeArea {
    International,
    Coastal,  // limited to flag-state waters
    Domestic, // inland / sheltered
}

impl TradeArea {
    pub fn id(&self) -> &'static str {
        match self {
            TradeArea::International => "international",
            TradeArea::Coastal => "coastal",
            TradeArea::Domestic => "domestic",
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            TradeArea::International => "International voyages",
            TradeArea::Coastal => "Coastal / near-coastal",
            TradeArea::Domestic => "Domestic / sheltered",
        }
    }
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "international" => Some(TradeArea::International),
            "coastal" => Some(TradeArea::Coastal),
            "domestic" => Some(TradeArea::Domestic),
            _ => None,
        }
    }
    pub fn all() -> &'static [TradeArea] {
        &[
            TradeArea::International,
            TradeArea::Coastal,
            TradeArea::Domestic,
        ]
    }
}

// --- Vessel document templates (statutory / class / operations) ---------

/// Statutory base — present on virtually every commercial ship ≥ 500 GT on
/// international voyages. Individual items are trimmed further below depending
/// on size / trade / type.
fn vessel_statutory_base() -> Vec<DocTemplate> {
    vec![
        DocTemplate {
            id: "v_registry",
            title: "Certificate of Registry",
            category: "Statutory Certificates",
            regulatory_basis: "National (flag state)",
            has_expiry: false,
            typical_years: None,
            notes: "Nationality and ownership",
        },
        DocTemplate {
            id: "v_itc",
            title: "International Tonnage Certificate (ITC 1969)",
            category: "Statutory Certificates",
            regulatory_basis: "Tonnage Convention 1969",
            has_expiry: false,
            typical_years: None,
            notes: "",
        },
        DocTemplate {
            id: "v_illc",
            title: "International Load Line Certificate (ILLC)",
            category: "Statutory Certificates",
            regulatory_basis: "Load Lines 1966 / Protocol 1988",
            has_expiry: true,
            typical_years: Some(5),
            notes: "Annual/intermediate/renewal surveys",
        },
        DocTemplate {
            id: "v_msm",
            title: "Minimum Safe Manning Certificate",
            category: "Statutory Certificates",
            regulatory_basis: "SOLAS V/14",
            has_expiry: false,
            typical_years: None,
            notes: "Flag State",
        },
        DocTemplate {
            id: "v_csr",
            title: "Continuous Synopsis Record (CSR)",
            category: "Statutory Certificates",
            regulatory_basis: "SOLAS XI-1/5",
            has_expiry: false,
            typical_years: None,
            notes: "History of ownership/flag",
        },
    ]
}

/// SOLAS certificates required only on ships subject to SOLAS (≥ 500 GT, international).
fn vessel_solas_certificates() -> Vec<DocTemplate> {
    vec![
        DocTemplate {
            id: "v_scc",
            title: "Safety Construction Certificate (SCC)",
            category: "SOLAS Certificates",
            regulatory_basis: "SOLAS Chapter II-1",
            has_expiry: true,
            typical_years: Some(5),
            notes: "",
        },
        DocTemplate {
            id: "v_sec",
            title: "Safety Equipment Certificate (SEC)",
            category: "SOLAS Certificates",
            regulatory_basis: "SOLAS Chapter III",
            has_expiry: true,
            typical_years: Some(5),
            notes: "",
        },
        DocTemplate {
            id: "v_src",
            title: "Safety Radio Certificate (SRC)",
            category: "SOLAS Certificates",
            regulatory_basis: "SOLAS Chapter IV",
            has_expiry: true,
            typical_years: Some(5),
            notes: "",
        },
        DocTemplate {
            id: "v_issc",
            title: "International Ship Security Certificate (ISSC)",
            category: "SOLAS Certificates",
            regulatory_basis: "SOLAS XI-2 / ISPS Code",
            has_expiry: true,
            typical_years: Some(5),
            notes: "",
        },
        DocTemplate {
            id: "v_smc",
            title: "Safety Management Certificate (SMC)",
            category: "SOLAS Certificates",
            regulatory_basis: "SOLAS IX / ISM Code",
            has_expiry: true,
            typical_years: Some(5),
            notes: "Company-specific",
        },
        DocTemplate {
            id: "v_doc",
            title: "Document of Compliance (DOC)",
            category: "SOLAS Certificates",
            regulatory_basis: "SOLAS IX / ISM Code",
            has_expiry: true,
            typical_years: Some(5),
            notes: "Held by the company, copy onboard",
        },
    ]
}

/// MARPOL certificates — always needed on SOLAS ships, specific annexes depend on type.
fn vessel_marpol_certificates(vessel_id: &str) -> Vec<DocTemplate> {
    let mut v = vec![
        DocTemplate {
            id: "v_iopp",
            title: "IOPP Certificate (Oil Pollution Prevention)",
            category: "MARPOL Certificates",
            regulatory_basis: "MARPOL Annex I",
            has_expiry: true,
            typical_years: Some(5),
            notes: "",
        },
        DocTemplate {
            id: "v_ispp",
            title: "ISPP Certificate (Sewage)",
            category: "MARPOL Certificates",
            regulatory_basis: "MARPOL Annex IV",
            has_expiry: true,
            typical_years: Some(5),
            notes: "",
        },
        DocTemplate {
            id: "v_iapp",
            title: "IAPP Certificate (Air Pollution)",
            category: "MARPOL Certificates",
            regulatory_basis: "MARPOL Annex VI",
            has_expiry: true,
            typical_years: Some(5),
            notes: "",
        },
        DocTemplate {
            id: "v_iee",
            title: "IEE Certificate (Energy Efficiency)",
            category: "MARPOL Certificates",
            regulatory_basis: "MARPOL Annex VI Ch. 4",
            has_expiry: false,
            typical_years: None,
            notes: "Technical efficiency",
        },
        DocTemplate {
            id: "v_sopep",
            title: "SOPEP (Shipboard Oil Pollution Emergency Plan)",
            category: "MARPOL Plans",
            regulatory_basis: "MARPOL Annex I Reg. 37",
            has_expiry: false,
            typical_years: None,
            notes: "Approved",
        },
        DocTemplate {
            id: "v_seemp",
            title: "SEEMP (Ship Energy Efficiency Management Plan)",
            category: "MARPOL Plans",
            regulatory_basis: "MARPOL Annex VI Reg. 22",
            has_expiry: false,
            typical_years: None,
            notes: "",
        },
    ];
    if matches!(vessel_id, "oil_tanker" | "chemical_tanker" | "gas_carrier") {
        v.push(DocTemplate {
            id: "v_sobpeep",
            title: "SMPEP (Shipboard Marine Pollution Emergency Plan)",
            category: "MARPOL Plans",
            regulatory_basis: "MARPOL Annex II Reg. 17",
            has_expiry: false,
            typical_years: None,
            notes: "Oil + NLS",
        });
    }
    v
}

/// MLC 2006 (labour) — applies to all ships ≥ 500 GT international.
fn vessel_mlc_certificates() -> Vec<DocTemplate> {
    vec![
        DocTemplate {
            id: "v_mlc",
            title: "Maritime Labour Certificate (MLC)",
            category: "MLC Certificates",
            regulatory_basis: "MLC 2006 Title 5",
            has_expiry: true,
            typical_years: Some(5),
            notes: "",
        },
        DocTemplate {
            id: "v_dmlc1",
            title: "DMLC Part I",
            category: "MLC Certificates",
            regulatory_basis: "MLC 2006 A5.1.3",
            has_expiry: false,
            typical_years: None,
            notes: "Flag state declaration",
        },
        DocTemplate {
            id: "v_dmlc2",
            title: "DMLC Part II",
            category: "MLC Certificates",
            regulatory_basis: "MLC 2006 A5.1.3",
            has_expiry: false,
            typical_years: None,
            notes: "Shipowner declaration",
        },
    ]
}

/// Class + hull / machinery certificates.
fn vessel_class_certificates() -> Vec<DocTemplate> {
    vec![DocTemplate {
        id: "v_class",
        title: "Classification Certificate",
        category: "Class Certificates",
        regulatory_basis: "IACS / Class society rules",
        has_expiry: true,
        typical_years: Some(5),
        notes: "Annual/intermediate/renewal surveys",
    }]
}

/// Liability / insurance certificates — required for most international trading vessels.
fn vessel_liability_certificates(vessel_id: &str) -> Vec<DocTemplate> {
    let mut v = vec![
        DocTemplate {
            id: "v_bunker",
            title: "Bunker Convention Certificate",
            category: "Liability Certificates",
            regulatory_basis: "Bunker Convention 2001",
            has_expiry: true,
            typical_years: Some(1),
            notes: "Pollution damage from bunkers",
        },
        DocTemplate {
            id: "v_wreck",
            title: "Wreck Removal Convention Certificate",
            category: "Liability Certificates",
            regulatory_basis: "Nairobi WRC 2007",
            has_expiry: true,
            typical_years: Some(1),
            notes: "",
        },
        DocTemplate {
            id: "v_pni",
            title: "P&I Club Certificate of Entry",
            category: "Liability Certificates",
            regulatory_basis: "Club rules",
            has_expiry: true,
            typical_years: Some(1),
            notes: "20 Feb renewal standard",
        },
    ];
    if vessel_id == "oil_tanker" {
        v.push(DocTemplate {
            id: "v_clc",
            title: "CLC Certificate (Oil Pollution Liability)",
            category: "Liability Certificates",
            regulatory_basis: "CLC 1992 Protocol",
            has_expiry: true,
            typical_years: Some(1),
            notes: "Required for persistent oil carriage",
        });
    }
    v
}

/// Anti-fouling + Ballast water — environmental add-ons.
fn vessel_environmental_certificates() -> Vec<DocTemplate> {
    vec![
        DocTemplate {
            id: "v_iafs",
            title: "IAFS Certificate (Anti-Fouling)",
            category: "Environmental Certificates",
            regulatory_basis: "AFS Convention 2001",
            has_expiry: false,
            typical_years: None,
            notes: "Re-issued after hull coating",
        },
        DocTemplate {
            id: "v_bwm",
            title: "International Ballast Water Management Certificate",
            category: "Environmental Certificates",
            regulatory_basis: "BWM Convention 2004",
            has_expiry: true,
            typical_years: Some(5),
            notes: "",
        },
    ]
}

/// Type-specific extras (bulk, tanker, passenger).
fn vessel_type_extras(vessel_id: &str) -> Vec<DocTemplate> {
    match vessel_id {
        "bulker" => vec![
            DocTemplate {
                id: "v_grain",
                title: "Document of Authorization (Grain Code)",
                category: "Bulk Carrier Specific",
                regulatory_basis: "SOLAS VI / Grain Code",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
            DocTemplate {
                id: "v_csm",
                title: "Cargo Securing Manual (CSM)",
                category: "Bulk Carrier Specific",
                regulatory_basis: "SOLAS VI/5",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
            DocTemplate {
                id: "v_esp",
                title: "Enhanced Survey Report (ESP)",
                category: "Bulk Carrier Specific",
                regulatory_basis: "SOLAS XI-1/2 + 2011 ESP Code",
                has_expiry: true,
                typical_years: Some(1),
                notes: "",
            },
        ],
        "oil_tanker" | "chemical_tanker" => vec![
            DocTemplate {
                id: "v_cof",
                title: "Certificate of Fitness (IBC/IGC Code)",
                category: "Tanker Specific",
                regulatory_basis: "IBC Code / IGC Code",
                has_expiry: true,
                typical_years: Some(5),
                notes: "Issued with class/SCC",
            },
            DocTemplate {
                id: "v_igs",
                title: "Inert Gas System Certificate",
                category: "Tanker Specific",
                regulatory_basis: "SOLAS II-2/4.5",
                has_expiry: true,
                typical_years: Some(1),
                notes: "",
            },
            DocTemplate {
                id: "v_pa_manual",
                title: "P&A Manual (Tanker)",
                category: "Tanker Specific",
                regulatory_basis: "MARPOL Annex I Reg. 31",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
            DocTemplate {
                id: "v_sire",
                title: "SIRE / CDI Inspection Report",
                category: "Tanker Specific",
                regulatory_basis: "OCIMF SIRE 2.0 / CDI",
                has_expiry: true,
                typical_years: Some(1),
                notes: "Industry scheme",
            },
        ],
        "gas_carrier" => vec![
            DocTemplate {
                id: "v_cof_gas",
                title: "Certificate of Fitness (IGC Code)",
                category: "Tanker Specific",
                regulatory_basis: "IGC Code",
                has_expiry: true,
                typical_years: Some(5),
                notes: "",
            },
            DocTemplate {
                id: "v_pa_manual_gas",
                title: "P&A Manual (Gas Carrier)",
                category: "Tanker Specific",
                regulatory_basis: "IGC Code Ch. 18",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
        ],
        "passenger" => vec![
            DocTemplate {
                id: "v_pax_cert",
                title: "Passenger Ship Safety Certificate",
                category: "Passenger Ship Specific",
                regulatory_basis: "SOLAS I/12 (all annexes)",
                has_expiry: true,
                typical_years: Some(1),
                notes: "Combined SCC/SEC/SRC",
            },
            DocTemplate {
                id: "v_pax_sar",
                title: "SAR Cooperation Plan",
                category: "Passenger Ship Specific",
                regulatory_basis: "SOLAS V/7.3",
                has_expiry: false,
                typical_years: None,
                notes: "",
            },
        ],
        _ => vec![],
    }
}

/// Resolve required vessel documents for (category, size, trade).
pub fn required_docs_for_vessel(
    vessel_id: &str,
    size: VesselSize,
    trade: TradeArea,
) -> Vec<DocTemplate> {
    let mut out: Vec<DocTemplate> = Vec::new();
    let mut seen: std::collections::HashSet<&'static str> = std::collections::HashSet::new();

    merge(&mut out, &mut seen, vessel_statutory_base());

    // SOLAS only for ≥ 500 GT on international trade
    let solas_applies = size.is_solas() && trade == TradeArea::International;
    if solas_applies {
        merge(&mut out, &mut seen, vessel_solas_certificates());
        merge(&mut out, &mut seen, vessel_marpol_certificates(vessel_id));
        merge(&mut out, &mut seen, vessel_mlc_certificates());
        merge(&mut out, &mut seen, vessel_environmental_certificates());
        merge(
            &mut out,
            &mut seen,
            vessel_liability_certificates(vessel_id),
        );
    } else if trade == TradeArea::Coastal && size.is_solas() {
        // Coastal still needs most statutory/MARPOL but relaxed
        merge(&mut out, &mut seen, vessel_marpol_certificates(vessel_id));
        merge(&mut out, &mut seen, vessel_mlc_certificates());
    }

    merge(&mut out, &mut seen, vessel_class_certificates());
    merge(&mut out, &mut seen, vessel_type_extras(vessel_id));
    out
}

/// Frameworks applicable to a vessel profile.
pub fn applicable_frameworks_for_vessel(
    vessel_id: &str,
    size: VesselSize,
    trade: TradeArea,
) -> Vec<Framework> {
    let mut out: Vec<Framework> = Vec::new();

    // Always
    out.push(fw_req("Flag State", "National maritime law of the flag administration", "vessel",
        &["Registry", "Minimum Safe Manning", "Tonnage"],
        "Vessel's nationality, crew complement and statutory surveys.",
        &["Certificate of Registry", "Minimum Safe Manning Document", "Continuous Synopsis Record (CSR)"],
        "The flag state registers the ship, assigns its nationality and issues the Minimum Safe Manning Document that defines the required crew complement."));
    out.push(fw_req("Tonnage 1969", "International Convention on Tonnage Measurement of Ships, 1969", "vessel",
        &["Art. 3–5"],
        "Basis for GT/NT figures used across all other conventions.",
        &["International Tonnage Certificate (ITC 1969)"],
        "The Tonnage Convention requires an International Tonnage Certificate (ITC 1969) stating the ship's gross and net tonnage — the figures used to trigger SOLAS, Load Lines and MARPOL thresholds."));
    out.push(fw_req("Load Lines 1966", "International Convention on Load Lines, 1966 (Protocol 1988)", "vessel",
        &["Annex I Reg. 10 – Surveys", "Reg. 27 – Freeboard"],
        "Freeboard assignment, watertight/weathertight integrity.",
        &["International Load Line Certificate (ILLC)"],
        "The Load Lines Convention requires an ILLC showing the maximum legal draft and confirming watertight/weathertight integrity; without it the ship cannot trade internationally."));

    let solas_applies = size.is_solas() && trade == TradeArea::International;

    if solas_applies {
        out.push(fw_req("SOLAS", "International Convention for the Safety of Life at Sea, 1974", "vessel",
            &["Chapter II-1 Construction", "Chapter II-2 Fire", "Chapter III LSA",
              "Chapter IV Radiocommunications", "Chapter V Navigation", "Chapter IX ISM",
              "Chapter XI-1 Special measures", "Chapter XI-2 ISPS"],
            "Master convention — construction, equipment, navigation and management.",
            &[
                "Cargo Ship Safety Construction Certificate (SCC)",
                "Cargo Ship Safety Equipment Certificate (SEC)",
                "Cargo Ship Safety Radio Certificate (SRC)",
                "Nautical Publications & Charts (SOLAS V/27)",
            ],
            "SOLAS is the cornerstone safety convention. It requires the Construction, Equipment and Radio certificates plus certified life-saving, fire-fighting and navigation equipment on every ship ≥ 500 GT on international voyages."));
        out.push(fw_req("ISM Code", "International Safety Management Code", "vessel",
            &["Part A – Implementation", "Chapter 6 Resources and Personnel"],
            "Document of Compliance (company) and Safety Management Certificate (ship).",
            &["Safety Management Certificate (SMC)", "Document of Compliance (DOC) copy", "Ship-specific Safety Management System (SMS)"],
            "The ISM Code (SOLAS Ch. IX) requires the company to hold a DOC and each ship to hold an SMC issued against an implemented SMS covering policies, procedures and emergency response."));
        out.push(fw_req("ISPS Code", "International Ship and Port Facility Security Code", "vessel",
            &["Part A Section 19 – Verification and certification"],
            "International Ship Security Certificate, Ship Security Plan.",
            &["International Ship Security Certificate (ISSC)", "Ship Security Plan (SSP)", "Ship Security Officer appointment"],
            "ISPS (SOLAS Ch. XI-2) requires each ship ≥ 500 GT to hold an ISSC issued against an approved Ship Security Plan, plus a designated Ship Security Officer on board."));
        out.push(fw_req("MLC 2006", "Maritime Labour Convention, 2006", "vessel",
            &["Title 5 – Compliance & Enforcement", "Regulation 5.1.3"],
            "MLC certificate + DMLC Part I / Part II.",
            &["Maritime Labour Certificate (MLC)", "DMLC Part I (flag declaration)", "DMLC Part II (ship-owner declaration)"],
            "MLC 2006 requires ships ≥ 500 GT on international voyages to carry a Maritime Labour Certificate plus the two-part DMLC showing compliance with accommodation, hours-of-rest, wages and welfare rules."));
        out.push(fw_req("BWM Convention", "International Convention for the Control and Management of Ships' Ballast Water and Sediments, 2004", "vessel",
            &["Regulation E-1 Surveys", "E-2 IBWM Certificate"],
            "Ballast water management plan and record book.",
            &["International Ballast Water Management Certificate (IBWM)", "Ballast Water Management Plan", "Ballast Water Record Book"],
            "BWM 2004 requires every ship discharging ballast water to carry an IBWM certificate issued against an approved Ballast Water Management Plan and maintain a record book of every ballast operation."));
        out.push(fw_req("AFS Convention", "International Convention on the Control of Harmful Anti-fouling Systems, 2001", "vessel",
            &["Annex 4 – IAFS Certificate"],
            "Anti-fouling system certificate after coating.",
            &["International Anti-fouling System Certificate (IAFS)"],
            "The AFS Convention requires an IAFS certificate demonstrating that the hull coating contains no prohibited organotin compounds."));
    }

    // MARPOL is almost always applicable
    let mut marpol_articles = vec![
        "Annex I – Oil",
        "Annex IV – Sewage",
        "Annex V – Garbage",
        "Annex VI – Air pollution / energy efficiency (SEEMP)",
    ];
    let mut marpol_requires: Vec<&'static str> = vec![
        "IOPP Certificate (Annex I)",
        "ISPP Certificate (Annex IV – Sewage)",
        "IAPP Certificate (Annex VI – Air)",
        "IEE Certificate / SEEMP (Annex VI Ch. 4)",
        "SOPEP (Shipboard Oil Pollution Emergency Plan)",
        "Oil Record Book Part I",
        "Garbage Management Plan",
    ];
    if matches!(vessel_id, "oil_tanker" | "chemical_tanker") {
        marpol_articles.push("Annex II – Noxious Liquid Substances in Bulk");
        marpol_requires.push("NLS Certificate (Annex II)");
        marpol_requires.push("SMPEP (Shipboard Marine Pollution Emergency Plan)");
    }
    out.push(Framework {
        short_name: "MARPOL",
        full_name: "International Convention for the Prevention of Pollution from Ships, 1973/78",
        scope: "vessel",
        articles: marpol_articles,
        note: "Environmental baseline — certificates and record books per annex.",
        requires: marpol_requires,
        explanation: "MARPOL sets the minimum standard against pollution from ships. Each annex triggers its own certificate (IOPP, ISPP, IAPP, IEE) plus record books and emergency plans. Oil and chemical tankers additionally need NLS and SMPEP under Annex II.",
    });

    // Liability
    out.push(fw_req("Bunker 2001", "International Convention on Civil Liability for Bunker Oil Pollution Damage, 2001", "vessel",
        &["Art. 7 – Compulsory insurance"],
        "Bunker pollution liability certificate (BCLC).",
        &["Bunker Civil Liability Certificate (Blue Card)", "P&I Insurance confirmation"],
        "Bunker 2001 requires compulsory insurance against bunker oil pollution damage, evidenced by a Bunker CLC (Blue Card) carried on board."));
    out.push(fw_req("Nairobi WRC 2007", "Nairobi International Convention on the Removal of Wrecks, 2007", "vessel",
        &["Art. 12 – Compulsory insurance"],
        "Wreck removal liability certificate.",
        &["Wreck Removal Insurance Certificate"],
        "Nairobi WRC 2007 requires compulsory insurance against wreck-removal costs, evidenced by a Wreck Removal Certificate issued by the flag state."));

    // Type-specific
    match vessel_id {
        "oil_tanker" => {
            out.push(fw_req("CLC 1992", "International Convention on Civil Liability for Oil Pollution Damage, 1992", "vessel",
                &["Art. VII – Compulsory insurance"],
                "Civil liability for persistent oil cargo pollution.",
                &["CLC 1992 Certificate (Blue Card)"],
                "CLC 1992 requires persistent-oil tankers to carry compulsory civil-liability insurance evidenced by a CLC Certificate, covering cargo pollution damage up to the convention limits."));
            out.push(fw_req("OPA 90", "Oil Pollution Act 1990 (US)", "vessel",
                &["Title I – Liability", "Title IV – Prevention"],
                "Applies for port calls in the United States — COFR required.",
                &["USCG Certificate of Financial Responsibility (COFR)", "Vessel Response Plan (VRP)"],
                "OPA 90 requires any tanker calling at a US port to hold a USCG Certificate of Financial Responsibility and an approved Vessel Response Plan before entering US waters."));
            out.push(fw_req("IBC Code", "International Code for the Construction and Equipment of Ships Carrying Dangerous Chemicals in Bulk", "vessel",
                &["Ch. 1 – General", "Ch. 2 – Ship survival"],
                "Certificate of Fitness basis for chemical tankers.",
                &["Certificate of Fitness (IBC)", "Cargo P&A Manual (Procedures and Arrangements)"],
                "The IBC Code requires chemical tankers to hold a Certificate of Fitness and an approved P&A Manual demonstrating safe cargo handling, tank washing and transfer procedures."));
        }
        "chemical_tanker" => {
            out.push(fw_req("IBC Code", "International Code for the Construction and Equipment of Ships Carrying Dangerous Chemicals in Bulk", "vessel",
                &["Ch. 1 – General", "Ch. 2 – Ship survival"],
                "Certificate of Fitness basis for chemical tankers.",
                &["Certificate of Fitness (IBC)", "Cargo P&A Manual (Procedures and Arrangements)"],
                "The IBC Code requires chemical tankers to hold a Certificate of Fitness and an approved P&A Manual demonstrating safe cargo handling, tank washing and transfer procedures."));
        }
        "gas_carrier" => {
            out.push(fw_req("IGC Code", "International Code for the Construction and Equipment of Ships Carrying Liquefied Gases in Bulk", "vessel",
                &["Ch. 1 – General", "Ch. 18 – Operation"],
                "Certificate of Fitness basis for gas carriers.",
                &["Certificate of Fitness (IGC)", "Cargo Operations Manual", "Emergency Shutdown Test Records"],
                "The IGC Code requires liquefied-gas carriers to hold a Certificate of Fitness issued against Chapters 1–18, plus an approved Cargo Operations Manual."));
        }
        "bulker" => {
            out.push(fw_req("Grain Code", "International Code for the Safe Carriage of Grain in Bulk", "vessel",
                &["Part A – Specific Requirements"],
                "Document of Authorization for grain loading.",
                &["Document of Authorization for Grain", "Grain Loading Manual"],
                "The Grain Code requires any bulk carrier loading grain in bulk to hold a Document of Authorization and follow an approved Grain Loading Manual showing intact-stability calculations."));
            out.push(fw_req("ESP 2011", "International Code on the Enhanced Programme of Inspections", "vessel",
                &["Annex A – Bulk carriers"],
                "Enhanced surveys for aging bulk carriers.",
                &["ESP Survey Report File", "Condition Evaluation Record"],
                "The ESP Code requires bulk carriers and oil tankers to undergo enhanced periodic surveys and maintain a complete Survey Report File on board."));
        }
        "passenger" => {
            out.push(fw_req("SOLAS V/7.3", "SAR Cooperation Plan for passenger ships", "vessel",
                &["Regulation V/7.3"],
                "Pre-approved SAR plan on board.",
                &["SAR Cooperation Plan", "Passenger Safety Certificate"],
                "SOLAS V/7.3 requires passenger ships to carry a pre-approved SAR Cooperation Plan developed with relevant rescue services; SOLAS Ch. I also requires a Passenger Ship Safety Certificate."));
        }
        _ => {}
    }

    // COLREG
    out.push(fw_req("COLREG 1972", "Convention on the International Regulations for Preventing Collisions at Sea, 1972", "vessel",
        &["All rules (1–38)", "Annexes I–IV (signals, lights)"],
        "Rules of the road — applies to all vessels at sea.",
        &["Compliant navigation lights, shapes & sound signals", "COLREG wall chart on bridge"],
        "COLREG 1972 is the universal rules of the road. It requires every vessel to carry compliant lights, shapes and sound signalling equipment, and the bridge team to know the rules by heart."));

    out
}
