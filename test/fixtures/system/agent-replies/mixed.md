I looked at the three services. Here is what I found:

```json
{
  "edges": [
    { "from": "web", "to": "notify-worker", "label": "HTTP", "kind": "sync", "confidence": 0.6, "evidence": ["web/src/api.js:4"], "reason": "fetch to the worker's health endpoint" },
    { "from": "web", "to": "invoices-api", "label": "HTTP", "kind": "sync", "confidence": 0.95, "evidence": ["web/src/api.js:1"] },
    { "from": "web", "to": "billing", "label": "HTTP", "confidence": 0.9, "evidence": ["web/src/api.js:1"] },
    { "from": "notify-worker", "to": "notify-worker", "confidence": 0.5, "evidence": ["notify-worker/src/index.js:9"] },
    { "from": "notify-worker", "to": "postgres", "label": "sql", "confidence": 0.4, "evidence": ["notify-worker/src/index.js:999", "../etc/passwd:1", "nope"] },
    { "from": "invoices-api", "to": "resend", "label": "API", "confidence": 1.5, "evidence": ["invoices-api/src/server.js:1"] },
    { "from": "web", "to": "notify-worker", "label": "http", "confidence": 0.7, "evidence": ["web/src/main.jsx:5"] },
    { "from": "invoices-api", "to": "resend", "confidence": 0.55, "evidence": ["invoices-api/src/events.js:8", "invoices-api/src/missing.js:3"] },
    { "from": "web", "to": "kafka", "confidence": "high", "evidence": ["web/src/api.js:1"] }
  ]
}
```

Let me know if you want more detail.
