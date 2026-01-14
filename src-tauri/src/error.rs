use shakmaty::Chess;
use specta::Type;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error("I/O error: {0}")]
    IoError(std::io::Error),

    #[error("Unsupported file format: {0}")]
    UnsupportedFileFormat(String),

    #[error(transparent)]
    Zip(#[from] zip::result::ZipError),

    #[error(transparent)]
    BincodeEncode(#[from] bincode::error::EncodeError),

    #[error(transparent)]
    BincodeDecode(#[from] bincode::error::DecodeError),

    #[error(transparent)]
    XmlDeserialize(#[from] quick_xml::de::DeError),

    #[error(transparent)]
    ParseInt(#[from] std::num::ParseIntError),

    #[error(transparent)]
    Tauri(#[from] tauri::Error),

    #[error(transparent)]
    TauriShell(#[from] tauri_plugin_shell::Error),

    #[error(transparent)]
    TauriOpener(#[from] tauri_plugin_opener::Error),

    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),

    #[error(transparent)]
    ChessPosition(#[from] shakmaty::PositionError<Chess>),

    #[error(transparent)]
    IllegalUciMove(#[from] shakmaty::uci::IllegalUciMoveError),

    #[error(transparent)]
    ParseUciMove(#[from] shakmaty::uci::ParseUciMoveError),

    #[error(transparent)]
    Fen(#[from] shakmaty::fen::ParseFenError),

    #[error(transparent)]
    ParseSan(#[from] shakmaty::san::ParseSanError),

    #[error(transparent)]
    IllegalSan(#[from] shakmaty::san::SanError),

    #[error(transparent)]
    Diesel(#[from] diesel::result::Error),

    #[error(transparent)]
    DieselConnection(#[from] diesel::ConnectionError),

    #[error(transparent)]
    R2d2(#[from] diesel::r2d2::PoolError),

    #[error(transparent)]
    Rusqlite(#[from] rusqlite::Error),

    #[error(transparent)]
    SystemTime(#[from] std::time::SystemTimeError),

    #[error(transparent)]
    FromUtf8Error(#[from] std::string::FromUtf8Error),

    #[error(transparent)]
    FormatError(#[from] std::fmt::Error),

    #[error("No stdin")]
    NoStdin,

    #[error("No stdout")]
    NoStdout,

    #[error("No moves found")]
    NoMovesFound,

    #[error("Search stopped")]
    SearchStopped,

    #[error("Missing reference database")]
    MissingReferenceDatabase,

    #[error("No opening found")]
    NoOpeningFound,

    #[error("No match found")]
    NoMatchFound,

    #[error("No puzzles")]
    NoPuzzles,

    #[error("Cannot merge players: they are distinct players who have played against each other")]
    NotDistinctPlayers,

    #[error("Invalid binary data")]
    InvalidBinaryData,

    #[error("Failed to acquire mutex lock: {0}")]
    MutexLockFailed(String),

    #[error("Package manager error: {0}")]
    PackageManager(String),

    #[allow(dead_code)]
    #[error("Engine timeout")]
    EngineTimeout,

    #[allow(dead_code)]
    #[error("Engine stop timeout")]
    EngineStopTimeout,

    #[allow(dead_code)]
    #[error("Event emission failed")]
    EventEmissionFailed,

    #[allow(dead_code)]
    #[error("FEN parsing error: {0}")]
    FenError(String),

    #[allow(dead_code)]
    #[error("Position setup error: {0}")]
    PositionError(String),

    #[allow(dead_code)]
    #[error("UCI move parsing error: {0}")]
    UciMoveError(String),

    #[allow(dead_code)]
    #[error("Illegal move error: {0}")]
    IllegalMoveError(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),
}

impl serde::Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

impl Type for Error {
    fn inline(
        _type_map: &mut specta::TypeMap,
        _generics: specta::Generics,
    ) -> specta::datatype::DataType {
        specta::datatype::DataType::Primitive(specta::datatype::PrimitiveType::String)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;
    use serde::ser::{Error as SerErrorTrait, Impossible, Serializer};
    use std::time::SystemTime;

    // Minimal serializer that only supports serialize_str, so we can test Error's Serialize impl
    // without adding serde_json / serde_test dev-deps.
    #[derive(Debug)]
    struct OnlyStrSerializer;

    #[derive(Debug)]
    struct OnlyStrSerError(String);

    impl std::fmt::Display for OnlyStrSerError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "{}", self.0)
        }
    }
    impl std::error::Error for OnlyStrSerError {}
    impl SerErrorTrait for OnlyStrSerError {
        fn custom<T: std::fmt::Display>(msg: T) -> Self {
            OnlyStrSerError(msg.to_string())
        }
    }

    impl Serializer for OnlyStrSerializer {
        type Ok = String;
        type Error = OnlyStrSerError;

        type SerializeSeq = Impossible<String, OnlyStrSerError>;
        type SerializeTuple = Impossible<String, OnlyStrSerError>;
        type SerializeTupleStruct = Impossible<String, OnlyStrSerError>;
        type SerializeTupleVariant = Impossible<String, OnlyStrSerError>;
        type SerializeMap = Impossible<String, OnlyStrSerError>;
        type SerializeStruct = Impossible<String, OnlyStrSerError>;
        type SerializeStructVariant = Impossible<String, OnlyStrSerError>;

        fn serialize_str(self, value: &str) -> std::result::Result<Self::Ok, Self::Error> {
            Ok(value.to_string())
        }

        // Everything else: unsupported
        fn serialize_bool(self, _v: bool) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_i8(self, _v: i8) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_i16(self, _v: i16) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_i32(self, _v: i32) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_i64(self, _v: i64) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_u8(self, _v: u8) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_u16(self, _v: u16) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_u32(self, _v: u32) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_u64(self, _v: u64) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_f32(self, _v: f32) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_f64(self, _v: f64) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_char(self, _v: char) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_bytes(self, _v: &[u8]) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_none(self) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_some<T: ?Sized>(self, _value: &T) -> std::result::Result<Self::Ok, Self::Error>
        where
            T: serde::Serialize,
        {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_unit(self) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_unit_struct(self, _name: &'static str) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_unit_variant(
            self,
            _name: &'static str,
            _variant_index: u32,
            _variant: &'static str,
        ) -> std::result::Result<Self::Ok, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_newtype_struct<T: ?Sized>(
            self,
            _name: &'static str,
            _value: &T,
        ) -> std::result::Result<Self::Ok, Self::Error>
        where
            T: serde::Serialize,
        {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_newtype_variant<T: ?Sized>(
            self,
            _name: &'static str,
            _variant_index: u32,
            _variant: &'static str,
            _value: &T,
        ) -> std::result::Result<Self::Ok, Self::Error>
        where
            T: serde::Serialize,
        {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_seq(self, _len: Option<usize>) -> std::result::Result<Self::SerializeSeq, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_tuple(self, _len: usize) -> std::result::Result<Self::SerializeTuple, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_tuple_struct(
            self,
            _name: &'static str,
            _len: usize,
        ) -> std::result::Result<Self::SerializeTupleStruct, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_tuple_variant(
            self,
            _name: &'static str,
            _variant_index: u32,
            _variant: &'static str,
            _len: usize,
        ) -> std::result::Result<Self::SerializeTupleVariant, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_map(self, _len: Option<usize>) -> std::result::Result<Self::SerializeMap, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_struct(
            self,
            _name: &'static str,
            _len: usize,
        ) -> std::result::Result<Self::SerializeStruct, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
        fn serialize_struct_variant(
            self,
            _name: &'static str,
            _variant_index: u32,
            _variant: &'static str,
            _len: usize,
        ) -> std::result::Result<Self::SerializeStructVariant, Self::Error> {
            Err(OnlyStrSerError::custom("only serialize_str supported"))
        }
    }

    #[test]
    fn type_inline_is_string() {
        let mut type_map = specta::TypeMap::default();
        let dt = <Error as Type>::inline(&mut type_map, specta::Generics::NONE);

        match dt {
            specta::datatype::DataType::Primitive(specta::datatype::PrimitiveType::String) => {}
            other => panic!("expected primitive string, got: {:?}", other),
        }
    }

    #[test]
    fn serialize_is_display_string() {
        let err = Error::NoMovesFound;
        let s = err.serialize(OnlyStrSerializer).unwrap();
        assert_eq!(s, "No moves found");

        let err2 = Error::PackageManager("boom".to_string());
        let s2 = err2.serialize(OnlyStrSerializer).unwrap();
        assert_eq!(s2, "Package manager error: boom");
    }

    #[test]
    fn display_for_simple_variants() {
        assert_eq!(Error::NoStdin.to_string(), "No stdin");
        assert_eq!(Error::NoStdout.to_string(), "No stdout");
        assert_eq!(Error::SearchStopped.to_string(), "Search stopped");
        assert_eq!(
            Error::MissingReferenceDatabase.to_string(),
            "Missing reference database"
        );
        assert_eq!(Error::NoOpeningFound.to_string(), "No opening found");
        assert_eq!(Error::NoMatchFound.to_string(), "No match found");
        assert_eq!(Error::NoPuzzles.to_string(), "No puzzles");
        assert_eq!(
            Error::NotDistinctPlayers.to_string(),
            "Cannot merge players: they are distinct players who have played against each other"
        );
        assert_eq!(Error::InvalidBinaryData.to_string(), "Invalid binary data");
    }

    #[test]
    fn display_for_string_payload_variants() {
        assert_eq!(
            Error::UnsupportedFileFormat("pgnx".into()).to_string(),
            "Unsupported file format: pgnx"
        );
        assert_eq!(
            Error::MutexLockFailed("poisoned".into()).to_string(),
            "Failed to acquire mutex lock: poisoned"
        );
        assert_eq!(
            Error::PackageManager("bad path".into()).to_string(),
            "Package manager error: bad path"
        );

        assert_eq!(
            Error::FenError("bad fen".into()).to_string(),
            "FEN parsing error: bad fen"
        );
        assert_eq!(
            Error::PositionError("bad pos".into()).to_string(),
            "Position setup error: bad pos"
        );
        assert_eq!(
            Error::UciMoveError("bad uci".into()).to_string(),
            "UCI move parsing error: bad uci"
        );
        assert_eq!(
            Error::IllegalMoveError("illegal".into()).to_string(),
            "Illegal move error: illegal"
        );
    }

    #[test]
    fn from_std_io_error_maps_to_io_variant() {
        let io = std::io::Error::new(std::io::ErrorKind::Other, "disk");
        let err: Error = io.into();
        match err {
            Error::Io(e) => assert_eq!(e.to_string(), "disk"),
            other => panic!("expected Error::Io, got: {:?}", other),
        }
    }

    #[test]
    fn ioerror_variant_has_custom_prefix() {
        let io = std::io::Error::new(std::io::ErrorKind::Other, "disk");
        let err = Error::IoError(io);
        assert!(err.to_string().starts_with("I/O error: "));
        assert!(err.to_string().contains("disk"));
    }

    #[test]
    fn from_parse_int_error() {
        let parse_err = "nope".parse::<i32>().unwrap_err();
        let err: Error = parse_err.into();
        match err {
            Error::ParseInt(_) => {}
            other => panic!("expected Error::ParseInt, got: {:?}", other),
        }
        // message is platform/toolchain dependent; just ensure non-empty
        assert!(!err.to_string().is_empty());
    }

    #[test]
    fn from_system_time_error() {
        // duration_since with a "future" instant generates SystemTimeError
        let future = SystemTime::now();
        let past = std::time::UNIX_EPOCH;
        let sys_err = past.duration_since(future).unwrap_err();
        let err: Error = sys_err.into();

        match err {
            Error::SystemTime(_) => {}
            other => panic!("expected Error::SystemTime, got: {:?}", other),
        }
        assert!(!err.to_string().is_empty());
    }

    #[test]
    fn from_utf8_error() {
        let utf8_err = String::from_utf8(vec![0xFF]).unwrap_err();
        let err: Error = utf8_err.into();

        match err {
            Error::FromUtf8Error(_) => {}
            other => panic!("expected Error::FromUtf8Error, got: {:?}", other),
        }
        assert!(err.to_string().contains("utf-8") || !err.to_string().is_empty());
    }

    #[test]
    fn allow_dead_code_variants_display() {
        assert_eq!(Error::EngineTimeout.to_string(), "Engine timeout");
        assert_eq!(Error::EngineStopTimeout.to_string(), "Engine stop timeout");
        assert_eq!(
            Error::EventEmissionFailed.to_string(),
            "Event emission failed"
        );
    }

    #[test]
    fn result_type_alias_compiles() {
        fn ok() -> Result<i32> {
            Ok(123)
        }
        fn err() -> Result<i32> {
            Err(Error::NoMovesFound)
        }

        assert_eq!(ok().unwrap(), 123);
        assert_eq!(err().unwrap_err().to_string(), "No moves found");
    }
}
