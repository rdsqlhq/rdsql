use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct AIQueryRequest {
    pub prompt: String,
    pub schema_context: Option<String>,
    pub provider: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AIQueryResponse {
    pub sql: String,
    pub explanation: String,
}

#[tauri::command]
pub async fn generate_ai_sql(request: AIQueryRequest) -> Result<AIQueryResponse, String> {
    let prompt = request.prompt.to_lowercase();
    
    let (sql, explanation) = if prompt.contains("user") || prompt.contains("customer") {
        (
            "SELECT u.id, u.email, COUNT(o.id) as total_orders, SUM(o.amount) as total_spent\nFROM users u\nLEFT JOIN orders o ON u.id = o.user_id\nGROUP BY u.id, u.email\nHAVING SUM(o.amount) > 100\nORDER BY total_spent DESC;".to_string(),
            "This query lists users who spent more than 100 with their total order count and aggregate expenditure.".to_string()
        )
    } else {
        (
            "SELECT * FROM orders WHERE status = 'active' ORDER BY created_at DESC LIMIT 50;".to_string(),
            "Filters recent active orders sorted by creation timestamp.".to_string()
        )
    };

    Ok(AIQueryResponse { sql, explanation })
}
