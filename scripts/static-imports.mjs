// The website's leaf modules can expose shared engines through either imports
// or re-exports. Both edges belong to the unchanged runtime dependency graph.
export function staticImports(source) {
  const statements = /^\s*(?:import\s+(?:[^'";]*?\bfrom\s*)?|export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*)['"]([^'"]+)['"]/gm;
  return [...new Set([...source.matchAll(statements)].map(match => match[1]))];
}
