use near_sdk::env;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::json;

pub const EVENT_STANDARD: &str = "cleartape";
pub const EVENT_VERSION: &str = "1.0.0";

pub fn emit_event<T: Serialize>(event: &str, data: &T) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}
