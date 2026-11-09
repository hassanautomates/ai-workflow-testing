import type { BlockContext, BlockHandlers, BlockResult } from './blocks.ts';
import { applyFormInput } from './form.ts';
import { type HeadlessStep, type Step, type UiStep, type Workflow, isUiStep } from './schema.ts';
import { EngineError, type EngineErrorCode, type State, getPath, isPlainObject } from './state.ts';

export type RunStatus = 'in-progress' | 'complete' | 'error';

export interface Run {
  readonly id: string;
  readonly workflowId: string;
  readonly state: State;
  readonly status: RunStatus;
  /** The UI step currently shown. Null once the run has completed or failed. */
  readonly currentStepId: string | null;
  /**
   * Counts the screens this run has shown: 1 for the first, +1 each time the
   * run moves on. Rendered on every page so tests can wait for "the next
   * screen" without knowing in advance which step it will be.
   */
  readonly screenSeq: number;
  readonly error?: string;
  readonly errorCode?: EngineErrorCode;
}

export type SubmitOutcome =
  | { kind: 'advanced'; run: Run }
  | { kind: 'invalid'; run: Run; errors: Record<string, string>; values: Record<string, string> }
  /** The step isn't the one being shown (double submit, back button). Nothing changed. */
  | { kind: 'stale'; run: Run };

export interface EngineDeps {
  handlers: BlockHandlers;
  fetchJson: BlockContext['fetchJson'];
}

/** Guards against a workflow whose `next`/`condition` targets form a loop with no UI step. */
const MAX_HEADLESS_STEPS = 1000;

export function createEngine({ handlers, fetchJson }: EngineDeps) {
  function runHeadless(step: HeadlessStep, state: State): Promise<BlockResult> {
    const ctx = { state, fetchJson };
    switch (step.block) {
      case 'math':
        return handlers.math(step, ctx);
      case 'string':
        return handlers.string(step, ctx);
      case 'object':
        return handlers.object(step, ctx);
      case 'condition':
        return handlers.condition(step, ctx);
      case 'fetch':
        return handlers.fetch(step, ctx);
      case 'ai':
        return handlers.ai(step, ctx);
      case 'id':
        return handlers.id(step, ctx);
    }
  }

  /** Index of the step that follows `step`, or `steps.length` when the run is over. */
  function nextIndex(workflow: Workflow, step: Step, goto?: string): number {
    const target = goto ?? step.next;
    if (target === undefined) return workflow.steps.indexOf(step) + 1;
    const index = workflow.steps.findIndex((candidate) => candidate.id === target);
    if (index === -1) {
      throw new EngineError('bad-args', `step "${step.id}" points at unknown step "${target}"`);
    }
    return index;
  }

  /** Fails fast if a UI step would render values that aren't there. */
  function checkUiStep(step: UiStep, state: State): void {
    if (step.block === 'details') {
      for (const field of step.fields) getPath(state, field.path);
    } else if (step.block === 'table') {
      const rows = getPath(state, step.rows);
      if (!Array.isArray(rows) || !rows.every(isPlainObject)) {
        throw new EngineError(
          'wrong-type',
          `table "${step.id}": "${step.rows}" is not a list of objects`,
        );
      }
      rows.forEach((_row, index) => {
        for (const column of step.columns)
          getPath(state, `${step.rows}.${String(index)}.${column.key}`);
      });
    }
  }

  /** Runs headless steps from `startIndex` until a UI step is reached or the workflow ends. */
  async function advance(workflow: Workflow, run: Run, startIndex: number): Promise<Run> {
    let state = run.state;
    let index = startIndex;
    const screenSeq = run.screenSeq + 1;
    try {
      for (let hops = 0; index < workflow.steps.length; hops++) {
        if (hops > MAX_HEADLESS_STEPS) {
          throw new EngineError('step-loop', 'too many steps without a UI step');
        }
        const step = workflow.steps[index];
        if (step === undefined) break;
        if (isUiStep(step)) {
          checkUiStep(step, state);
          return { ...run, state, screenSeq, status: 'in-progress', currentStepId: step.id };
        }
        const result = await runHeadless(step, state);
        state = result.state;
        index = nextIndex(workflow, step, result.goto);
      }
      return { ...run, state, screenSeq, status: 'complete', currentStepId: null };
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return {
        ...run,
        state,
        screenSeq,
        status: 'error',
        currentStepId: null,
        error: error.message,
        errorCode: error.code,
      };
    }
  }

  return {
    start(workflow: Workflow, runId: string): Promise<Run> {
      const run: Run = {
        id: runId,
        workflowId: workflow.id,
        state: {},
        status: 'in-progress',
        currentStepId: null,
        screenSeq: 0,
      };
      return advance(workflow, run, 0);
    },

    /** Applies the user's action on the current UI step, then advances. */
    async submit(
      workflow: Workflow,
      run: Run,
      stepId: string,
      input: Readonly<Record<string, string>>,
    ): Promise<SubmitOutcome> {
      const step = workflow.steps.find((candidate) => candidate.id === stepId);
      if (run.status !== 'in-progress' || run.currentStepId !== stepId || step === undefined) {
        return { kind: 'stale', run };
      }
      let state = run.state;
      if (step.block === 'form') {
        const outcome = applyFormInput(step, state, input);
        if (!outcome.ok)
          return { kind: 'invalid', run, errors: outcome.errors, values: outcome.values };
        state = outcome.state;
      }
      return {
        kind: 'advanced',
        run: await advance(workflow, { ...run, state }, nextIndex(workflow, step)),
      };
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
