/** The text the app should render for a value. */
export function displayText(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
      return String(value);
    case 'undefined':
      return '';
    default:
      return value === null ? '' : JSON.stringify(value);
  }
}
