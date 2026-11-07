// Central configuration. Everything is an environment variable with a
// local-first default: no account, no cloud, no key required to boot.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const config = {
  root,
  host: process.env.START_AGENTS_HOST || '127.0.0.1',
  port: Number(process.env.START_AGENTS_PORT || 8797),
  dataDir: process.env.START_AGENTS_DATA || path.join(root, 'data'),
  // The sandbox is the only directory the file tools may touch. Point it
  // somewhere harmless while you learn the shape of the system.
  sandboxDir: process.env.START_AGENTS_SANDBOX || path.join(root, 'data', 'sandbox'),
  // Default engine for new bots: 'echo' works offline with no key.
  defaultEngine: process.env.START_AGENTS_ENGINE || 'echo',
  // OpenAI-compatible endpoint (works for OpenAI, OpenRouter, DeepSeek,
  // a local llama.cpp / Ollama server, ...). Used by the 'openai' engine.
  ai: {
    baseUrl: (process.env.START_AGENTS_AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: process.env.START_AGENTS_AI_API_KEY || '',
    model: process.env.START_AGENTS_AI_MODEL || 'gpt-4o-mini',
  },
};
