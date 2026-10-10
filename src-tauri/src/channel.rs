use crate::util::Json;
use hmac::{Hmac, Mac};
use sha2::Sha256;

// NSP1: authenticated binary framing, byte-compatible with shared/channel.cjs.
// Frame = magic(4) | direction(1) | counter(8, big-endian) | HMAC-SHA256 tag(32) | JSON body.
const MAGIC: [u8; 4] = [0x4e, 0x53, 0x50, 0x01];
const HEADER_BYTES: usize = 4 + 1 + 8 + 32;
pub const TO_SERVICE: u8 = 1;
pub const TO_DEVICE: u8 = 2;

type HmacSha256 = Hmac<Sha256>;

pub struct Channel {
    key: [u8; 32],
    send_direction: u8,
    receive_direction: u8,
    send_counter: u64,
    receive_counter: u64,
}

fn mac(key: &[u8]) -> HmacSha256 {
    <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC accepts any key length")
}

impl Channel {
    pub fn new(token: &str, nonce: &[u8], send_direction: u8) -> Self {
        let mut derive = mac(token.as_bytes());
        derive.update(b"northstar-channel-v1");
        derive.update(nonce);
        let key: [u8; 32] = derive.finalize().into_bytes().into();
        Channel {
            key,
            send_direction,
            receive_direction: if send_direction == TO_SERVICE { TO_DEVICE } else { TO_SERVICE },
            send_counter: 0,
            receive_counter: 0,
        }
    }

    fn tag(&self, direction: u8, counter: u64, body: &[u8]) -> HmacSha256 {
        let mut hmac = mac(&self.key);
        hmac.update(&[direction]);
        hmac.update(&counter.to_be_bytes());
        hmac.update(body);
        hmac
    }

    pub fn seal(&mut self, message: &Json) -> Vec<u8> {
        let body = serde_json::to_vec(message).unwrap_or_default();
        self.send_counter += 1;
        let tag = self.tag(self.send_direction, self.send_counter, &body).finalize().into_bytes();
        let mut frame = Vec::with_capacity(HEADER_BYTES + body.len());
        frame.extend_from_slice(&MAGIC);
        frame.push(self.send_direction);
        frame.extend_from_slice(&self.send_counter.to_be_bytes());
        frame.extend_from_slice(&tag);
        frame.extend_from_slice(&body);
        frame
    }

    pub fn open(&mut self, frame: &[u8]) -> Option<Json> {
        if frame.len() <= HEADER_BYTES || frame[..4] != MAGIC || frame[4] != self.receive_direction {
            return None;
        }
        let counter = u64::from_be_bytes(frame[5..13].try_into().ok()?);
        if counter <= self.receive_counter {
            return None;
        }
        let body = &frame[HEADER_BYTES..];
        self.tag(self.receive_direction, counter, body)
            .verify_slice(&frame[13..HEADER_BYTES])
            .ok()?;
        self.receive_counter = counter;
        serde_json::from_slice(body).ok()
    }
}

pub fn parse_nonce(value: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    if !(22..=43).contains(&value.len())
        || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    let nonce = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value).ok()?;
    (nonce.len() >= 16).then_some(nonce)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn nonce() -> Vec<u8> {
        (0..16).collect()
    }

    // Frames produced by shared/channel.cjs for the same token and nonce.
    const NODE_TO_SERVICE: &str = "4e535001010000000000000001d1601085fa5fe1c3a359b9a61c4dae6ebbb2eeffb47b9ef8005e85fcc5c1bef87b2274797065223a2278222c226e223a317d";
    const NODE_TO_DEVICE: &str = "4e53500102000000000000000121701fa64913f7a6d52735c22a7c548e92698fd322aed63cda34ea5cb569cbdf7b2274797065223a22636f6d6d616e64222c22726571756573744964223a2272227d";

    #[test]
    fn opens_frames_made_by_the_node_channel() {
        let mut device = Channel::new("device-token-123", &nonce(), TO_SERVICE);
        let message = device.open(&hex::decode(NODE_TO_DEVICE).unwrap()).expect("node frame opens");
        assert_eq!(message["type"], "command");
        let mut service = Channel::new("device-token-123", &nonce(), TO_DEVICE);
        let message = service.open(&hex::decode(NODE_TO_SERVICE).unwrap()).expect("node frame opens");
        assert_eq!(message["n"], 1);
    }

    #[test]
    fn rust_frames_open_in_rust_and_reject_tampering_and_replay() {
        let mut device = Channel::new("t", &nonce(), TO_SERVICE);
        let mut service = Channel::new("t", &nonce(), TO_DEVICE);
        let frame = device.seal(&json!({"type": "telemetry"}));
        assert!(service.open(&frame).is_some());
        assert!(service.open(&frame).is_none());
        let mut bad = device.seal(&json!({"type": "telemetry"}));
        *bad.last_mut().unwrap() ^= 1;
        assert!(service.open(&bad).is_none());
        let mut other = Channel::new("other", &nonce(), TO_DEVICE);
        assert!(other.open(&device.seal(&json!({}))).is_none());
    }

    #[test]
    fn nonce_validation() {
        assert!(parse_nonce("AAECAwQFBgcICQoLDA0ODw").is_some());
        assert!(parse_nonce("short").is_none());
        assert!(parse_nonce("AAECAwQFBgcICQoLDA0O+w").is_none());
    }
}
