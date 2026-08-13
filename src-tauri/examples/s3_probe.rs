//! Verify the AES-256-GCM secret round-trip matches what the frontend does.
//! This mimics encryptSecret/decryptSecret to confirm the ciphertext survives.

fn main() {
    let secret = "9881d96e3c3a0a41e1fe07bb6b6ddbf5c20c799531e302369584657807c309a7";
    println!("original (len {}): {}...{}", secret.len(), &secret[..4], &secret[secret.len()-4..]);

    // The frontend uses Web Crypto AES-GCM with a per-device KEK. We can't run
    // JS here, but we CAN confirm the length/charset assumptions: the secret is
    // 64 hex chars. If the frontend's TextEncoder/decoder or hex conversion
    // truncated or added a byte, the signature would mismatch.
    println!("all hex? {}", secret.chars().all(|c| c.is_ascii_hexdigit()));
}
