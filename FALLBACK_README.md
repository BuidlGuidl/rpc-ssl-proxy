# RPC Proxy Fallback System

## Overview

The RPC proxy now includes a robust fallback mechanism using a **Circuit Breaker pattern** to handle failures gracefully.

## How It Works

### Circuit Breaker States
- **CLOSED**: Normal operation using primary URL
- **OPEN**: Using fallback URL after failures
- **HALF_OPEN**: Testing if primary URL has recovered

### Fallback Logic
1. **Primary URL fails 2 times consecutively on POST requests** → Switch to fallback
2. **After 60 seconds** → Test primary URL again (half-open state)
3. **If primary succeeds** → Return to primary URL
4. **If primary still fails** → Continue using fallback

**Note**: Only POST requests (actual RPC calls) affect the circuit breaker. GET requests often return 404 on RPC endpoints even when healthy, so they don't trigger fallback switching.

### Firebase Request Counting
- **Primary URL (successful)**: Requests are counted and sent to Firebase
- **Fallback URL**: Requests are **NOT** counted in Firebase (as requested)
- **Failed requests**: Not counted in Firebase
- **Immediate fallback retries**: Not counted in Firebase (even before circuit breaker opens)

## Configuration

Add these environment variables to your `.env` file:

```bash
# Required
TARGET_URL=https://stage.rpc.buidlguidl.com:48544
FALLBACK_URL=https://eth-mainnet.alchemyapi.io/v2/<API-KEY>

# Optional circuit breaker settings (defaults shown)
CIRCUIT_BREAKER_FAILURE_THRESHOLD=2    # failures before switching
CIRCUIT_BREAKER_RESET_TIMEOUT=60000    # milliseconds before retry
CIRCUIT_BREAKER_REQUEST_TIMEOUT=10000  # request timeout in ms
```

## Monitoring Endpoints

### `/status` - Circuit Breaker Status
Returns JSON with current circuit breaker state:
```json
{
  "circuitBreaker": {
    "state": "CLOSED",
    "consecutiveFailures": 0,
    "isUsingFallback": false,
    "currentUrl": "https://stage.rpc.buidlguidl.com:48544",
    "lastFailureTime": 0
  },
  "urls": {
    "primary": "https://stage.rpc.buidlguidl.com:48544",
    "fallback": "https://eth-mainnet.alchemyapi.io/v2/<API_KEY>"
  },
  "timestamp": "2024-01-16T10:30:00.000Z"
}
```

### `/proxy` - Enhanced Proxy Info
Now shows circuit breaker status in HTML format with:
- Primary URL
- Fallback URL  
- Current URL being used
- Circuit breaker state
- Whether fallback is active
- Consecutive failure count

## Key Features

### Immediate Fallback on Error
If the primary URL fails on a request, the system will:
1. Mark the failure in the circuit breaker
2. Immediately retry the same request with the fallback URL
3. Return the fallback response if successful

### Simplified Consistent Logic
- **Single fallback function**: All fallback requests use identical settings
- **Circuit breaker mode**: Uses fallback for all requests when open
- **Immediate retry mode**: Falls back on individual request failures
- **Same TLS settings**: Consistent behavior regardless of fallback trigger

### Smart Recovery
- Automatically tests primary URL recovery every 60 seconds
- Gradually returns to primary when it's healthy
- Logs all state changes for monitoring

### TLS/SSL Handling
- Fallback requests use the same TLS settings as the main proxy
- The provider's certificate is verified (its own `https.Agent`, `rejectUnauthorized: true`); the URL carries the API key, so an unverified connection would expose it
- Longer timeout (15s) for fallback requests to handle slower connections

## Logging

The system provides detailed logging:
- `✅ Circuit breaker: Primary URL recovered`
- `❌ Circuit breaker: Failure 1/2`
- `🚨 Circuit breaker: OPENED - switching to fallback`
- `🔄 Circuit breaker moving to HALF_OPEN - trying primary URL again`
- `🚨 Using fallback URL for request from example.com - NOT counting in Firebase`

## Benefits

1. **High Availability**: Seamless failover to backup RPC provider
2. **Cost Management**: Fallback requests don't count against Firebase limits
3. **Automatic Recovery**: Returns to primary when available
4. **Monitoring**: Full visibility into fallback usage
5. **Configurable**: Adjust thresholds and timeouts as needed

## Simplified Architecture

### Two Helper Functions
1. **`makePrimaryRequest()`**: Handles all primary URL requests with circuit breaker logic
2. **`makeFallbackRequest()`**: Handles all fallback requests with consistent TLS settings

### Request Flow
```
POST Request → Circuit Breaker Check
├── If OPEN: Use makeFallbackRequest() directly
└── If CLOSED: Try makePrimaryRequest()
    ├── Success: Return response
    └── Failure: Try makeFallbackRequest() (immediate retry)
```

### Benefits of Simplified Design
- **Consistent behavior**: Same logic for all fallback requests
- **No duplicate code**: Single function handles all fallback scenarios  
- **Reliable TLS**: Same HTTPS settings whether circuit is open or immediate retry
- **Easy debugging**: Clear separation between primary and fallback logic

## Important: GET vs POST Requests

### Why GET Requests Don't Affect Circuit Breaker
- **RPC servers typically only support POST requests** with JSON-RPC payloads
- **GET requests often return 404** even when the RPC server is perfectly healthy
- **Circuit breaker only monitors POST requests** to avoid false positives
- **GET errors will show**: `"This is normal for RPC endpoints"`

### Example of Normal Behavior
```
GET no referer
GET ERROR Request failed with status code 404 - This is normal for RPC endpoints
```
This is **NOT** a failure - your RPC server is working fine!

## Testing

To test the fallback mechanism:
1. Temporarily break the primary URL (e.g., modify TARGET_URL to invalid endpoint)
2. Make **2 POST RPC requests** (not GET requests)
3. Check `/status` endpoint to see circuit breaker state change to "OPEN"
4. Verify subsequent requests use fallback URL
5. Restore primary URL and wait 60 seconds to see recovery 