// Document layout templates — curated domain knowledge from a Master Mariner.
//
// Each template is a human-authored description of a specific maritime document's
// layout, field locations, formats, and common extraction traps. These descriptions
// are injected into the AI recognition prompt as context, so the vision model knows
// what to look for BEFORE it starts reading the page.
//
// Templates are keyed by the Skipi profile template id (see `profiles.rs`), which
// is stable across documents of the same type: "passport", "sid", "seamans_book",
// "medical_cert", "bst", "advanced_ff", "coc_deck_mgmt", etc.
//
// This is intentionally a manual catalog (not learned from data) — the domain
// expertise of a seafarer is the edge here, not statistical patterns from a tiny
// dataset. Add new templates by adding a `"template_id" => TEMPLATE_CONST,` arm.

pub fn get_template(template_id: &str) -> Option<&'static str> {
    match template_id {
        "passport" => Some(PASSPORT),
        "sid" => Some(SID),
        "seamans_book" => Some(SEAMANS_BOOK),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Ukrainian biometric passport (citizen's international passport)
// profile id: "passport"
// ---------------------------------------------------------------------------
const PASSPORT: &str = "\
DOCUMENT TYPE CONTEXT: This is a biometric international passport (likely \
Ukrainian). The bio-data page is what you are being shown. It is the holder's \
national travel passport — NOT a seafarer's identity document and NOT a \
seaman's service book.

LAYOUT:
- Photo: top-left of the bio-data page.
- Document number (passport number): top-right of the page, labelled \
'Passport No.' / 'No.' Format is two uppercase Latin letters + six digits \
(e.g. 'FM451333'). Copy exactly.
- Full name: in the middle of the page in Latin transliteration (surname \
on one line, given name on the next).
- Date of birth, place of birth, nationality, sex: in the labeled fields \
in the central block.
- Issuing authority: labelled 'Authority' / 'Issuing authority'. Usually a \
numeric code (e.g. '1403', '2110') referring to the office that issued the \
passport. NOT the country.
- Date of issue and date of expiry: at the bottom of the bio-data page, \
formatted as DD MMM YYYY (e.g. '26 MAR 2018'). Return as 'YYYY-MM-DD'.
- Typical validity: 10 years.

COMMON TRAPS:
- Ignore the MRZ lines at the bottom (two lines of characters with '<<<'). \
The correct values are always in the human-readable fields above.
- Do NOT extract the personal number (record number) as the document number \
— they are different. Document number is labelled 'No.' / 'Passport No.'.
- Issuing authority is the numeric office code, not the word 'UKRAINE' and \
not the city of birth.
";

// ---------------------------------------------------------------------------
// Seafarer's Identity Document (SID) — ILO C185 compliant
// profile id: "sid"
//
// This is the ILO C185 seafarer identity card, separate from both the national
// passport and the seaman's service book. Booklet or card format, issued by the
// flag state's maritime administration.
// ---------------------------------------------------------------------------
const SID: &str = "\
DOCUMENT TYPE CONTEXT: This is a Seafarer's Identity Document (SID) issued \
under ILO Convention 185. It is a dedicated seafarer identity card/booklet, \
NOT the national passport and NOT the seaman's record book (discharge book). \
It is used for port access and shore leave under the C185 framework.

LAYOUT (what to look for and where):
- The data page typically shows the holder's photo on the left and a \
personal identification block on the right, with dual-language labels \
(local language + English).
- Photo: top-left, head-and-shoulders, rectangular.
- Document number (serial number) is printed in the top area of the data \
page, often labelled 'No.' or 'Document No.' or the local equivalent. For \
Ukrainian SIDs the format is usually two uppercase Latin letters followed \
by six digits (e.g. 'AB123456') — copy exactly, including any internal \
space.
- Holder's full name appears in both Latin transliteration and the local \
script. Use the Latin transliteration for any full_name output.
- Date of birth, place of birth, nationality, sex — each next to its own \
bilingual label.
- Issuing authority: the maritime administration office or port that \
issued the SID. For Ukraine this is typically a port name \
(e.g. 'PORT ODESA', 'PORT MARIUPOL') or an office code. Copy exactly.
- Date of issue: labelled 'Date of issue' / 'Дата видачі'. Format is \
usually DD.MM.YYYY or DD MMM YYYY. Return as 'YYYY-MM-DD'.
- Date of expiry: labelled 'Date of expiry' / 'Дійсний до'. Same format \
rules. SID validity is typically 5 years (not 10 like a passport).

COMMON TRAPS (do not fall into these):
- MRZ lines on the reverse side contain '<<<' characters and are often \
misread by vision models. IGNORE the MRZ — the correct values are ALWAYS \
in the visually printed human-readable fields on the data page.
- The document serial number is NOT the same as the holder's personal ID \
number or tax number. Look specifically for the 'No.' / 'Document No.' \
label, not identifiers elsewhere on the page.
- 'Issuing authority' is a port or maritime office name — it is NOT the \
country name ('UKRAINE'), NOT a person's name, and NOT the ship's name.
- Dates are European format (DD.MM.YYYY): do not swap day and month.
- Typical SID validity is 5 years. If the dates you read span 10 years, \
you are probably looking at a passport, not a SID — re-check which \
document this is.
- Some SIDs show the issuing authority as a pure numeric code (e.g. '2109'). \
That is valid — return the numeric code exactly as printed.
";

// ---------------------------------------------------------------------------
// Seaman's Book / Seafarer's Discharge Book — national flag-state document
// profile id: "seamans_book"
//
// This is the service/discharge book that records sea-service history. It is
// separate from the SID (identity) and from the passport (travel).
// ---------------------------------------------------------------------------
const SEAMANS_BOOK: &str = "\
DOCUMENT TYPE CONTEXT: This is a Seaman's Book / Seafarer's Discharge Book, \
a national flag-state document that records sea service. It is NOT the SID \
(which is the ILO C185 identity card), and NOT the national passport. It \
usually has no expiry date — the book itself is valid for life, only \
individual pages are filled in as the seafarer joins and leaves ships.

LAYOUT (what to look for and where):
- The first data page shows the holder's photo, name, date of birth, \
nationality, and the book's serial number. Subsequent pages are service \
records (ship, rank, sign-on, sign-off) — you are most likely being shown \
the first data page.
- Photo: top-left or top-center of the first data page.
- Document number (book serial number): near the top of the data page, \
often labelled 'No.' or 'Seaman's Book No.' The format varies by flag: \
Ukrainian books use formats like 'AB 123456'. Copy exactly.
- Holder's full name: central block, Latin transliteration and local \
script.
- Date of birth, place of birth, nationality: in the central block next \
to their labels.
- Issuing authority: the port or maritime administration office that \
issued the book. For Ukraine this is typically a port name \
(e.g. 'PORT SEVASTOPOL', 'PORT ODESA'). Copy exactly.
- Date of issue: labelled 'Date of issue' / 'Дата видачі'. Return as \
'YYYY-MM-DD'.
- Date of expiry: MOST seaman's books HAVE NO EXPIRY. If you cannot find \
an explicit 'Date of expiry' / 'Valid until' / 'Prolonged till' field, \
return null for valid_to. Do NOT invent a 10-year expiry just because \
passports have one.

COMMON TRAPS (do not fall into these):
- Do NOT confuse this book with a SID. If the document is titled \
'Seafarer's Identity Document' or references ILO C185, it is a SID, not \
a seaman's book. Different document, different validity rules.
- Ignore any MRZ lines — the correct values are in the human-readable \
fields.
- Issuing authority is a port/office name, not a country.
- Most seaman's books have NO expiry date. Return null for valid_to if \
not explicitly present — do not guess.
- If there is a handwritten extension/prolongation stamp on the data \
page (e.g. 'Prolonged till DD.MM.YYYY'), use that as valid_to. Otherwise \
leave it null.
- The rank on page 1 (if shown) is typically the rank at first issue — \
do NOT assume it is the current rank.
";
