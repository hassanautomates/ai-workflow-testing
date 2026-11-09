import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Engine, Run } from './engine/engine.ts';
import type { Workflow } from './engine/schema.ts';
import { isUiStep } from './engine/schema.ts';
import { isPlainObject } from './engine/state.ts';
import { mockApiGet } from './mock-api/index.ts';
import { completePage, errorPage, homePage, notFoundPage, stepPage } from './views/pages.ts';

export interface AppDeps {
  workflows: readonly Workflow[];
  engine: Engine;
}

/** Urlencoded bodies arrive untyped; keep only string fields. */
function toStringRecord(body: unknown): Record<string, string> {
  if (!isPlainObject(body)) return {};
  return Object.fromEntries(
    Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export function createApp({ workflows, engine }: AppDeps): express.Express {
  const app = express();
  // Runs live in memory: this is a demo app with no database (see SPEC.md).
  const runs = new Map<string, Run>();
  const findWorkflow = (id: string) => workflows.find((workflow) => workflow.id === id);

  app.use(express.urlencoded({ extended: false }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/workflows', (_req, res) => {
    res.json(workflows.filter((workflow) => workflow.published));
  });

  // Everything else under /api is the deterministic mock data API.
  app.get('/api/{*rest}', (req, res) => {
    const response = mockApiGet(req.originalUrl);
    res.status(response.status).json(response.body);
  });

  app.get('/', (_req, res) => {
    res.send(homePage(workflows));
  });

  /** Starts a run, then redirects to it so reloading the page doesn't start another. */
  app.get('/run/:workflowId', async (req, res) => {
    const workflow = findWorkflow(req.params.workflowId);
    if (!workflow) {
      res.status(404).send(notFoundPage(`No workflow "${req.params.workflowId}".`));
      return;
    }
    const run = await engine.start(workflow, randomUUID());
    runs.set(run.id, run);
    res.redirect(303, `/runs/${run.id}`);
  });

  app.get('/runs/:runId', (req, res) => {
    const run = runs.get(req.params.runId);
    const workflow = run && findWorkflow(run.workflowId);
    if (!run || !workflow) {
      res.status(404).send(notFoundPage(`No run "${req.params.runId}".`));
      return;
    }
    if (run.status === 'complete') {
      res.send(completePage(workflow, run));
      return;
    }
    const step = workflow.steps.find((candidate) => candidate.id === run.currentStepId);
    if (run.status === 'error' || !step || !isUiStep(step)) {
      res.send(errorPage(workflow, run));
      return;
    }
    res.send(stepPage(workflow, run, step));
  });

  app.post('/runs/:runId/steps/:stepId', async (req, res) => {
    const run = runs.get(req.params.runId);
    const workflow = run && findWorkflow(run.workflowId);
    if (!run || !workflow) {
      res.status(404).send(notFoundPage(`No run "${req.params.runId}".`));
      return;
    }
    const outcome = await engine.submit(workflow, run, req.params.stepId, toStringRecord(req.body));
    if (outcome.kind === 'invalid') {
      const step = workflow.steps.find((candidate) => candidate.id === req.params.stepId);
      if (step && isUiStep(step)) {
        res.status(422).send(stepPage(workflow, run, step, outcome.errors, outcome.values));
        return;
      }
    }
    runs.set(run.id, outcome.run);
    res.redirect(303, `/runs/${run.id}`);
  });

  return app;
}
