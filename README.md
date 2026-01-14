# AtomicMail Username Checker

A fast and configurable username availability checker for **AtomicMail**, built with Node.js.  
The tool checks large username lists using rotating proxies and provides clean, real-time console output.

---

## Features

- Bulk username availability checking
- Supports HTTP / HTTPS proxies
- Automatic proxy rotation on:
  - Rate limits (HTTP 429)
  - Timeouts and connection errors
- Concurrent requests with configurable limits
- Live console title updates (progress, available, taken)
- Clean, color-coded console output
- Instant file output while running

---

## How It Works

The checker sends availability requests to the AtomicMail signup endpoint.  
Each request is routed through a proxy.  
If a proxy fails or gets rate-limited, the next proxy is used automatically.

Usernames are classified as:
- **Available** – username can be registered
- **Taken** – username already exists
- **Error** – proxy or network related failure

---

## Requirements

- Node.js **v18 or higher**
- Working HTTP/HTTPS proxies  
  (free proxy lists are usually unreliable)

---

## Installation

```bash
npm install undici p-limit chalk
