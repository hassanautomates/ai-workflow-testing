import { resolveAiSeed } from './ai/seed.ts';
import { createApp } from './app.ts';
import { createBlockHandlers } from './engine/blocks.ts';
import { createEngine } from './engine/engine.ts';
import { fetchFromMockApi } from './mock-api/index.ts';
import { loadWorkflows } from './workflows/load.ts';

const port = Number(process.env.PORT ?? 3000);
const aiSeed = resolveAiSeed();

// Composition root. ENGINE_BUG (Milestone 6) will hook in here by wrapping
// createBlockHandlers() before it reaches the engine; nothing else changes.
const handlers = createBlockHandlers({ aiSeed });

const engine = createEngine({ handlers, fetchJson: fetchFromMockApi });
const app = createApp({ workflows: loadWorkflows(), engine, aiSeed });

app.listen(port, () => {
  console.log(`app listening on http://localhost:${String(port)} (AI_SEED=${aiSeed})`);
});
