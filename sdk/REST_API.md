# REST API Reference — Any Language

Base URL: `https://your-app.onrender.com`

Every request (except `/health`) needs:
- `Authorization: Bearer YOUR_API_KEY`
- `X-Namespace: your-project-name` (isolates keys per project)
- `Content-Type: application/json`

---

## cURL Examples

### Set a key
```bash
curl -X POST https://your-app.onrender.com/api/cache \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "X-Namespace: my-project" \
  -H "Content-Type: application/json" \
  -d '{"key": "user:123", "value": {"name": "Rajat"}, "ttl": 3600, "tags": ["users"]}'
```

### Get a key
```bash
curl https://your-app.onrender.com/api/cache/user:123 \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "X-Namespace: my-project"
```

### Batch set
```bash
curl -X POST https://your-app.onrender.com/api/cache/batch \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "X-Namespace: my-project" \
  -H "Content-Type: application/json" \
  -d '{"entries": [{"key": "a", "value": 1}, {"key": "b", "value": 2}], "ttl": 600}'
```

### Batch get
```bash
curl "https://your-app.onrender.com/api/cache/batch?keys=a,b,c" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "X-Namespace: my-project"
```

### Atomic increment
```bash
curl -X POST https://your-app.onrender.com/api/cache/incr \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "X-Namespace: my-project" \
  -H "Content-Type: application/json" \
  -d '{"key": "page:views", "amount": 1}'
```

### Hash set
```bash
curl -X POST https://your-app.onrender.com/api/cache/hash \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "X-Namespace: my-project" \
  -H "Content-Type: application/json" \
  -d '{"key": "session:abc", "op": "set", "fields": {"userId": 123, "role": "admin"}, "ttl": 1800}'
```

### Invalidate by tags
```bash
curl -X POST https://your-app.onrender.com/api/cache/invalidate \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "X-Namespace: my-project" \
  -H "Content-Type: application/json" \
  -d '{"tags": ["users"]}'
```

---

## Go Example

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
)

const (
    baseURL   = "https://your-app.onrender.com"
    apiKey    = "YOUR_API_KEY"
    namespace = "my-project"
)

func cacheSet(key string, value interface{}, ttl int) error {
    body, _ := json.Marshal(map[string]interface{}{
        "key": key, "value": value, "ttl": ttl,
    })
    req, _ := http.NewRequest("POST", baseURL+"/api/cache", bytes.NewReader(body))
    req.Header.Set("Authorization", "Bearer "+apiKey)
    req.Header.Set("X-Namespace", namespace)
    req.Header.Set("Content-Type", "application/json")

    resp, err := http.DefaultClient.Do(req)
    if err != nil { return err }
    defer resp.Body.Close()
    return nil
}

func cacheGet(key string) (interface{}, error) {
    req, _ := http.NewRequest("GET", baseURL+"/api/cache/"+key, nil)
    req.Header.Set("Authorization", "Bearer "+apiKey)
    req.Header.Set("X-Namespace", namespace)

    resp, err := http.DefaultClient.Do(req)
    if err != nil { return nil, err }
    defer resp.Body.Close()

    var result map[string]interface{}
    b, _ := io.ReadAll(resp.Body)
    json.Unmarshal(b, &result)
    return result["value"], nil
}

func main() {
    cacheSet("hello", "world", 3600)
    val, _ := cacheGet("hello")
    fmt.Println(val) // "world"
}
```

---

## PHP Example

```php
<?php
$baseUrl = "https://your-app.onrender.com";
$apiKey = "YOUR_API_KEY";
$namespace = "my-project";

function cacheRequest($method, $path, $body = null) {
    global $baseUrl, $apiKey, $namespace;

    $ch = curl_init("$baseUrl$path");
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        "Authorization: Bearer $apiKey",
        "X-Namespace: $namespace",
        "Content-Type: application/json",
    ]);

    if ($method === "POST") {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    } elseif ($method === "DELETE") {
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, "DELETE");
    }

    $response = curl_exec($ch);
    curl_close($ch);
    return json_decode($response, true);
}

// Set
cacheRequest("POST", "/api/cache", [
    "key" => "user:123",
    "value" => ["name" => "Rajat"],
    "ttl" => 3600,
]);

// Get
$data = cacheRequest("GET", "/api/cache/user:123");
echo $data["value"]["name"]; // Rajat
```

---

## Ruby Example

```ruby
require 'net/http'
require 'json'
require 'uri'

BASE_URL = "https://your-app.onrender.com"
API_KEY = "YOUR_API_KEY"
NAMESPACE = "my-project"

def cache_set(key, value, ttl: 3600)
  uri = URI("#{BASE_URL}/api/cache")
  req = Net::HTTP::Post.new(uri)
  req['Authorization'] = "Bearer #{API_KEY}"
  req['X-Namespace'] = NAMESPACE
  req['Content-Type'] = 'application/json'
  req.body = { key: key, value: value, ttl: ttl }.to_json
  Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |http| http.request(req) }
end

def cache_get(key)
  uri = URI("#{BASE_URL}/api/cache/#{key}")
  req = Net::HTTP::Get.new(uri)
  req['Authorization'] = "Bearer #{API_KEY}"
  req['X-Namespace'] = NAMESPACE
  resp = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |http| http.request(req) }
  JSON.parse(resp.body)['value']
end

cache_set("hello", "world")
puts cache_get("hello") # "world"
```

---

## Java Example

```java
import java.net.http.*;
import java.net.URI;

public class CacheExample {
    static final String BASE = "https://your-app.onrender.com";
    static final String KEY = "YOUR_API_KEY";
    static final HttpClient client = HttpClient.newHttpClient();

    static String cacheGet(String key) throws Exception {
        var req = HttpRequest.newBuilder()
            .uri(URI.create(BASE + "/api/cache/" + key))
            .header("Authorization", "Bearer " + KEY)
            .header("X-Namespace", "my-project")
            .GET().build();
        var resp = client.send(req, HttpResponse.BodyHandlers.ofString());
        return resp.body();
    }

    static void cacheSet(String key, String value) throws Exception {
        var body = String.format("{\"key\":\"%s\",\"value\":\"%s\",\"ttl\":3600}", key, value);
        var req = HttpRequest.newBuilder()
            .uri(URI.create(BASE + "/api/cache"))
            .header("Authorization", "Bearer " + KEY)
            .header("X-Namespace", "my-project")
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        client.send(req, HttpResponse.BodyHandlers.ofString());
    }
}
```
