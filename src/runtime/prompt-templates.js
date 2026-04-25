export function loadPromptTemplate(name, fallback = '') {
  if (!name || typeof name !== 'string') return fallback ?? '';
  const key = name.trim();
  if (!key) return fallback ?? '';

  // Prompt templates are inline-only. Preserve runtime behaviour by returning
  // the live fallback string directly.
  if (fallback === null || fallback === undefined) {
    throw new Error(`Prompt template "${key}" must provide an inline fallback.`);
  }
  return fallback ?? '';
}

export function renderPromptTemplate(template, vars = {}) {
  if (typeof template !== 'string' || template.length === 0) return '';
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    const value = vars[key];
    if (value === null || value === undefined) return '';
    return String(value);
  });
}
