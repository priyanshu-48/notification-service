export function missingTemplateVariables(required: string[], variables: Record<string, unknown>): string[] {
  return required.filter((name) => !(name in variables) || variables[name] === null || variables[name] === undefined);
}

export function renderTemplate(source: string, variables: Record<string, unknown>, escapeHtml: boolean): string {
  return source.replace(/{{\s*([a-zA-Z_][\w.-]*)\s*}}/g, (_match, name: string) => {
    const value = variables[name];
    const text = value === null || value === undefined ? '' : String(value);
    return escapeHtml ? text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!) : text;
  });
}
