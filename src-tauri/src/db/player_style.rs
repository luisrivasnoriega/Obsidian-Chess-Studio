//! Player style analysis (ported 1:1 from frontend `src/utils/playerStyle/*`).
//!
//! Goal:
//! - Keep identical labeling logic to the previous frontend implementation.
//! - Run off the UI thread (Rust backend) to improve responsiveness.
//! - Optimize hot paths with caching (opening -> ECO).

use std::collections::{HashMap, HashSet};

use crate::db::SiteStatsData;

use super::player_stats::PlayerStyleLabel;

#[derive(Debug, Clone, Copy, Default)]
struct StyleVector {
    tactico: f64,
    posicional: f64,
    solido: f64,
    gambitero: f64,
    offbeat: f64,
    sistematico: f64,
    dinamico: f64,
    hipermoderno: f64,
}

#[derive(Debug, Clone, Copy, Default)]
struct OpeningCharacteristics {
    is_gambit: bool,
    is_positional: bool,
    is_tactical: bool,
    is_hypermodern: bool,
    is_solid: bool,
    is_systematic: bool,
    is_offbeat: bool,
    is_dynamic: bool,
}

// NOTE: Order matters. This is the same insertion order as `SPECIFIC_OPENING_MAP`
// in `src/utils/playerStyle/openingsMap.ts`.
//
// We keep it as a slice to preserve matching precedence.
static SPECIFIC_OPENING_MAP: &[(&str, &str)] = &[
    ("englund", "A40"),
    ("englund gambit", "A40"),
    ("rousseau", "C50"),
    ("rousseau gambit", "C50"),
    ("blackmar-diemer", "D00"),
    ("blackmar diemer", "D00"),
    ("benko gambit", "A57"),
    ("volga gambit", "A57"),
    ("budapest gambit", "A51"),
    ("albin countergambit", "D08"),
    ("from's gambit", "A02"),
    ("staunton gambit", "A82"),
    ("elephant gambit", "C40"),
    ("latvian gambit", "C40"),
    ("king's gambit", "C30"),
    ("kings gambit", "C30"),
    ("evans gambit", "C51"),
    ("danish gambit", "C21"),
    ("halloween gambit", "C46"),
    ("muzio gambit", "C53"),
    ("scotch gambit", "C44"),
    ("vienna gambit", "C25"),
    ("wing gambit", "C00"),
    ("blumenfeld countergambit", "E10"),
    ("polovodin gambit", "E12"),
    ("spassky gambit", "E08"),
    ("hungarian gambit", "E00"),
    ("devin gambit", "E00"),
    ("polugaevsky gambit", "E17"),
    ("taimanov gambit", "E17"),
    ("averbakh gambit", "E30"),
    ("vitolins-adorjan gambit", "E32"),
    ("belyavsky gambit", "E34"),
    ("adorjan gambit", "E60"),
    ("leko gambit", "E60"),
    ("florentine gambit", "E77"),
    ("sämisch gambit", "E81"),
    ("kozul gambit", "E98"),
    ("shocron gambit", "E21"),
    ("romanovsky gambit", "E23"),
    ("dus-khotimirsky", "E10"),
    ("spielmann variation", "E10"),
    ("birmingham gambit", "A00"),
    ("bugayev", "A00"),
    ("tartakower gambit", "A00"),
    ("wolferts gambit", "A00"),
    ("schuehler gambit", "A00"),
    ("schiffler-sokolsky", "A00"),
    ("karniewski", "A00"),
    ("grigorian", "A00"),
    ("german defense", "A00"),
    ("czech defense", "A00"),
    ("baltic defense", "A00"),
    ("outflank", "A00"),
    ("queenside defense", "A00"),
    ("rooks swap", "A00"),
    ("king's indian variation", "A00"),
    ("sokolsky attack", "A00"),
    ("schiffler attack", "A00"),
    ("myers variation", "A00"),
    ("gent gambit", "A00"),
    ("paris gambit", "A00"),
    ("amar gambit", "A00"),
    ("polish gambit", "A00"),
    ("spike lee gambit", "A00"),
    ("kádas gambit", "A00"),
    ("schneider gambit", "A00"),
    ("steinbok gambit", "A00"),
    ("alessi gambit", "A00"),
    ("coca-cola gambit", "A00"),
    ("grob gambit", "A00"),
    ("basman gambit", "A00"),
    ("fritz gambit", "A00"),
    ("romford countergambit", "A00"),
    ("keres gambit", "A00"),
    ("richter-grob gambit", "A00"),
    ("zilbermints gambit", "A00"),
    ("zilbermints-hartlaub gambit", "A00"),
    ("zilbermints variation", "D00"),
    ("van kuijk gambit", "A00"),
    ("winterberg gambit", "A00"),
    ("pachman gambit", "A00"),
    ("brooklyn benko gambit", "A00"),
    ("reversed alekhine", "A00"),
    ("reversed brooklyn", "A00"),
    ("reversed french", "A00"),
    ("reversed krebs", "A00"),
    ("reversed mokele mbembe", "A00"),
    ("reversed norwegian", "A00"),
    ("reversed modern", "A00"),
    ("reversed philidor", "C00"),
    ("reversed rat", "A00"),
    ("reversed albin", "D00"),
    ("barnes opening", "A00"),
    ("fool's mate", "A00"),
    ("gedult gambit", "A00"),
    ("hammerschlag", "A00"),
    ("clemenz opening", "A00"),
    ("crab opening", "A00"),
    ("creepy crawly", "A00"),
    ("hippopotamus", "A00"),
    ("shy attack", "A00"),
    ("global opening", "A00"),
    ("grob opening", "A00"),
    ("hungarian opening", "A00"),
    ("kádas opening", "A00"),
    ("lasker simul special", "A00"),
    ("mieses opening", "A00"),
    ("polish opening", "A00"),
    ("saragossa opening", "A00"),
    ("sodium attack", "A00"),
    ("valencia opening", "A00"),
    ("van geet opening", "A00"),
    ("anderssen's opening", "A00"),
    ("amsterdam attack", "A00"),
    ("barnes defense", "B00"),
    ("borg defense", "B00"),
    ("carr defense", "B00"),
    ("duras gambit", "B00"),
    ("fried fox", "B00"),
    ("goldsmith defense", "B00"),
    ("picklepuss", "B00"),
    ("guatemala defense", "B00"),
    ("lemming defense", "B00"),
    ("lion defense", "B00"),
    ("lion's jaw", "B00"),
    ("nimzowitsch defense", "B00"),
    ("el columpio", "B00"),
    ("colorado countergambit", "B00"),
    ("french connection", "B00"),
    ("hornung gambit", "B00"),
    ("kennedy variation", "B00"),
    ("bielefelder gambit", "B00"),
    ("hammer gambit", "B00"),
    ("herford gambit", "B00"),
    ("keres attack", "B00"),
    ("linksspringer", "B00"),
    ("paulsen attack", "B00"),
    ("riemann defense", "B00"),
    ("de smet gambit", "B00"),
    ("mikenas variation", "B00"),
    ("neo-mongoloid", "B00"),
    ("pirc connection", "B00"),
    ("pseudo-spanish", "B00"),
    ("scandinavian variation", "B00"),
    ("aachen gambit", "B00"),
    ("advance variation", "B00"),
    ("bogoljubov variation", "B00"),
    ("brandics gambit", "B00"),
    ("erben gambit", "B00"),
    ("heinola-deppe gambit", "B00"),
    ("nimzowitsch gambit", "B00"),
    ("richter gambit", "B00"),
    ("vehre variation", "B00"),
    ("exchange variation", "B00"),
    ("marshall gambit", "B00"),
    ("wheeler gambit", "B00"),
    ("williams variation", "B00"),
    ("woodchuck variation", "B00"),
    ("owen defense", "B00"),
    ("hekili-loa gambit", "B00"),
    ("matovinsky gambit", "B00"),
    ("naselwaus gambit", "B00"),
    ("smith gambit", "B00"),
    ("unicorn variation", "B00"),
    ("wind gambit", "B00"),
    ("pirc defense", "B07"),
    ("rat defense", "B00"),
    ("antal defense", "B00"),
    ("fuller gambit", "B00"),
    ("harmonist", "B00"),
    ("petruccioli attack", "B00"),
    ("spike attack", "B00"),
    ("st. george defense", "B00"),
    ("san jorge variation", "B00"),
    ("ware defense", "B00"),
    ("snagglepuss", "B00"),
    ("berlin gambit", "B00"),
    ("scandinavian defense", "B01"),
    ("anderssen counterattack", "B01"),
    ("goteborg system", "B01"),
    ("orthodox attack", "B01"),
    ("blackburne gambit", "B01"),
    ("blackburne-kloosterboer", "B01"),
    ("boehnke gambit", "B01"),
    ("bronstein variation", "B01"),
    ("classical variation", "B01"),
    ("grünfeld variation", "B01"),
    ("gubinsky-melts", "B01"),
    ("icelandic-palme gambit", "B01"),
    ("kiel variation", "B01"),
    ("kloosterboer gambit", "B01"),
    ("alekhine defense", "B02"),
    ("modern defense", "B06"),
    ("robatsch defense", "B06"),
    ("old benoni", "A43"),
    ("benoni defense", "A56"),
    ("modern benoni", "A60"),
    ("old indian", "A53"),
    ("catalan opening", "E00"),
    ("bogo-indian", "E11"),
    ("queen's indian", "E12"),
    ("nimzo-indian", "E20"),
    ("king's indian", "E60"),
    ("grünfeld defense", "D80"),
    ("dutch defense", "A80"),
    ("london system", "D02"),
    ("colle system", "D04"),
    ("torre attack", "D03"),
    ("queen's gambit", "D30"),
    ("queens gambit", "D30"),
    ("qgd", "D30"),
    ("slav defense", "D10"),
    ("semi-slav", "D43"),
    ("semislav", "D43"),
    ("queen's gambit accepted", "D20"),
    ("queens gambit accepted", "D20"),
    ("qga", "D20"),
    ("ruy lopez", "C60"),
    ("spanish", "C60"),
    ("italian game", "C50"),
    ("giuoco piano", "C50"),
    ("two knights", "C55"),
    ("four knights", "C46"),
    ("three knights", "C46"),
    ("scotch game", "C44"),
    ("ponziani", "C44"),
    ("philidor", "C41"),
    ("petrov", "C42"),
    ("vienna game", "C25"),
    ("bishop's opening", "C23"),
    ("center game", "C22"),
    ("french defense", "C00"),
    ("caro-kann", "B10"),
    ("sicilian defense", "B20"),
    ("english opening", "A10"),
    ("reti opening", "A04"),
    ("king's indian attack", "A07"),
    ("kings indian attack", "A07"),
    ("bird opening", "A02"),
    ("larsen's opening", "A01"),
    ("larsen opening", "A01"),
    ("nimzowitsch-larsen", "A01"),
    ("nimzo-larsen", "A01"),
    ("nimzo larsen", "A01"),
    ("zukertort opening", "A04"),
    ("zukertort", "A04"),
    ("hartlaub-charlick", "A40"),
    ("hartlaub charlick", "A40"),
    ("blackburne-kostić", "C50"),
    ("blackburne kostić", "C50"),
    ("blackburne-kostic", "C50"),
    ("blackburne kostic", "C50"),
    ("nyezhmetdinov-rossolimo", "B30"),
    ("nyezhmetdinov rossolimo", "B30"),
    ("dragon variation", "B70"),
    ("dragon", "B70"),
    ("van't kruijs", "A00"),
    ("dunst opening", "A00"),
    ("ware opening", "A00"),
    ("sokolsky opening", "A00"),
];

#[inline]
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn analyze_opening_characteristics(opening_name: &str) -> OpeningCharacteristics {
    if opening_name.trim().is_empty() {
        return OpeningCharacteristics::default();
    }

    // Ported from `src/utils/playerStyle/characteristics.ts`
    let lower = opening_name.to_lowercase();
    let mut c = OpeningCharacteristics::default();

    // --- GAMBIT DETECTION ---
    const GAMBIT_KEYWORDS: &[&str] = &[
        "gambit",
        "countergambit",
        "birmingham gambit",
        "benko gambit",
        "volga gambit",
        "budapest gambit",
        "albin countergambit",
        "englund gambit",
        "rousseau gambit",
        "blackmar-diemer",
        "blackmar diemer",
        "king's gambit",
        "kings gambit",
        "evans gambit",
        "danish gambit",
        "halloween gambit",
        "muzio gambit",
        "scotch gambit",
        "vienna gambit",
        "elephant gambit",
        "latvian gambit",
        "staunton gambit",
        "from's gambit",
        "benoni gambit",
        "benoni gambit accepted",
        "blumenfeld countergambit",
        "polovodin gambit",
        "spassky gambit",
        "hungarian gambit",
        "devin gambit",
        "polugaevsky gambit",
        "taimanov gambit",
        "averbakh gambit",
        "vitolins-adorjan gambit",
        "belyavsky gambit",
        "adorjan gambit",
        "leko gambit",
        "florentine gambit",
        "sämisch gambit",
        "kozul gambit",
        "shocron gambit",
        "romanovsky gambit",
        "hartlaub-charlick",
        "blackburne-kostić",
        "blackburne kostic",
        "king's gambit accepted",
        "kings gambit accepted",
    ];

    if GAMBIT_KEYWORDS.iter().any(|k| lower.contains(k)) && !lower.contains("declined") {
        c.is_gambit = true;
        c.is_tactical = true;
        c.is_dynamic = true;
    }

    // --- POSITIONAL OPENINGS ---
    const POSITIONAL_KEYWORDS: &[&str] = &[
        "catalan",
        "english opening",
        "reti",
        "queen's gambit declined",
        "queens gambit declined",
        "qgd",
        "slav",
        "semi-slav",
        "semislav",
        "ruy lopez",
        "spanish",
        "french defense",
        "caro-kann",
        "philidor",
        "petrov",
        "petrov's",
        "bogo-indian",
        "queen's indian",
        "queens indian",
        "nimzo-indian",
        "nimzo indian",
        "classical",
        "main line",
        "traditional",
        "orthodox",
        "exchange variation",
        "closed",
    ];
    if POSITIONAL_KEYWORDS.iter().any(|k| lower.contains(k)) {
        c.is_positional = true;
        c.is_solid = true;
    }

    // --- TACTICAL OPENINGS ---
    const TACTICAL_KEYWORDS: &[&str] = &[
        "sicilian",
        "dragon",
        "najdorf",
        "scheveningen",
        "sveshnikov",
        "kalashnikov",
        "taimanov",
        "kan",
        "dragon variation",
        "sharp",
        "aggressive",
        "attack",
        "sacrifice",
        "sac",
        "tactical",
    ];
    if TACTICAL_KEYWORDS.iter().any(|k| lower.contains(k)) {
        c.is_tactical = true;
        c.is_dynamic = true;
    }

    // --- HYPERMODERN OPENINGS ---
    const HYPERMODERN_KEYWORDS: &[&str] = &[
        "king's indian",
        "kings indian",
        "grünfeld",
        "grunfeld",
        "benoni",
        "modern defense",
        "robatsch",
        "pirc",
        "nimzowitsch-larsen",
        "nimzo-larsen",
        "nimzo larsen",
        "larsen's",
        "larsen",
        "zukertort",
        "reti",
        "alekhine",
        "hypermodern",
        "fianchetto",
        "fianchettoed",
        "hyperaccelerated",
        "hyperaccelerated dragon",
        "king's english",
        "kings english",
        "english variation",
        "english opening",
        "catalan",
    ];
    if HYPERMODERN_KEYWORDS.iter().any(|k| lower.contains(k)) {
        c.is_hypermodern = true;
        c.is_dynamic = true;
        c.is_positional = true;
        // Hypermodern openings are NOT offbeat.
        c.is_offbeat = false;
    }

    // --- SOLID OPENINGS ---
    const SOLID_KEYWORDS: &[&str] = &[
        "french defense",
        "caro-kann",
        "philidor",
        "petrov",
        "petrov's",
        "queen's gambit declined",
        "queens gambit declined",
        "qgd",
        "slav",
        "semi-slav",
        "semislav",
        "solid",
        "safe",
        "defensive",
    ];
    if SOLID_KEYWORDS.iter().any(|k| lower.contains(k)) {
        c.is_solid = true;
        c.is_positional = true;
    }

    // --- SYSTEMATIC OPENINGS ---
    const SYSTEMATIC_KEYWORDS: &[&str] = &[
        "london system",
        "london",
        "colle system",
        "colle",
        "torre attack",
        "torre",
        "system",
        "systematic",
        "king's indian attack",
        "kings indian attack",
    ];
    if SYSTEMATIC_KEYWORDS.iter().any(|k| lower.contains(k)) {
        c.is_systematic = true;
        c.is_positional = true;
    }

    // --- OFFBEAT / IRREGULAR ---
    const OFFBEAT_KEYWORDS: &[&str] = &[
        "polish opening",
        "sokolsky",
        "bird opening",
        "barnes",
        "grob",
        "amsterdam",
        "anderssen",
        "clemenz",
        "crab",
        "hippopotamus",
        "kádas",
        "mieses",
        "saragossa",
        "sodium",
        "valencia",
        "van geet",
        "irregular",
        "unusual",
        "rare",
        "offbeat",
    ];
    if OFFBEAT_KEYWORDS.iter().any(|k| lower.contains(k)) {
        c.is_offbeat = true;
    }

    // --- DYNAMIC OPENINGS ---
    const DYNAMIC_KEYWORDS: &[&str] = &[
        "sicilian",
        "dragon",
        "king's indian",
        "kings indian",
        "grünfeld",
        "grunfeld",
        "benoni",
        "modern",
        "pirc",
        "dutch",
        "scandinavian",
        "alekhine",
        "hypermodern",
        "dynamic",
        "counterattack",
        "counterplay",
    ];
    if DYNAMIC_KEYWORDS.iter().any(|k| lower.contains(k)) {
        c.is_dynamic = true;
    }

    // Special cases (ported).
    if lower.contains("king's indian attack") || lower.contains("kings indian attack") {
        c.is_systematic = true;
        c.is_positional = true;
    }

    if lower.contains("indian") && (lower.contains("defense") || lower.contains("variation")) {
        c.is_hypermodern = true;
        c.is_dynamic = true;
        c.is_offbeat = false;
        if !lower.contains("queen's indian") && !lower.contains("queens indian") {
            c.is_tactical = true;
        }
    }

    if lower.contains("sicilian") {
        c.is_tactical = true;
        c.is_dynamic = true;
        if lower.contains("hyperaccelerated") || lower.contains("hyper-accelerated") {
            c.is_hypermodern = true;
        }
    }

    if lower.contains("french") {
        c.is_solid = true;
        c.is_positional = true;
    }

    if lower.contains("caro") || lower.contains("kann") {
        c.is_solid = true;
        c.is_positional = true;
    }

    if lower.contains("ruy lopez") || lower.contains("spanish") {
        c.is_positional = true;
        c.is_solid = true;
    }

    if lower.contains("english opening") || lower.contains("english") {
        c.is_positional = true;
        if lower.contains("king's english")
            || lower.contains("kings english")
            || lower.contains("fianchetto")
        {
            c.is_hypermodern = true;
            c.is_dynamic = true;
            c.is_offbeat = false;
        } else {
            c.is_solid = true;
        }
    }

    if lower.contains("queen's gambit declined")
        || lower.contains("queens gambit declined")
        || lower.contains("qgd")
    {
        c.is_solid = true;
        c.is_positional = true;
    }

    if lower.contains("slav") {
        c.is_solid = true;
        c.is_positional = true;
    }

    if lower.contains("benoni") {
        c.is_dynamic = true;
        c.is_tactical = true;
        if lower.contains("old benoni") {
            c.is_offbeat = true;
        }
        if lower.contains("modern benoni") {
            c.is_hypermodern = true;
        }
    }

    if lower.contains("scandinavian") {
        c.is_offbeat = true;
        c.is_dynamic = true;
        if lower.contains("main line") {
            c.is_positional = true;
        }
        if lower.contains("mieses") || lower.contains("kotroc") {
            c.is_tactical = true;
        }
    }

    if lower.contains("horwitz") {
        c.is_offbeat = true;
        c.is_dynamic = true;
    }

    if lower.contains("polish opening") {
        c.is_offbeat = true;
        if lower.contains("czech defense")
            || lower.contains("king's indian variation")
            || lower.contains("kings indian variation")
        {
            c.is_positional = true;
            c.is_dynamic = true;
        }
        if lower.contains("outflank") {
            c.is_tactical = true;
        }
    }

    if lower.contains("french") {
        if lower.contains("knight variation") || lower.contains("two knights") {
            c.is_positional = true;
        }
        if lower.contains("winawer") || lower.contains("advance") {
            c.is_dynamic = true;
            c.is_tactical = true;
        }
    }

    if lower.contains("italian") {
        c.is_positional = true;
        if lower.contains("rousseau") || lower.contains("blackburne") {
            c.is_gambit = true;
            c.is_tactical = true;
        }
    }

    if lower.contains("ruy lopez") || lower.contains("spanish") {
        if lower.contains("classical") {
            c.is_positional = true;
            c.is_solid = true;
        }
        if lower.contains("marshall") || lower.contains("open") {
            c.is_tactical = true;
            c.is_dynamic = true;
        }
    }

    if lower.contains("sicilian") {
        if lower.contains("closed") {
            c.is_positional = true;
        }
        if lower.contains("old sicilian") {
            c.is_tactical = true;
            c.is_dynamic = true;
        }
    }

    if lower.contains("queen's gambit accepted")
        || lower.contains("queens gambit accepted")
        || lower.contains("qga")
    {
        c.is_positional = true;
        c.is_dynamic = true;
        c.is_gambit = false;
    }

    if lower.contains("four knights") || lower.contains("three knights") {
        c.is_positional = true;
        c.is_solid = true;
    }

    if lower.contains("bishop's opening") || lower.contains("bishops opening") {
        c.is_positional = true;
    }

    if lower.contains("scotch game") || lower.contains("scotch") {
        c.is_tactical = true;
        c.is_dynamic = true;
    }

    c
}

fn is_gambit_name(name: &str) -> bool {
    analyze_opening_characteristics(name).is_gambit
}

fn find_any_eco(name: &str) -> Option<String> {
    let b = name.as_bytes();
    for i in 0..b.len().saturating_sub(2) {
        let c = b[i] as char;
        if !matches!(c, 'A' | 'B' | 'C' | 'D' | 'E') {
            continue;
        }
        if b[i + 1].is_ascii_digit() && b[i + 2].is_ascii_digit() {
            let prev_ok = i == 0 || !is_word_byte(b[i - 1]);
            let next_ok = i + 3 >= b.len() || !is_word_byte(b[i + 3]);
            if prev_ok && next_ok {
                return Some(name[i..i + 3].to_string());
            }
        }
    }
    None
}

fn find_eco_for_letters(name: &str, letters: &[u8]) -> Option<String> {
    let b = name.as_bytes();
    for i in 0..b.len().saturating_sub(2) {
        if !letters.contains(&b[i]) {
            continue;
        }
        if b[i + 1].is_ascii_digit() && b[i + 2].is_ascii_digit() {
            let prev_ok = i == 0 || !is_word_byte(b[i - 1]);
            let next_ok = i + 3 >= b.len() || !is_word_byte(b[i + 3]);
            if prev_ok && next_ok {
                return Some(name[i..i + 3].to_string());
            }
        }
    }
    None
}

fn eco_num(code: &str) -> Option<i32> {
    if code.len() != 3 {
        return None;
    }
    code[1..].parse::<i32>().ok()
}

fn extract_eco_from_opening_uncached(opening_name: &str) -> Option<String> {
    let name = opening_name.trim();
    if name.is_empty() {
        return None;
    }

    // Strategy 1: ECO at start ("B90 Sicilian Defense ...")
    let b = name.as_bytes();
    if b.len() >= 4 {
        let c0 = b[0] as char;
        if matches!(c0, 'A' | 'B' | 'C' | 'D' | 'E')
            && b[1].is_ascii_digit()
            && b[2].is_ascii_digit()
            && b[3].is_ascii_whitespace()
        {
            return Some(name[0..3].to_string());
        }
    }

    let lower = name.to_lowercase();

    // Strategy 2: specific name → ECO map (order matters)
    for (key, eco) in SPECIFIC_OPENING_MAP {
        if lower.contains(key) {
            return Some((*eco).to_string());
        }
    }

    // Strategy 3: any ECO pattern in the string
    if let Some(code) = find_any_eco(name) {
        return Some(code);
    }

    // Strategy 4: infer from keywords / families (ported from `ecoExtraction.ts`)
    //
    // Sicilians (B30–B99)
    if lower.contains("sicilian")
        || lower.contains("dragon")
        || lower.contains("najdorf")
        || lower.contains("scheveningen")
        || lower.contains("sveshnikov")
        || lower.contains("kalashnikov")
        || lower.contains("taimanov")
        || lower.contains("kan")
    {
        if let Some(code) = find_eco_for_letters(name, &[b'B']) {
            if let Some(num) = eco_num(&code) {
                if (30..=99).contains(&num) {
                    return Some(code);
                }
            }
        }
        return Some("B50".to_string());
    }

    // French (C00–C19)
    if lower.contains("french") {
        if let Some(code) = find_eco_for_letters(name, &[b'C']) {
            if let Some(num) = eco_num(&code) {
                if num <= 19 {
                    return Some(code);
                }
            }
        }
        return Some("C00".to_string());
    }

    // Caro-Kann (B10–B19)
    if lower.contains("caro") || lower.contains("kann") {
        if let Some(code) = find_eco_for_letters(name, &[b'B']) {
            if let Some(num) = eco_num(&code) {
                if (10..=19).contains(&num) {
                    return Some(code);
                }
            }
        }
        return Some("B10".to_string());
    }

    // QG / Slav / Semi-Slav (D10–D19, D30–D49)
    if lower.contains("queen's gambit")
        || lower.contains("queens gambit")
        || lower.contains("qgd")
        || lower.contains("semi-slav")
        || lower.contains("semislav")
        || lower.contains("slav")
    {
        if let Some(code) = find_eco_for_letters(name, &[b'D']) {
            if let Some(num) = eco_num(&code) {
                if (10..=19).contains(&num) || (30..=49).contains(&num) {
                    return Some(code);
                }
            }
        }
        return Some("D30".to_string());
    }

    // Indian / Benoni / Benko families
    if lower.contains("indian")
        || lower.contains("nimzo")
        || lower.contains("bogo")
        || lower.contains("grünfeld")
        || lower.contains("grunfeld")
        || lower.contains("king's indian")
        || lower.contains("kings indian")
        || lower.contains("queen's indian")
        || lower.contains("queens indian")
        || lower.contains("benoni")
        || lower.contains("benko")
    {
        if let Some(code) = find_eco_for_letters(name, &[b'A', b'B', b'C', b'D', b'E']) {
            let letter = code.as_bytes()[0] as char;
            if let Some(num) = eco_num(&code) {
                let ok = (letter == 'A' && (56..=79).contains(&num))
                    || (letter == 'D' && (80..=99).contains(&num))
                    || (letter == 'E' && ((20..=29).contains(&num) || (60..=99).contains(&num)));
                if ok {
                    return Some(code);
                }
            }
        }
        return Some("E20".to_string());
    }

    // London / Colle / Torre
    if lower.contains("london") || lower.contains("colle") || lower.contains("torre") {
        if let Some(code) = find_eco_for_letters(name, &[b'A', b'B', b'C', b'D']) {
            let letter = code.as_bytes()[0] as char;
            if let Some(num) = eco_num(&code) {
                let ok = (letter == 'D' && (2..=5).contains(&num))
                    || (letter == 'A' && (46..=48).contains(&num));
                if ok {
                    return Some(code);
                }
            }
        }
        return Some("D02".to_string());
    }

    // English / Reti
    if lower.contains("english") || lower.contains("reti") {
        if let Some(code) = find_eco_for_letters(name, &[b'A']) {
            if let Some(num) = eco_num(&code) {
                if (4..=9).contains(&num) || (10..=39).contains(&num) {
                    return Some(code);
                }
            }
        }
        return Some("A10".to_string());
    }

    // Ruy Lopez / Spanish
    if lower.contains("ruy lopez") || lower.contains("spanish") {
        if let Some(code) = find_eco_for_letters(name, &[b'C']) {
            if let Some(num) = eco_num(&code) {
                if (60..=99).contains(&num) {
                    return Some(code);
                }
            }
        }
        return Some("C60".to_string());
    }

    // Italian
    if lower.contains("italian") {
        return Some("C50".to_string());
    }

    // Scandinavian
    if lower.contains("scandinavian") {
        return Some("B01".to_string());
    }

    // Alekhine / Modern / Pirc (B02–B09)
    if lower.contains("alekhine") || lower.contains("modern") || lower.contains("pirc") {
        if let Some(code) = find_eco_for_letters(name, &[b'B']) {
            if let Some(num) = eco_num(&code) {
                if (2..=9).contains(&num) {
                    return Some(code);
                }
            }
        }
        return Some("B06".to_string());
    }

    // Dutch
    if lower.contains("dutch") {
        return Some("A80".to_string());
    }

    // Generic fallback for gambits with unknown ECO
    if is_gambit_name(name) {
        if let Some(code) = find_any_eco(name) {
            return Some(code);
        }
        if lower.contains("king's") || lower.contains("kings") {
            return Some("C30".to_string());
        }
        if lower.contains("queen's") || lower.contains("queens") {
            return Some("D20".to_string());
        }
        return Some("C20".to_string());
    }

    None
}

fn extract_eco_from_opening_cached(
    opening_name: &str,
    cache: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    let key = opening_name.trim();
    if key.is_empty() {
        return None;
    }
    if let Some(v) = cache.get(key) {
        return v.clone();
    }
    let v = extract_eco_from_opening_uncached(key);
    cache.insert(key.to_string(), v.clone());
    v
}

fn extract_ecos_from_site_stats_data(
    site_stats_data: &[SiteStatsData],
) -> Vec<(String, String, usize)> {
    // Port of `extractEcosFromPlayerInfo` (TS) with caching to improve performance.
    let mut opening_counts: HashMap<String, usize> = HashMap::new(); // key = "{eco}:{opening}"
    let mut opening_meta: HashMap<String, (String, String)> = HashMap::new(); // key -> (eco, opening)
    let mut order: Vec<String> = Vec::new(); // preserve insertion order for stable sort ties
    let mut total_games: usize = 0;
    let mut eco_cache: HashMap<String, Option<String>> = HashMap::new();

    for site in site_stats_data {
        for game in &site.data {
            total_games += 1;
            let opening = game.opening.trim();
            if opening.is_empty() {
                continue;
            }
            let Some(eco) = extract_eco_from_opening_cached(opening, &mut eco_cache) else {
                continue;
            };

            let mut k = String::with_capacity(eco.len() + 1 + opening.len());
            k.push_str(&eco);
            k.push(':');
            k.push_str(opening);

            let entry = opening_counts.entry(k.clone()).or_insert(0);
            if *entry == 0 {
                // first time we see it
                order.push(k.clone());
                opening_meta.insert(k.clone(), (eco.clone(), opening.to_string()));
            }
            *entry += 1;
        }
    }

    if total_games == 0 || order.is_empty() {
        return vec![];
    }

    // Build and stable-sort by count desc (Rust sort is stable)
    let mut sorted: Vec<(String, String, usize)> = order
        .into_iter()
        .filter_map(|k| {
            let count = opening_counts.get(&k).copied().unwrap_or(0);
            let (eco, opening) = opening_meta.remove(&k)?;
            Some((eco, opening, count))
        })
        .collect();
    sorted.sort_by(|a, b| b.2.cmp(&a.2));

    // Take top 10 OR until we cover 50% of games
    let target_games = ((total_games as f64) * 0.5).ceil() as usize;
    let mut selected: Vec<(String, String, usize)> = Vec::new();
    let mut cumulative: usize = 0;
    for item in sorted {
        selected.push(item.clone());
        cumulative += item.2;
        if selected.len() >= 10 || cumulative >= target_games {
            break;
        }
    }
    selected
}

fn style_from_eco_list(openings: &[(String, String, usize)]) -> StyleVector {
    // Port of `src/utils/playerStyle/styleVector.ts`
    let mut v = StyleVector::default();
    let mut gambit_ecos: HashSet<String> = HashSet::new();

    for (eco, opening_name, count) in openings {
        let code = eco.trim().to_uppercase();
        if code.len() < 2 {
            continue;
        }
        let letter = code.as_bytes()[0] as char;
        let num: i32 = code[1..].parse().unwrap_or(-1);
        if num < 0 {
            continue;
        }

        let lower_opening = opening_name.to_lowercase();
        let characteristics = analyze_opening_characteristics(opening_name);
        let is_gambit = characteristics.is_gambit;

        let weight = *count as f64;

        // --- A00–A03: irregular (Grob, Polish, etc.) ---
        if letter == 'A' && (0..=3).contains(&num) {
            v.offbeat += (if characteristics.is_offbeat { 4.0 } else { 3.0 }) * weight;
            v.tactico += (if characteristics.is_tactical {
                2.0
            } else {
                1.0
            }) * weight;

            if characteristics.is_hypermodern {
                v.hipermoderno += 3.0 * weight;
                v.dinamico += 2.0 * weight;
                v.posicional += 1.0 * weight;
            }

            if num == 1 || characteristics.is_hypermodern {
                // A01 is Nimzo-Larsen - hypermodern, not offbeat
                if characteristics.is_hypermodern {
                    v.hipermoderno += 2.0 * weight;
                    v.dinamico += 2.0 * weight;
                    v.posicional += 1.0 * weight;
                } else {
                    v.offbeat += 2.0 * weight;
                    v.dinamico += 2.0 * weight;
                    v.posicional += 1.0 * weight;
                }
            }

            if is_gambit {
                v.gambitero += 3.0 * weight;
                gambit_ecos.insert(code.clone());
            }

            if lower_opening.contains("polish opening") && !is_gambit {
                v.offbeat += 1.0 * weight;
                v.posicional += 1.0 * weight;
            }
        }

        // --- A04–A09: Reti / Zukertort / KIA ---
        if letter == 'A' && (4..=9).contains(&num) {
            v.posicional += (if characteristics.is_positional {
                3.0
            } else {
                2.0
            }) * weight;
            v.sistematico += (if characteristics.is_systematic {
                3.0
            } else {
                2.0
            }) * weight;
            v.solido += (if characteristics.is_solid { 2.0 } else { 1.0 }) * weight;

            if num == 4 || characteristics.is_hypermodern {
                // A04 is Zukertort - hypermodern, not offbeat
                if characteristics.is_hypermodern {
                    v.hipermoderno += 2.0 * weight;
                    v.dinamico += 1.0 * weight;
                } else {
                    v.offbeat += 2.0 * weight;
                    v.dinamico += 1.0 * weight;
                }
            }

            if num == 7 || characteristics.is_systematic {
                v.sistematico += 1.0 * weight;
                v.posicional += 1.0 * weight;
            }
        }

        // --- A10–A39: English ---
        if letter == 'A' && (10..=39).contains(&num) {
            if characteristics.is_hypermodern {
                // King's English and fianchetto variations are hypermodern
                v.hipermoderno += 3.0 * weight;
                v.posicional += 2.0 * weight;
                v.dinamico += 2.0 * weight;
            } else {
                v.posicional += (if characteristics.is_positional {
                    3.0
                } else {
                    2.0
                }) * weight;
                v.solido += (if characteristics.is_solid { 2.0 } else { 1.0 }) * weight;
                v.dinamico += (if characteristics.is_dynamic { 2.0 } else { 1.0 }) * weight;
            }
        }

        // --- A40–A45: offbeat queen pawn (Englund etc.) ---
        if letter == 'A' && (40..=45).contains(&num) {
            v.offbeat += 3.0 * weight;
            v.tactico += 2.0 * weight;
            if is_gambit {
                v.gambitero += 4.0 * weight;
                gambit_ecos.insert(code.clone());
            }
        }

        // --- A46–A48: Torre / London (system players) ---
        if letter == 'A' && (46..=48).contains(&num) {
            v.sistematico += 3.0 * weight;
            v.posicional += 2.0 * weight;
            v.solido += 2.0 * weight;
        }

        // --- A50–A55: offbeat Indians ---
        if letter == 'A' && (50..=55).contains(&num) {
            v.offbeat += 2.0 * weight;
            v.dinamico += 2.0 * weight;
            v.tactico += 1.0 * weight;
        }

        // --- A56–A79: Benoni / Benko / Indians ---
        if letter == 'A' && (56..=79).contains(&num) {
            v.dinamico += 3.0 * weight;
            v.tactico += 2.0 * weight;
            v.posicional += 1.0 * weight;
            if is_gambit {
                v.gambitero += 3.0 * weight;
                gambit_ecos.insert(code.clone());
            }
        }

        // --- A80–A99: Dutch family ---
        if letter == 'A' && (80..=99).contains(&num) {
            v.dinamico += 3.0 * weight;
            v.tactico += 2.0 * weight;
            v.offbeat += 1.0 * weight;
            if is_gambit {
                v.gambitero += 2.0 * weight;
                gambit_ecos.insert(code.clone());
            }
        }

        // --- B00–B05: weird 1.e4 replies ---
        if letter == 'B' && (0..=5).contains(&num) {
            v.offbeat += 3.0 * weight;
            v.tactico += 1.0 * weight;
            v.dinamico += 1.0 * weight;
        }

        // --- B01: Scandinavian ---
        if letter == 'B' && num == 1 {
            v.offbeat += 2.0 * weight;
            v.dinamico += 2.0 * weight;
            v.tactico += (if characteristics.is_tactical {
                2.0
            } else {
                1.0
            }) * weight;
        }

        // --- B02–B09: Alekhine / Modern / Pirc ---
        if letter == 'B' && (2..=9).contains(&num) {
            v.dinamico += (if characteristics.is_dynamic { 3.0 } else { 2.0 }) * weight;
            v.posicional += (if characteristics.is_positional {
                2.0
            } else {
                1.0
            }) * weight;

            if characteristics.is_hypermodern {
                // Modern Defense and Pirc are hypermodern, NOT offbeat
                v.hipermoderno += 3.0 * weight;
                v.dinamico += 1.0 * weight;
            } else if characteristics.is_offbeat {
                v.offbeat += 2.0 * weight;
            } else {
                v.offbeat += 1.0 * weight;
            }

            if (6..=9).contains(&num)
                || lower_opening.contains("modern")
                || lower_opening.contains("pirc")
            {
                v.posicional += 1.0 * weight;
                if characteristics.is_hypermodern {
                    v.hipermoderno += 1.0 * weight;
                } else {
                    v.offbeat += 1.0 * weight;
                }
            }
        }

        // --- B10–B19: Caro-Kann ---
        if letter == 'B' && (10..=19).contains(&num) {
            v.solido += (if characteristics.is_solid { 3.0 } else { 2.0 }) * weight;
            v.posicional += (if characteristics.is_positional {
                3.0
            } else {
                2.0
            }) * weight;
            v.tactico += (if characteristics.is_tactical {
                2.0
            } else {
                1.0
            }) * weight;
        }

        // --- B20–B29: generic Sicilian ---
        if letter == 'B' && (20..=29).contains(&num) {
            v.tactico += 2.0 * weight;
            v.dinamico += 2.0 * weight;
            v.posicional += 1.0 * weight;
        }

        // --- B30–B99: Sicilian mainline ---
        if letter == 'B' && (30..=99).contains(&num) {
            v.tactico += (if characteristics.is_tactical {
                3.0
            } else {
                2.0
            }) * weight;
            v.dinamico += (if characteristics.is_dynamic { 3.0 } else { 2.0 }) * weight;
            v.posicional += (if characteristics.is_positional {
                2.0
            } else {
                1.0
            }) * weight;

            if characteristics.is_hypermodern {
                // Hyperaccelerated Dragon is hypermodern
                v.hipermoderno += 3.0 * weight;
            }

            if (70..=79).contains(&num) || lower_opening.contains("dragon") {
                v.tactico += 1.0 * weight;
                v.dinamico += 1.0 * weight;
                if lower_opening.contains("hyperaccelerated") {
                    v.hipermoderno += 2.0 * weight;
                }
            }

            // Only add offbeat if it's truly offbeat and NOT hypermodern
            if ((30..=39).contains(&num) || characteristics.is_offbeat)
                && !characteristics.is_hypermodern
            {
                v.offbeat += 1.0 * weight;
            }

            if lower_opening.contains("closed") {
                v.posicional += 1.0 * weight;
                v.tactico -= 1.0 * weight; // clamped later
            }
        }

        // --- C00–C19: French ---
        if letter == 'C' && (0..=19).contains(&num) {
            v.solido += (if characteristics.is_solid { 3.0 } else { 2.0 }) * weight;
            v.posicional += (if characteristics.is_positional {
                3.0
            } else {
                2.0
            }) * weight;
            v.tactico += (if characteristics.is_tactical {
                2.0
            } else {
                1.0
            }) * weight;

            if lower_opening.contains("winawer") || lower_opening.contains("variation") {
                v.dinamico += 1.0 * weight;
            }
        }

        // --- C20–C39: 1.e4 gambits / open games ---
        if letter == 'C' && (20..=39).contains(&num) {
            if is_gambit {
                v.gambitero += 4.0 * weight;
                v.tactico += 3.0 * weight;
                v.dinamico += 2.0 * weight;
                v.offbeat += 1.0 * weight;
                gambit_ecos.insert(code.clone());
            } else {
                v.tactico += 2.0 * weight;
                v.dinamico += 1.0 * weight;
            }
        }

        // --- C40: King's Knight families ---
        if letter == 'C' && num == 40 {
            if is_gambit {
                v.gambitero += 3.0 * weight;
                v.tactico += 2.0 * weight;
                v.offbeat += 1.0 * weight;
                gambit_ecos.insert(code.clone());
            } else {
                v.tactico += 1.0 * weight;
            }
        }

        // --- C41–C42: Philidor / Petrov ---
        if letter == 'C' && (41..=42).contains(&num) {
            v.solido += 3.0 * weight;
            v.posicional += 2.0 * weight;
        }

        // --- C43–C44: Petrov / Scotch ---
        if letter == 'C' && (43..=44).contains(&num) {
            v.posicional += 2.0 * weight;
            v.tactico += 2.0 * weight;
            v.solido += 1.0 * weight;
            if num == 44 && is_gambit {
                v.gambitero += 2.0 * weight;
                gambit_ecos.insert(code.clone());
            }
        }

        // --- C45–C46: Scotch / Three/Four Knights ---
        if letter == 'C' && (45..=46).contains(&num) {
            v.posicional += 2.0 * weight;
            v.solido += 2.0 * weight;
            if num == 46 && is_gambit {
                v.gambitero += 2.0 * weight;
                v.offbeat += 1.0 * weight;
                gambit_ecos.insert(code.clone());
            }
        }

        // --- C47–C49: Four Knights ---
        if letter == 'C' && (47..=49).contains(&num) {
            v.posicional += 2.0 * weight;
            v.solido += 2.0 * weight;
        }

        // --- C50–C59: Italian / Two Knights ---
        if letter == 'C' && (50..=59).contains(&num) {
            v.posicional += 2.0 * weight;
            v.tactico += 2.0 * weight;
            v.solido += 1.0 * weight;
            if is_gambit {
                v.gambitero += 3.0 * weight;
                v.offbeat += 1.0 * weight;
                gambit_ecos.insert(code.clone());
            }
        }

        // --- C60–C99: Ruy Lopez ---
        if letter == 'C' && (60..=99).contains(&num) {
            v.posicional += 3.0 * weight;
            v.solido += 2.0 * weight;
            v.tactico += 1.0 * weight;
        }

        // --- D00–D01: irregular d-pawn (Blackmar-Diemer etc.) ---
        if letter == 'D' && (0..=1).contains(&num) {
            v.offbeat += 2.0 * weight;
            v.tactico += 2.0 * weight;
            if is_gambit {
                v.gambitero += 3.0 * weight;
                gambit_ecos.insert(code.clone());
            }
        }

        // --- D02–D05: London / Colle / Torre ---
        if letter == 'D' && (2..=5).contains(&num) {
            v.sistematico += (if characteristics.is_systematic {
                3.0
            } else {
                2.0
            }) * weight;
            v.posicional += (if characteristics.is_positional {
                3.0
            } else {
                2.0
            }) * weight;
            v.solido += (if characteristics.is_solid { 2.0 } else { 1.0 }) * weight;
        }

        // --- D06–D09: QGD odd lines / Albin etc. ---
        if letter == 'D' && (6..=9).contains(&num) {
            v.solido += 3.0 * weight;
            v.posicional += 3.0 * weight;
            if is_gambit {
                v.gambitero += 2.0 * weight;
                v.tactico += 1.0 * weight;
                gambit_ecos.insert(code.clone());
            }
        }

        // --- D10–D19: Slav ---
        if letter == 'D' && (10..=19).contains(&num) {
            v.solido += (if characteristics.is_solid { 3.0 } else { 2.0 }) * weight;
            v.posicional += (if characteristics.is_positional {
                3.0
            } else {
                2.0
            }) * weight;
            v.dinamico += (if characteristics.is_dynamic { 2.0 } else { 1.0 }) * weight;
        }

        // --- D20–D29: QGA ---
        if letter == 'D' && (20..=29).contains(&num) {
            v.posicional += 3.0 * weight;
            v.dinamico += 2.0 * weight;
            v.solido += 1.0 * weight;
        }

        // --- D30–D49: QGD / Semi-Slav ---
        if letter == 'D' && (30..=49).contains(&num) {
            v.solido += (if characteristics.is_solid { 3.0 } else { 2.0 }) * weight;
            v.posicional += (if characteristics.is_positional {
                3.0
            } else {
                2.0
            }) * weight;
            v.dinamico += (if characteristics.is_dynamic { 2.0 } else { 1.0 }) * weight;
            if lower_opening.contains("semi-slav") || lower_opening.contains("semislav") {
                v.dinamico += 1.0 * weight;
                v.tactico += 1.0 * weight;
            }
        }

        // --- D50–D79: various QGD families ---
        if letter == 'D' && (50..=79).contains(&num) {
            v.solido += 3.0 * weight;
            v.posicional += 3.0 * weight;
        }

        // --- D80–D99: Grünfeld and friends ---
        if letter == 'D' && (80..=99).contains(&num) {
            v.dinamico += (if characteristics.is_dynamic { 3.0 } else { 2.0 }) * weight;
            v.tactico += (if characteristics.is_tactical {
                3.0
            } else {
                2.0
            }) * weight;
            if characteristics.is_hypermodern {
                v.hipermoderno += 4.0 * weight;
                v.posicional += 2.0 * weight;
            } else {
                v.posicional += 1.0 * weight;
            }
        }

        // --- E00–E09: Catalan / misc. ---
        if letter == 'E' && (0..=9).contains(&num) {
            v.posicional += 3.0 * weight;
            v.solido += 2.0 * weight;
            v.dinamico += 1.0 * weight;
            if is_gambit {
                v.gambitero += 2.0 * weight;
                gambit_ecos.insert(code.clone());
            }
        }

        // --- E10–E19: Blumenfeld / Bogo / Q-Indian ---
        if letter == 'E' && (10..=19).contains(&num) {
            v.posicional += 2.0 * weight;
            v.dinamico += 2.0 * weight;
            if is_gambit {
                v.gambitero += 2.0 * weight;
                v.tactico += 1.0 * weight;
                gambit_ecos.insert(code.clone());
            }
        }

        // --- E20–E59: Nimzo / Bogo families ---
        if letter == 'E' && (20..=59).contains(&num) {
            v.posicional += (if characteristics.is_positional {
                3.0
            } else {
                2.0
            }) * weight;
            v.dinamico += (if characteristics.is_dynamic { 3.0 } else { 2.0 }) * weight;
            if characteristics.is_hypermodern {
                v.hipermoderno += 3.0 * weight;
                v.dinamico += 1.0 * weight;
                v.posicional += 1.0 * weight;
            }
            if is_gambit {
                v.gambitero += 2.0 * weight;
                v.tactico += 1.0 * weight;
                gambit_ecos.insert(code.clone());
            }
        }

        // --- E60–E99: King's Indian family ---
        if letter == 'E' && (60..=99).contains(&num) {
            v.dinamico += (if characteristics.is_dynamic { 3.0 } else { 2.0 }) * weight;
            v.tactico += (if characteristics.is_tactical {
                3.0
            } else {
                2.0
            }) * weight;
            if characteristics.is_hypermodern {
                v.hipermoderno += 4.0 * weight;
                v.posicional += 2.0 * weight;
            } else {
                v.posicional += 1.0 * weight;
            }
            if lower_opening.contains("king's indian") || lower_opening.contains("kings indian") {
                v.hipermoderno += 1.0 * weight;
                v.dinamico += 1.0 * weight;
                v.posicional += 1.0 * weight;
            }
            if is_gambit {
                v.gambitero += 2.0 * weight;
                gambit_ecos.insert(code.clone());
            }
        }
    }

    // Bonus for players who use several distinct gambit ECO families
    if gambit_ecos.len() >= 2 {
        v.gambitero += gambit_ecos.len() as f64;
        v.offbeat += (gambit_ecos.len() / 2) as f64;
    }

    // Clamp any negative component to zero
    if v.tactico < 0.0 {
        v.tactico = 0.0;
    }
    if v.posicional < 0.0 {
        v.posicional = 0.0;
    }
    if v.solido < 0.0 {
        v.solido = 0.0;
    }
    if v.gambitero < 0.0 {
        v.gambitero = 0.0;
    }
    if v.offbeat < 0.0 {
        v.offbeat = 0.0;
    }
    if v.sistematico < 0.0 {
        v.sistematico = 0.0;
    }
    if v.dinamico < 0.0 {
        v.dinamico = 0.0;
    }
    if v.hipermoderno < 0.0 {
        v.hipermoderno = 0.0;
    }

    v
}

fn get_player_style_label(vector: StyleVector) -> PlayerStyleLabel {
    // Port of `src/utils/playerStyle/styleLabel.ts`
    let total_raw = vector.tactico
        + vector.posicional
        + vector.solido
        + vector.gambitero
        + vector.offbeat
        + vector.sistematico
        + vector.dinamico
        + vector.hipermoderno;
    if total_raw == 0.0 {
        return PlayerStyleLabel {
            label: "playerStyle.mixedStyle".to_string(),
            description: "playerStyle.mixedStyleDescription".to_string(),
            color: "gray".to_string(),
        };
    }

    // Normalize to percentages
    let normalized = StyleVector {
        tactico: (vector.tactico / total_raw) * 100.0,
        posicional: (vector.posicional / total_raw) * 100.0,
        solido: (vector.solido / total_raw) * 100.0,
        gambitero: (vector.gambitero / total_raw) * 100.0,
        offbeat: (vector.offbeat / total_raw) * 100.0,
        sistematico: (vector.sistematico / total_raw) * 100.0,
        dinamico: (vector.dinamico / total_raw) * 100.0,
        hipermoderno: (vector.hipermoderno / total_raw) * 100.0,
    };

    let mut entries: Vec<(&'static str, f64)> = vec![
        ("tactico", normalized.tactico),
        ("posicional", normalized.posicional),
        ("solido", normalized.solido),
        ("gambitero", normalized.gambitero),
        ("offbeat", normalized.offbeat),
        ("sistematico", normalized.sistematico),
        ("dinamico", normalized.dinamico),
        ("hipermoderno", normalized.hipermoderno),
    ];
    entries.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let primary_key = entries[0].0;
    let primary_val = entries[0].1;
    let secondary_val = entries.get(1).map(|e| e.1).unwrap_or(0.0);

    let tactico = normalized.tactico;
    let posicional = normalized.posicional;
    let solido = normalized.solido;
    let gambitero = normalized.gambitero;
    let offbeat = normalized.offbeat;
    let sistematico = normalized.sistematico;
    let dinamico = normalized.dinamico;
    let hipermoderno = normalized.hipermoderno;

    if primary_val < 16.0 && secondary_val < 14.0 {
        return PlayerStyleLabel {
            label: "playerStyle.mixedStyle".to_string(),
            description: "playerStyle.mixedStyleDescription".to_string(),
            color: "gray".to_string(),
        };
    }

    // Derived metrics for style combinations
    let aggressive_blend = (tactico + dinamico) / 2.0;
    let positional_core = posicional >= 24.0 && posicional >= tactico && posicional >= dinamico;
    let gambit_core = gambitero >= 18.0
        && gambitero >= aggressive_blend * 0.6
        && gambitero >= offbeat * 0.55
        && gambitero >= posicional * 0.6;
    let creative_gambiteer = gambit_core && offbeat >= 15.0;
    let systems_player = sistematico >= 22.0 && posicional >= 18.0;
    let offbeat_heavy =
        offbeat >= 35.0 && gambitero < 20.0 && !positional_core && hipermoderno < 20.0;
    let classic_solid = solido >= 24.0 && posicional >= 22.0 && dinamico < 26.0;
    let dynamic_tactician = dinamico >= 25.0 && tactico >= 20.0 && gambitero < 24.0;
    let hypermodern_dynamic = hipermoderno >= 20.0
        && dinamico >= 20.0
        && tactico >= 15.0
        && (hipermoderno >= offbeat || offbeat < 25.0);

    // Complex labels (order matters)
    if creative_gambiteer {
        return PlayerStyleLabel {
            label: "playerStyle.creativeGambiteer".to_string(),
            description: "playerStyle.creativeGambiteerDescription".to_string(),
            color: "violet".to_string(),
        };
    }
    if gambit_core {
        return PlayerStyleLabel {
            label: "playerStyle.gambiteer".to_string(),
            description: "playerStyle.gambiteerDescription".to_string(),
            color: "violet".to_string(),
        };
    }
    if systems_player {
        return PlayerStyleLabel {
            label: "playerStyle.systemPlayer".to_string(),
            description: "playerStyle.systemPlayerDescription".to_string(),
            color: "teal".to_string(),
        };
    }
    if classic_solid {
        return PlayerStyleLabel {
            label: "playerStyle.classicalSolid".to_string(),
            description: "playerStyle.classicalSolidDescription".to_string(),
            color: "blue".to_string(),
        };
    }
    if hypermodern_dynamic {
        return PlayerStyleLabel {
            label: "playerStyle.hypermodernDynamic".to_string(),
            description: "playerStyle.hypermodernDynamicDescription".to_string(),
            color: "orange".to_string(),
        };
    }
    if positional_core && hipermoderno < 18.0 && (solido + sistematico >= 18.0 || offbeat <= 28.0) {
        return PlayerStyleLabel {
            label: "playerStyle.positional".to_string(),
            description: "playerStyle.positionalDescription".to_string(),
            color: "cyan".to_string(),
        };
    }
    if offbeat_heavy {
        return PlayerStyleLabel {
            label: "playerStyle.unconventionalOpenings".to_string(),
            description: "playerStyle.unconventionalOpeningsDescription".to_string(),
            color: "grape".to_string(),
        };
    }
    if dynamic_tactician {
        return PlayerStyleLabel {
            label: "playerStyle.dynamicTactician".to_string(),
            description: "playerStyle.dynamicTacticianDescription".to_string(),
            color: "red".to_string(),
        };
    }

    // Simple, axis-based labels
    if gambitero >= 22.0 {
        return PlayerStyleLabel {
            label: "playerStyle.gambiteer".to_string(),
            description: "playerStyle.gambiteerSimpleDescription".to_string(),
            color: "violet".to_string(),
        };
    }
    if hipermoderno >= 22.0 {
        return PlayerStyleLabel {
            label: "playerStyle.hypermodernDynamic".to_string(),
            description: "playerStyle.hypermodernDynamicDescription".to_string(),
            color: "orange".to_string(),
        };
    }
    if offbeat >= 28.0 && gambitero < 22.0 && hipermoderno < 20.0 {
        return PlayerStyleLabel {
            label: "playerStyle.unconventional".to_string(),
            description: "playerStyle.unconventionalDescription".to_string(),
            color: "grape".to_string(),
        };
    }
    if sistematico >= 24.0 {
        return PlayerStyleLabel {
            label: "playerStyle.systematic".to_string(),
            description: "playerStyle.systematicDescription".to_string(),
            color: "teal".to_string(),
        };
    }
    if posicional >= 26.0 && posicional >= tactico && posicional >= dinamico && hipermoderno < 18.0
    {
        return PlayerStyleLabel {
            label: "playerStyle.positional".to_string(),
            description: "playerStyle.positionalSimpleDescription".to_string(),
            color: "cyan".to_string(),
        };
    }
    if tactico >= 26.0 && tactico >= posicional && tactico >= solido {
        return PlayerStyleLabel {
            label: "playerStyle.tactical".to_string(),
            description: "playerStyle.tacticalDescription".to_string(),
            color: "pink".to_string(),
        };
    }
    if dinamico >= 26.0 {
        return PlayerStyleLabel {
            label: "playerStyle.dynamic".to_string(),
            description: "playerStyle.dynamicDescription".to_string(),
            color: "yellow".to_string(),
        };
    }
    if solido >= 24.0 {
        return PlayerStyleLabel {
            label: "playerStyle.solid".to_string(),
            description: "playerStyle.solidDescription".to_string(),
            color: "blue".to_string(),
        };
    }

    // Final fallback: map by primary axis
    match primary_key {
        "tactico" => PlayerStyleLabel {
            label: "playerStyle.tactical".to_string(),
            description: "playerStyle.tacticalFallbackDescription".to_string(),
            color: "pink".to_string(),
        },
        "posicional" => PlayerStyleLabel {
            label: "playerStyle.positional".to_string(),
            description: "playerStyle.positionalFallbackDescription".to_string(),
            color: "cyan".to_string(),
        },
        "solido" => PlayerStyleLabel {
            label: "playerStyle.solid".to_string(),
            description: "playerStyle.solidFallbackDescription".to_string(),
            color: "blue".to_string(),
        },
        "gambitero" => PlayerStyleLabel {
            label: "playerStyle.gambiteer".to_string(),
            description: "playerStyle.gambiteerFallbackDescription".to_string(),
            color: "violet".to_string(),
        },
        "offbeat" => PlayerStyleLabel {
            label: "playerStyle.unconventional".to_string(),
            description: "playerStyle.unconventionalFallbackDescription".to_string(),
            color: "grape".to_string(),
        },
        "sistematico" => PlayerStyleLabel {
            label: "playerStyle.systematic".to_string(),
            description: "playerStyle.systematicFallbackDescription".to_string(),
            color: "teal".to_string(),
        },
        "dinamico" => PlayerStyleLabel {
            label: "playerStyle.dynamic".to_string(),
            description: "playerStyle.dynamicFallbackDescription".to_string(),
            color: "orange".to_string(),
        },
        "hipermoderno" => PlayerStyleLabel {
            label: "playerStyle.hypermodernDynamic".to_string(),
            description: "playerStyle.hypermodernDynamicDescription".to_string(),
            color: "orange".to_string(),
        },
        _ => PlayerStyleLabel {
            label: "playerStyle.mixedStyle".to_string(),
            description: "playerStyle.mixedStyleDescription".to_string(),
            color: "gray".to_string(),
        },
    }
}

pub fn analyze_player_style_label(site_stats_data: &[SiteStatsData]) -> PlayerStyleLabel {
    let openings = extract_ecos_from_site_stats_data(site_stats_data);
    if openings.is_empty() {
        return PlayerStyleLabel {
            label: "playerStyle.noData".to_string(),
            description: "playerStyle.noDataDescription".to_string(),
            color: "gray".to_string(),
        };
    }
    let vector = style_from_eco_list(&openings);
    get_player_style_label(vector)
}
