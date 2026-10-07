import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { documentedOperations, methods, registeredRoutes, resolve, schemaErrors, spec, validator } from './openapi-helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fakeRedis: any = { on() {}, subscribe: async () => 1, unsubscribe: async () => 1, quit: async () => 'OK', removeAllListeners() {} };

describe('docs/openapi.yaml is well formed', () => {
  it('is OpenAPI 3.1 with the basics filled in', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(spec.servers.length).toBeGreaterThan(0);
  });

  it('gives every operation a unique id, a summary, a tag from the list and at least one response', () => {
    const tags = new Set(spec.tags.map((t: any) => t.name));
    const ids = new Set<string>();
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const method of methods.filter((m) => item[m])) {
        const op = item[method];
        const where = `${method.toUpperCase()} ${path}`;
        expect(op.operationId, where).toBeTruthy();
        expect(ids.has(op.operationId), `duplicate operationId ${op.operationId}`).toBe(false);
        ids.add(op.operationId);
        expect(op.summary, where).toBeTruthy();
        for (const tag of op.tags ?? []) expect(tags.has(tag), `${where}: unknown tag ${tag}`).toBe(true);
        expect(Object.keys(op.responses).length, where).toBeGreaterThan(0);
      }
    }
  });

  it('decides authentication for every operation: a key, or explicitly none', () => {
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const method of methods.filter((m) => item[m])) {
        const op = item[method];
        expect(op.security, `${method.toUpperCase()} ${path}`).toBeDefined();
        if (path.startsWith('/v1/')) expect(op.security, `${path} is under /v1`).toEqual([{ ApiKey: [] }]);
      }
    }
  });

  it('has every $ref pointing at something that exists', () => {
    const broken: string[] = [];
    const walk = (node: any, where: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
      if (!node || typeof node !== 'object') return;
      if (typeof node.$ref === 'string' && resolve(node) === undefined) broken.push(`${where}: ${node.$ref}`);
      for (const [key, value] of Object.entries(node)) walk(value, `${where}.${key}`);
    };
    walk(spec, 'spec');
    expect(broken).toEqual([]);
  });

  it('declares each path parameter that its path template uses', () => {
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      const used = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const method of methods.filter((m) => item[m])) {
        const declared = [...(item.parameters ?? []), ...(item[method].parameters ?? [])].map(resolve).filter((p: any) => p.in === 'path').map((p: any) => p.name);
        expect(declared.sort(), `${method.toUpperCase()} ${path}`).toEqual([...used].sort());
      }
    }
  });

  it('has component schemas that are valid JSON Schema', () => {
    for (const [name, schema] of Object.entries<any>(spec.components.schemas)) {
      expect(() => validator(schema), name).not.toThrow();
    }
  });

  it('accepts the examples it gives, and rejects what the API rejects', () => {
    const input = spec.components.schemas.NotificationInput;
    expect(schemaErrors(input, { externalUserId: 'u', type: 't', payload: {} })).toBeNull();
    expect(schemaErrors(input, { userId: '00000000-0000-4000-8000-000000000001', type: 't', payload: {}, channels: ['in_app'] })).toBeNull();
    expect(schemaErrors(input, { type: 't', payload: {} })).not.toBeNull(); // neither id
    expect(schemaErrors(input, { userId: '00000000-0000-4000-8000-000000000001', externalUserId: 'u', type: 't', payload: {} })).not.toBeNull(); // both ids
    expect(schemaErrors(input, { externalUserId: 'u', type: 't', payload: {}, tenantId: 'x' })).not.toBeNull(); // unknown field
    expect(schemaErrors(input, { externalUserId: 'u', type: 't', payload: {}, channels: ['sms'] })).not.toBeNull();
    for (const operation of ['createNotification', 'setPreferences']) {
      const found = Object.values<any>(spec.paths).flatMap((item) => methods.map((m) => item[m])).find((op) => op?.operationId === operation);
      for (const example of Object.values<any>(found.requestBody.content['application/json'].examples ?? {})) {
        expect(schemaErrors(found.requestBody.content['application/json'].schema, example.value), `${operation} example`).toBeNull();
      }
    }
  });
});

describe('docs/openapi.yaml matches the routes the app registers', () => {
  const app = buildApp({} as never, { add: vi.fn() }, { stream: { secret: 's'.repeat(32), subscriber: fakeRedis } });
  // Served for people rather than programs: the bare URL redirect and the demo page.
  const undocumentedOnPurpose = new Set(['GET /', 'GET /demo']);

  it('documents every operation that exists', async () => {
    await app.ready();
    const registered = new Set(registeredRoutes(app));
    expect(registered.size, 'the route listing could not be read').toBeGreaterThan(15);
    const missing = documentedOperations().filter((op) => !registered.has(op));
    expect(missing, 'documented but not in the app').toEqual([]);
  });

  it('leaves no route undocumented', async () => {
    await app.ready();
    const documented = new Set(documentedOperations());
    const undocumented = registeredRoutes(app).filter((route) => !documented.has(route) && !undocumentedOnPurpose.has(route));
    expect(undocumented, 'in the app but not in the spec').toEqual([]);
    await app.close();
  });
});
