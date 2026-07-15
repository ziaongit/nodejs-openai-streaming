# Node.js OpenAI Streaming Chat

A production-ready AI chat backend built with Node.js, Express, and the OpenAI Streaming API. Streams responses token by token using Server-Sent Events (SSE), with in-memory session management for multi-turn conversations and AbortController integration for clean cancellation on client disconnect.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                           Browser                                │
│                                                                  │
│  1. POST /session  ─────────────────────► receives sessionId     │
│  2. POST /chat { message, sessionId }                            │
│  3. response.body.getReader() ──► ReadableStream                 │
│  4. decode chunks ──► parse SSE events ──► append tokens to UI   │
└────────────────────────────┬─────────────────────────────────────┘
                             │  HTTP (text/event-stream)
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                       Express Server                             │
│                                                                  │
│  sessions Map  ──  { sessionId: { messages: [...] } }            │
│                                                                  │
│  POST /chat                                                      │
│    ├─ load session history                                       │
│    ├─ push user message                                          │
│    ├─ set SSE headers + flushHeaders()                           │
│    ├─ openai.create({ stream: true, signal: controller.signal }) │
│    ├─ for await chunk → res.write(`data: ${token}\n\n`)          │
│    ├─ accumulate fullResponse → push to session                  │
│    └─ send { done: true } → res.end()                            │
└────────────────────────────┬─────────────────────────────────────┘
                             │  HTTPS chunked transfer encoding
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                        OpenAI API                                │
│            gpt-4o-mini  ·  stream: true                          │
└──────────────────────────────────────────────────────────────────┘
```

---

## Features

- Token-by-token streaming via OpenAI's async iterable API
- Server-Sent Events (SSE) transport over plain HTTP
- In-memory session store with 30-minute TTL and automatic cleanup
- AbortController cancellation when the client disconnects
- Multi-turn conversation history passed to the model on every request
- Minimal, clean chat UI with message bubbles and a "New Chat" button

---

## Prerequisites

- Node.js v18 or later
- An OpenAI API key

---

## Setup

```bash
git clone https://github.com/ziaongit/nodejs-openai-streaming.git
cd nodejs-openai-streaming
npm install
cp .env.example .env
```

Edit `.env` and add your OpenAI API key:

```
OPENAI_API_KEY=your_api_key_here
PORT=3000
```

---

## Running

Development (auto-restarts on file changes):

```bash
npm run dev
```

Production:

```bash
npm start
```

Open `http://localhost:3000`.

---

## Project Structure

```
nodejs-openai-streaming/
├── server.js          # Express app — session store, SSE endpoint
├── public/
│   └── index.html     # Chat UI — fetch + ReadableStream reader
├── .env               # Your API key (not committed)
├── .env.example       # Template for environment variables
├── .gitignore
└── package.json
```

---

## API Reference

### `POST /session`

Creates a new conversation session.

**Response**

```json
{ "sessionId": "550e8400-e29b-41d4-a716-446655440000" }
```

---

### `POST /chat`

Streams an AI response for a given message. Returns a `text/event-stream` response.

**Request body**

```json
{
  "message": "Explain how Server-Sent Events work.",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Stream events**

| Event | Description |
|-------|-------------|
| `{ "token": "Hello" }` | One token from the model |
| `{ "done": true }` | Stream complete |
| `{ "error": "..." }` | Stream error |

---

### `DELETE /session/:sessionId`

Clears conversation history for a session. The session is removed from the store.

**Response**

```json
{ "ok": true }
```

---

## Production Notes

| Concern | Current | Production recommendation |
|---------|---------|--------------------------|
| Session storage | In-memory `Map` | Redis with `ioredis` |
| Rate limiting | None | `express-rate-limit` |
| Authentication | None | JWT middleware or session cookies |
| Context trimming | None | Sliding window or summarization for long conversations |
| Deployment | Single process | Stateless with Redis sessions, multiple instances behind a load balancer |

---

## Related Article

This project accompanies the StackAbuse tutorial:
**[Building a Real-Time AI Chat Feature in Node.js Using OpenAI's Streaming API](https://stackabuse.com)**

---

## License

MIT
