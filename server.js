import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// To test with Groq (free): set GROQ_API_KEY in .env and USE_GROQ=true
// For production / article: use OPENAI_API_KEY (USE_GROQ unset or false)
const useGroq = process.env.USE_GROQ === 'true';
const openai = useGroq
  ? new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    })
  : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Session store
// In production, replace this Map with Redis (ioredis works well here).
// Each session holds the full conversation history sent to OpenAI on every
// request, which is how the model maintains context across turns.
// ---------------------------------------------------------------------------
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      messages: [],
      lastActive: Date.now(),
    });
  }
  const session = sessions.get(sessionId);
  session.lastActive = Date.now();
  return session;
}

// Purge sessions idle for longer than SESSION_TTL_MS
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

// ---------------------------------------------------------------------------
// Session endpoints
// ---------------------------------------------------------------------------

// Create a new session — client stores the returned sessionId
app.post('/session', (req, res) => {
  const sessionId = crypto.randomUUID();
  getOrCreateSession(sessionId);
  console.log(`[/session] created: ${sessionId}`);
  res.json({ sessionId });
});

// Clear conversation history for a session (user clicks "New Chat")
app.delete('/session/:sessionId', (req, res) => {
  sessions.delete(req.params.sessionId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Chat endpoint — streams tokens to the client via Server-Sent Events
// ---------------------------------------------------------------------------
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const session = getOrCreateSession(sessionId);
  session.messages.push({ role: 'user', content: message });
  console.log(`[/chat] received:`, { message, sessionId });

  // Set SSE headers before any async work.
  // flushHeaders() sends them immediately — without it, Node.js buffers
  // the headers until the first res.write(), which defeats streaming.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // AbortController lets us cancel the OpenAI stream when the client
  // disconnects, preventing wasted API credits on unread tokens.
  const controller = new AbortController();
  // Use res.on('close') — fires when the CLIENT disconnects from the stream.
  // req.on('close') fires when the request body is consumed (immediately after POST arrives),
  // which would abort the stream before it starts.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let fullResponse = '';

  try {
    const stream = await openai.chat.completions.create(
      {
        model: useGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant. Be concise and clear.',
          },
          ...session.messages,
        ],
        stream: true,
        max_tokens: 800,
      },
      { signal: controller.signal }
    );

    for await (const chunk of stream) {
      // Double-check socket state; req 'close' may fire slightly late
      if (req.socket.destroyed) break;

      const token = chunk.choices[0]?.delta?.content;
      if (token) {
        fullResponse += token;
        // SSE format: "data: <json>\n\n" — the double newline is required
        res.write(`data: ${JSON.stringify({ token })}\n\n`);
      }
    }

    // Save the complete assistant reply to session history.
    // Partial responses (aborted streams) are not saved to avoid
    // corrupting the conversation context for future turns.
    if (fullResponse) {
      session.messages.push({ role: 'assistant', content: fullResponse });
      console.log(`[stream complete] ${fullResponse.length} chars`);
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'APIUserAbortError' || err.message === 'Request was aborted.') {
      // Client disconnected — end cleanly, don't save partial response
      res.end();
      return;
    }
    console.error('Stream error:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
