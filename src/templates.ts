export function missingTemplateVariables(required: string[], variables: Record<string, unknown>): string[] {
  return required.filter((name) => !(name in variables) || variables[name] === null || variables[name] === undefined);
}

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function renderTemplate(source: string, variables: Record<string, unknown>, escape: boolean): string {
  return source.replace(/{{\s*([a-zA-Z_][\w.-]*)\s*}}/g, (_match, name: string) => {
    const value = variables[name];
    const text = value === null || value === undefined ? '' : String(value);
    return escape ? escapeHtml(text) : text;
  });
}
