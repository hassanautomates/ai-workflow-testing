import express from 'express';

// Placeholder until the workflow engine lands (Milestone 2). It exists so
// Playwright and CI have a real server to start and probe.
const app = express();
const port = Number(process.env.PORT ?? 3000);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`app listening on http://localhost:${String(port)}`);
});
