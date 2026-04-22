# Reoon Email Verifier API Documentation

## Authentication
All requests require `key=<Your_API_Key>` parameter.

---

## 1. Single Email Verification

### Quick Mode (0.5 seconds, no SMTP inbox check)
```
GET https://emailverifier.reoon.com/api/v1/verify?email=<email>&key=<key>&mode=quick
```

### Power Mode (full SMTP check, 1–60+ seconds)
```
GET https://emailverifier.reoon.com/api/v1/verify?email=<email>&key=<key>&mode=power
```

### Response (JSON)
```json
{
  "email": "jhon123@gmail.com",
  "status": "safe",
  "overall_score": 98,
  "username": "jhon123",
  "domain": "gmail.com",
  "is_safe_to_send": true,
  "is_valid_syntax": true,
  "is_disposable": false,
  "is_role_account": false,
  "can_connect_smtp": true,
  "has_inbox_full": false,
  "is_catch_all": false,
  "is_deliverable": true,
  "is_disabled": false,
  "is_spamtrap": false,
  "is_free_email": true,
  "mx_accepts_mail": true,
  "mx_records": ["alt3.gmail-smtp-in.l.google.com"],
  "verification_mode": "power"
}
```

### Status values
`"safe"` | `"invalid"` | `"disabled"` | `"disposable"` | `"inbox_full"` | `"catch_all"` | `"role_account"` | `"spamtrap"` | `"unknown"`

---

## 2. Bulk Email Verification

### Step 1: Submit emails & create task
```
POST https://emailverifier.reoon.com/api/v1/create-bulk-verification-task/
Content-Type: application/json

{
  "name": "Task Name",
  "emails": ["test1@example.com", "test2@example.com"],
  "key": "Your_API_Key"
}
```
- Max 50,000 emails per task
- Returns HTTP 201 on success

Success response:
```json
{
  "status": "success",
  "task_id": 123456,
  "count_submitted": 3,
  "count_duplicates_removed": 0,
  "count_processing": 3
}
```

### Step 2: Poll for results
```
GET https://emailverifier.reoon.com/api/v1/get-result-bulk-verification-task/?key=<key>&task_id=<task_id>
```

Response while running:
```json
{
  "task_id": "40676",
  "name": "API: Task via API",
  "status": "running",
  "count_total": 7,
  "count_checked": 3,
  "progress_percentage": 42.8
}
```

Response when completed:
```json
{
  "task_id": "40676",
  "status": "completed",
  "count_total": 7,
  "count_checked": 7,
  "progress_percentage": 100.0,
  "results": {
    "jhon200@outlook.com": {
      "can_connect_smtp": true,
      "domain": "outlook.com",
      "email": "jhon200@outlook.com",
      "has_inbox_full": false,
      "is_catch_all": false,
      "is_deliverable": true,
      "is_disabled": false,
      "is_disposable": false,
      "is_role_account": false,
      "is_safe_to_send": true,
      "is_spamtrap": false,
      "is_valid_syntax": true,
      "mx_accepts_mail": true,
      "mx_records": ["outlook-com.olc.protection.outlook.com"],
      "status": "safe",
      "username": "jhon200"
    }
  }
}
```

Task status values: `"waiting"` | `"running"` | `"completed"` | `"file_not_found"` | `"file_loading_error"`

---

## 3. Check Account Balance
```
GET https://emailverifier.reoon.com/api/v1/check-account-balance/?key=<Your_API_Key>
```

Response:
```json
{
  "api_status": "active",
  "remaining_daily_credits": 150,
  "remaining_instant_credits": 5000,
  "status": "success"
}
```

---

## Status Mapping to USIP Tags
| Reoon status | USIP badge |
|---|---|
| `safe` | Valid (green) |
| `catch_all` | Accept-All (yellow) |
| `role_account` | Risky (yellow) |
| `disposable` | Risky (yellow) |
| `inbox_full` | Risky (yellow) |
| `invalid` | Invalid (red) |
| `disabled` | Invalid (red) |
| `spamtrap` | Invalid (red) |
| `unknown` | Unknown (gray) |
