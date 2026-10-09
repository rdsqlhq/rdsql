//! TLS for every Postgres-family connect path.
//!
//! Managed Postgres (AWS RDS on PG 15+, Supabase, Neon, Azure, …) commonly
//! rejects unencrypted sessions outright ("no pg_hba.conf entry … no
//! encryption"), so connecting with `NoTls` fails where psql/DBeaver/TablePlus
//! succeed. We follow libpq's `sslmode` semantics from the connection form:
//!
//! - empty / `prefer` / `allow` → try TLS, fall back to plaintext if the
//!   server doesn't offer it (libpq's default — local dev servers keep working)
//! - `require`                  → TLS only, certificate not verified
//! - `verify-ca` / `verify-full`→ TLS only, certificate checked against the OS
//!   trust store (hostname checked too — rustls has no CA-only mode)
//! - `disable`                  → plaintext only
//!
//! Like libpq, `prefer`/`require` don't verify the server certificate: cloud
//! providers sign with private CAs (e.g. the Amazon RDS CA) that aren't in any
//! system trust store, so verifying by default would break exactly the
//! servers this exists for.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use tokio_postgres::tls::MakeTlsConnect;
use tokio_postgres::{Client, Socket};
use tokio_postgres_rustls::MakeRustlsConnect;

pub type PgTlsStream = <MakeRustlsConnect as MakeTlsConnect<Socket>>::Stream;
pub type PgConnection = tokio_postgres::Connection<Socket, PgTlsStream>;

/// Both `ring` and `aws-lc-rs` end up compiled into rustls via other deps, so
/// `ClientConfig::builder()` can't pick a process default — name one.
fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

#[derive(Debug)]
struct AcceptAnyCert(Arc<CryptoProvider>);

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn tls_connector(verify: bool) -> MakeRustlsConnect {
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS protocol versions");
    let config = if verify {
        let mut roots = RootCertStore::empty();
        for cert in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(cert);
        }
        builder.with_root_certificates(roots).with_no_client_auth()
    } else {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCert(provider)))
            .with_no_client_auth()
    };
    MakeRustlsConnect::new(config)
}

/// Map the form's `sslMode` to tokio-postgres's `sslmode` (which only knows
/// disable/prefer/require) plus whether to verify the certificate.
fn resolve(ssl_mode: Option<&str>) -> (&'static str, bool) {
    match ssl_mode.map(|m| m.trim().to_ascii_lowercase()).as_deref() {
        Some("disable") => ("disable", false),
        Some("require") => ("require", false),
        Some("verify-ca") | Some("verify-full") => ("require", true),
        _ => ("prefer", false),
    }
}

/// Drop-in replacement for `tokio_postgres::connect(conn_str, NoTls)` that
/// honours the connection's `sslMode`. Callers keep their own timeout.
pub async fn connect(
    conn_str: &str,
    ssl_mode: Option<&str>,
) -> Result<(Client, PgConnection), tokio_postgres::Error> {
    let (mode, verify) = resolve(ssl_mode);
    let conn_str = format!("{} sslmode={}", conn_str, mode);
    tokio_postgres::connect(&conn_str, tls_connector(verify)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_sslmode_like_libpq() {
        assert_eq!(resolve(None), ("prefer", false));
        assert_eq!(resolve(Some("")), ("prefer", false));
        assert_eq!(resolve(Some("allow")), ("prefer", false));
        assert_eq!(resolve(Some("disable")), ("disable", false));
        assert_eq!(resolve(Some("REQUIRE")), ("require", false));
        assert_eq!(resolve(Some("verify-full")), ("require", true));
    }

    #[test]
    fn builds_both_connectors() {
        tls_connector(false);
        tls_connector(true);
    }
}
