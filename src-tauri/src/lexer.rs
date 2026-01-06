use pgn_reader::{BufferedReader, Nag, RawHeader, SanPlus, Skip, Visitor};
use serde::Serialize;
use specta::Type;

use crate::error::Error;

#[derive(Default)]
struct Lexer {
    tokens: Vec<Token>,
}

#[derive(Serialize, Clone, Type, Debug, PartialEq, Eq)]
#[serde(tag = "type", content = "value")]
pub enum Token {
    ParenOpen,
    ParenClose,
    Comment(String),
    San(String),
    Header { tag: String, value: String },
    Nag(String),
    Outcome(String),
}

impl Visitor for Lexer {
    type Result = Result<Vec<Token>, String>;

    fn san(&mut self, san: SanPlus) {
        self.tokens.push(Token::San(san.to_string()));
    }

    fn header(&mut self, key: &[u8], value: RawHeader<'_>) {
        self.tokens.push(Token::Header {
            tag: String::from_utf8_lossy(key).to_string(),
            value: String::from_utf8_lossy(value.as_bytes()).to_string(),
        });
    }

    fn nag(&mut self, nag: Nag) {
        self.tokens.push(Token::Nag(nag.to_string()));
    }

    fn begin_variation(&mut self) -> Skip {
        self.tokens.push(Token::ParenOpen);
        Skip(false)
    }

    fn end_variation(&mut self) {
        self.tokens.push(Token::ParenClose);
    }

    fn comment(&mut self, comment: pgn_reader::RawComment<'_>) {
        self.tokens.push(Token::Comment(
            String::from_utf8_lossy(comment.as_bytes()).to_string(),
        ));
    }

    fn end_game(&mut self) -> Self::Result {
        Ok(self.tokens.clone())
    }

    fn outcome(&mut self, outcome: Option<shakmaty::Outcome>) {
        self.tokens.push(Token::Outcome(
            outcome.map(|o| o.to_string()).unwrap_or("*".to_string()),
        ));
    }
}

#[tauri::command]
#[specta::specta]
pub async fn lex_pgn(pgn: String) -> Result<Vec<Token>, Error> {
    let mut reader = BufferedReader::new(pgn.as_bytes());
    let mut lexer = Lexer::default();

    reader.read_game(&mut lexer)?;

    // `pgn-reader` is tolerant in some edge cases; validate structural invariants we rely on.
    let mut depth: i32 = 0;
    for t in &lexer.tokens {
        match t {
            Token::ParenOpen => depth += 1,
            Token::ParenClose => {
                depth -= 1;
                if depth < 0 {
                    return Err(Error::PackageManager(
                        "Invalid PGN: unexpected ')' in variation".to_string(),
                    ));
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err(Error::PackageManager(
            "Invalid PGN: unbalanced variation parentheses".to_string(),
        ));
    }

    Ok(lexer.tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header_value<'a>(tokens: &'a [Token], tag: &str) -> Option<&'a str> {
        tokens.iter().find_map(|t| match t {
            Token::Header { tag: ttag, value } if ttag == tag => Some(value.as_str()),
            _ => None,
        })
    }

    fn all_sans(tokens: &[Token]) -> Vec<&str> {
        tokens
            .iter()
            .filter_map(|t| match t {
                Token::San(s) => Some(s.as_str()),
                _ => None,
            })
            .collect()
    }

    fn contains_token(tokens: &[Token], needle: &Token) -> bool {
        tokens.iter().any(|t| t == needle)
    }

    #[test]
    fn lex_basic_headers_moves_outcome() {
        let pgn = r#"
[Event "Test"]
[Site "?"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 1-0
"#;

        let tokens = tauri::async_runtime::block_on(lex_pgn(pgn.to_string())).unwrap();

        // headers
        assert_eq!(header_value(&tokens, "Event"), Some("Test"));
        assert_eq!(header_value(&tokens, "Site"), Some("?"));
        assert_eq!(header_value(&tokens, "Result"), Some("1-0"));

        // moves
        let sans = all_sans(&tokens);
        assert_eq!(sans, vec!["e4", "e5", "Nf3", "Nc6"]);

        // last token should be outcome
        assert!(matches!(tokens.last(), Some(Token::Outcome(v)) if v == "1-0"));
    }

    #[test]
    fn lex_comments_nags_and_outcome_draw() {
        let pgn = r#"
[Event "Test"]
[Result "1/2-1/2"]

1. e4 {hello world} e5 $1 1/2-1/2
"#;

        let tokens = tauri::async_runtime::block_on(lex_pgn(pgn.to_string())).unwrap();

        // comment captured
        assert!(tokens.iter().any(|t| matches!(t, Token::Comment(c) if c == "hello world")));

        // NAG captured (format is usually "$1")
        assert!(tokens.iter().any(|t| matches!(t, Token::Nag(n) if !n.is_empty())));

        // moves present
        let sans = all_sans(&tokens);
        assert_eq!(sans, vec!["e4", "e5"]);

        // outcome
        assert!(matches!(tokens.last(), Some(Token::Outcome(v)) if v == "1/2-1/2"));
    }

    #[test]
    fn lex_variations_emit_parens_in_order() {
        let pgn = r#"
[Event "Var"]
[Result "*"]

1. e4 (1... c5) e5 *
"#;

        let tokens = tauri::async_runtime::block_on(lex_pgn(pgn.to_string())).unwrap();

        // ensure we have paren open/close
        assert!(contains_token(&tokens, &Token::ParenOpen));
        assert!(contains_token(&tokens, &Token::ParenClose));

        // order sanity: open before close
        let open_idx = tokens.iter().position(|t| matches!(t, Token::ParenOpen)).unwrap();
        let close_idx = tokens.iter().position(|t| matches!(t, Token::ParenClose)).unwrap();
        assert!(open_idx < close_idx);

        // SAN order typically: e4, c5, e5
        let sans = all_sans(&tokens);
        assert_eq!(sans, vec!["e4", "c5", "e5"]);

        // outcome "*" (unknown/unfinished)
        assert!(matches!(tokens.last(), Some(Token::Outcome(v)) if v == "*"));
    }

    #[test]
    fn lex_outcome_star_is_emitted_as_star() {
        let pgn = r#"
[Event "Star"]
[Result "*"]

1. d4 *
"#;

        let tokens = tauri::async_runtime::block_on(lex_pgn(pgn.to_string())).unwrap();
        assert!(matches!(tokens.last(), Some(Token::Outcome(v)) if v == "*"));
    }

    #[test]
    fn invalid_pgn_returns_error() {
        // Unbalanced variation parenthesis -> should fail parsing
        let pgn = r#"
[Event "Bad"]
1. e4 (1... c5 e5 1-0
"#;

        let res = tauri::async_runtime::block_on(lex_pgn(pgn.to_string()));
        assert!(res.is_err());
    }
}
