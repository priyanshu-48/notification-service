import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { FastifyInstance } from 'fastify';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const spec: any = parse(readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'));
export const methods = ['get', 'post', 'put', 'delete', 'patch'] as const;

/** The spec's own `#/components/...` pointers, followed. */
export function resolve(node: any): any {
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    return resolve(node.$ref.replace(/^#\//, '').split('/').reduce((acc: any, part: string) => acc?.[part], spec));
  }
  return node;
}

// One Ajv holding the spec's components under the id "oas", so any schema can $ref them.
const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
(addFormats as any)(ajv);
ajv.addSchema({ $id: 'oas', components: spec.components });

/** Rewrites `#/components/...` references inside a schema taken from `paths` so they resolve against "oas". */
function anchored(schema: any): any {
  if (Array.isArray(schema)) return schema.map(anchored);
  if (schema && typeof schema === 'object') {
    return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, key === '$ref' && typeof value === 'string' && value.startsWith('#/') ? `oas${value}` : anchored(value)]));
  }
  return schema;
}

export function validator(schema: any) {
  return ajv.compile(anchored(schema));
}

export function schemaErrors(schema: any, value: unknown): string[] | null {
  const validate = validator(schema);
  return validate(value) ? null : (validate.errors ?? []).map((e: any) => `${e.instancePath || '(root)'} ${e.message}`);
}

/** Every route the app registered, as "METHOD /path/{param}" (HEAD and the catch-all are left out). */
export function registeredRoutes(app: FastifyInstance): string[] {
  const routes = new Set<string>();
  const stack: string[] = []; // the path accumulated at each depth
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const match = line.match(/^((?:│   |    )*)(?:├── |└── )(.+?) \(([A-Z, ]+)\)$/);
    if (!match) continue;
    const depth = match[1]!.length / 4;
    const label = match[2]!;
    stack.length = depth;
    stack[depth] = (depth === 0 ? '' : stack[depth - 1]!) + label;
    const path = stack[depth]!.replace(/:([A-Za-z]+)/g, '{$1}');
    if (path === '*' || path.endsWith('/*')) continue;
    for (const method of match[3]!.split(', ')) if (method !== 'HEAD') routes.add(`${method} ${path}`);
  }
  return [...routes].sort();
}

export const documentedOperations = (): string[] =>
  Object.entries<any>(spec.paths).flatMap(([path, item]) => methods.filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${path}`)).sort();

/**
 * Checks a real response against the spec: the status is one the operation documents, the headers it promises are present,
 * and the body matches the documented schema (or is empty when none is documented). Returns a list of problems.
 */
export function conformanceProblems(method: string, pathTemplate: string, res: { statusCode: number; headers: Record<string, any>; body: string }): string[] {
  const operation = spec.paths[pathTemplate]?.[method.toLowerCase()];
  if (!operation) return [`${method} ${pathTemplate} is not in the spec`];
  const documented = resolve(operation.responses[String(res.statusCode)]);
  if (!documented) return [`${method} ${pathTemplate}: status ${res.statusCode} is not documented (documented: ${Object.keys(operation.responses).join(', ')})`];

  const problems: string[] = [];
  for (const header of Object.keys(documented.headers ?? {})) {
    if (res.headers[header.toLowerCase()] === undefined) problems.push(`${method} ${pathTemplate} ${res.statusCode}: missing documented header ${header}`);
  }
  const contentType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim();
  if (!documented.content) {
    if (res.body) problems.push(`${method} ${pathTemplate} ${res.statusCode}: documented as having no body, got ${res.body.slice(0, 80)}`);
    return problems;
  }
  const schema = documented.content[contentType]?.schema;
  if (!schema) return [...problems, `${method} ${pathTemplate} ${res.statusCode}: content type "${contentType}" is not documented`];
  const body = contentType === 'application/json' ? JSON.parse(res.body) : res.body;
  const errors = schemaErrors(schema, body);
  if (errors) problems.push(`${method} ${pathTemplate} ${res.statusCode}: body does not match the schema: ${errors.join('; ')}`);
  return problems;
}
