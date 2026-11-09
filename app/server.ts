import { resolveAiSeed } from './ai/seed.ts';
import { createApp } from './app.ts';
import { createBlockHandlers } from './engine/blocks.ts';
import { withEngineBug } from './engine/bugs.ts';
import { createEngine } from './engine/engine.ts';
import { fetchFromMockApi } from './mock-api/index.ts';
import { loadWorkflows } from './workflows/load.ts';

const port = Number(process.env.PORT ?? 3000);
const aiSeed = resolveAiSeed();
const engineBug = process.env.ENGINE_BUG?.trim() || null;

// Composition root. ENGINE_BUG swaps one faulty handler into the table
// before it reaches the engine; nothing else knows.
const handlers = withEngineBug(createBlockHandlers({ aiSeed }), engineBug ?? undefined);

const engine = createEngine({ handlers, fetchJson: fetchFromMockApi });
const app = createApp({ workflows: loadWorkflows(), engine, aiSeed, engineBug });

app.listen(port, () => {
  const bug = engineBug ? `, ENGINE_BUG=${engineBug}` : '';
  console.log(`app listening on http://localhost:${String(port)} (AI_SEED=${aiSeed}${bug})`);
});
