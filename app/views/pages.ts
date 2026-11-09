import type { Run } from '../engine/engine.ts';
import type { FormStep, UiStep, Workflow } from '../engine/schema.ts';
import { getPath, toDisplayString } from '../engine/state.ts';
import { SafeHtml, html } from './html.ts';

// Page contract for tests. Tests find things only through these attributes,
// never through text or CSS classes:
//   <main data-workflow-id data-run-id data-run-status [data-step-id data-block]>
//     data-run-status: "in-progress" | "complete" | "error"
//     data-step-id / data-block: the UI step on screen (absent once the run ends)
//   data-field="<state path>"        every displayed value, every form input,
//                                    and each table cell ("rows.0.key")
//   data-field-error="<field name>"  validation message for a form input
//   data-row-index="<n>"             each table body row
//   data-action="submit" | "continue"  the button that moves the run on
//   data-run-error                   the message on an error page

const styles = `
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1d2330; }
  main { max-width: 40rem; margin: 2rem auto; padding: 1.5rem 2rem; background: #fff;
         border: 1px solid #dde1e7; border-radius: 8px; }
  h1 { font-size: 1.4rem; margin-top: 0; }
  .eyebrow { color: #5b6475; font-size: 0.85rem; margin: 0; }
  label { display: block; margin-bottom: 1rem; font-weight: 600; }
  input { display: block; width: 100%; box-sizing: border-box; margin-top: 0.25rem;
          padding: 0.5rem; font: inherit; border: 1px solid #b8bfcb; border-radius: 4px; }
  .error { color: #b42318; font-weight: 400; margin: 0.25rem 0 0; }
  button { font: inherit; padding: 0.5rem 1.25rem; border: 0; border-radius: 4px;
           background: #2f5bd3; color: #fff; cursor: pointer; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1.5rem; }
  dt { color: #5b6475; } dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #e6e9ee; }
`;

function layout(title: string, mainAttrs: SafeHtml, body: SafeHtml): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          ${new SafeHtml(styles)}
        </style>
      </head>
      <body>
        <main ${mainAttrs}>${body}</main>
      </body>
    </html>`.value;
}

function runAttrs(run: Run, step?: UiStep): SafeHtml {
  return html`data-workflow-id="${run.workflowId}" data-run-id="${run.id}"
  data-run-status="${run.status}"${
    step ? html` data-step-id="${step.id}" data-block="${step.block}"` : ''
  }`;
}

function stepAction(run: Run, step: UiStep): string {
  return `/runs/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(step.id)}`;
}

function formBody(
  run: Run,
  step: FormStep,
  errors: Readonly<Record<string, string>>,
  values: Readonly<Record<string, string>>,
): SafeHtml {
  const fields = step.fields.map((field) => {
    const error = errors[field.name];
    // Number fields use a text input with a decimal keypad: type="number" lets the
    // browser reformat or silently drop input, and the server validates anyway.
    return html`<label
      >${field.label}
      <input
        name="${field.name}"
        data-field="${field.name}"
        type="text"
        ${field.type === 'number' ? html`inputmode="decimal"` : ''}
        value="${values[field.name] ?? ''}"
        ${field.required ? html`required` : ''}
      />
      ${error ? html`<p class="error" data-field-error="${field.name}">${error}</p>` : ''}
    </label>`;
  });
  return html`<form method="post" action="${stepAction(run, step)}" novalidate>
    ${fields}
    <button type="submit" data-action="submit">${step.submitLabel}</button>
  </form>`;
}

function continueButton(run: Run, step: UiStep): SafeHtml {
  return html`<form method="post" action="${stepAction(run, step)}">
    <button type="submit" data-action="continue">Continue</button>
  </form>`;
}

function stepBody(
  run: Run,
  step: UiStep,
  errors: Readonly<Record<string, string>>,
  values: Readonly<Record<string, string>>,
): SafeHtml {
  switch (step.block) {
    case 'form':
      return formBody(run, step, errors, values);
    case 'details': {
      const rows = step.fields.map(
        (field) =>
          html`<dt>${field.label}</dt>
            <dd data-field="${field.path}">${toDisplayString(getPath(run.state, field.path))}</dd>`,
      );
      return html`<dl>${rows}</dl>
        ${continueButton(run, step)}`;
    }
    case 'table': {
      // The engine checked on entry that this is an array of objects.
      const rows = getPath(run.state, step.rows) as readonly unknown[];
      const body = rows.map((_row, index) => {
        const cells = step.columns.map((column) => {
          const path = `${step.rows}.${String(index)}.${column.key}`;
          return html`<td data-field="${path}">${toDisplayString(getPath(run.state, path))}</td>`;
        });
        return html`<tr data-row-index="${index}">
          ${cells}
        </tr>`;
      });
      const empty = html`<tr>
        <td colspan="${step.columns.length}">No rows</td>
      </tr>`;
      return html`<table data-field="${step.rows}">
          <thead>
            <tr>
              ${step.columns.map((column) => html`<th>${column.label}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${rows.length > 0 ? body : empty}
          </tbody>
        </table>
        ${continueButton(run, step)}`;
    }
  }
}

export function stepPage(
  workflow: Workflow,
  run: Run,
  step: UiStep,
  errors: Readonly<Record<string, string>> = {},
  values: Readonly<Record<string, string>> = {},
): string {
  return layout(
    `${step.title} · ${workflow.name}`,
    runAttrs(run, step),
    html`<p class="eyebrow">${workflow.name}</p>
      <h1>${step.title}</h1>
      ${stepBody(run, step, errors, values)}`,
  );
}

export function completePage(workflow: Workflow, run: Run): string {
  return layout(
    `Done · ${workflow.name}`,
    runAttrs(run),
    html`<p class="eyebrow">${workflow.name}</p>
      <h1>Done</h1>
      <p>
        This run is complete. <a href="/run/${workflow.id}">Start another</a> or go
        <a href="/">home</a>.
      </p>`,
  );
}

export function errorPage(workflow: Workflow, run: Run): string {
  return layout(
    `Error · ${workflow.name}`,
    runAttrs(run),
    html`<p class="eyebrow">${workflow.name}</p>
      <h1>Something went wrong</h1>
      <p class="error" data-run-error>${run.error ?? 'Unknown error'}</p>
      <p><a href="/run/${workflow.id}">Start again</a></p>`,
  );
}

export function homePage(workflows: readonly Workflow[]): string {
  const items = workflows.map(
    (workflow) =>
      html`<li>
        <a href="/run/${workflow.id}">${workflow.name}</a
        >${workflow.published ? '' : ' (unpublished)'}
      </li>`,
  );
  return layout(
    'Workflows',
    html`data-page="home"`,
    html`<h1>Workflows</h1>
      <ul>
        ${items}
      </ul>`,
  );
}

export function notFoundPage(message: string): string {
  return layout(
    'Not found',
    html`data-page="not-found"`,
    html`<h1>Not found</h1>
      <p>${message}</p>`,
  );
}
