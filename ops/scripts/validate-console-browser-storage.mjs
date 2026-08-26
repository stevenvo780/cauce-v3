#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) {
  console.error('usage: validate-console-browser-storage.mjs /absolute/console/src');
  process.exit(2);
}

// Console publish recovery is server-side. These APIs can silently recreate a durable browser
// journal containing identity, message semantics or idempotency material. Cookies are transported
// automatically by the BFF; direct document.cookie access is forbidden separately below.
const forbiddenNames = new Set([
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'CacheStorage',
  'IDBFactory',
  'IDBDatabase',
  'IDBTransaction',
  'IDBObjectStore',
  'IDBRequest',
  'IDBOpenDBRequest',
  'IDBKeyRange',
]);
const failures = new Map();

const canonicalRoots = new Set(['document', 'globalThis', 'navigator', 'window']);

function unwrappedExpression(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  return current;
}

function canonicalExpression(node, aliases) {
  const current = unwrappedExpression(node);
  if (ts.isIdentifier(current)) {
    return aliases.get(current.text)
      ?? (canonicalRoots.has(current.text) ? current.text : undefined);
  }
  if (ts.isPropertyAccessExpression(current)) {
    const owner = canonicalExpression(current.expression, aliases);
    return owner === undefined ? undefined : `${owner}.${current.name.text}`;
  }
  if (ts.isElementAccessExpression(current)
    && current.argumentExpression !== undefined
    && ts.isStringLiteralLike(current.argumentExpression)) {
    const owner = canonicalExpression(current.expression, aliases);
    return owner === undefined ? undefined : `${owner}.${current.argumentExpression.text}`;
  }
  return undefined;
}

function forbiddenCanonical(canonical) {
  if (canonical === undefined) return undefined;
  const property = canonical.slice(canonical.lastIndexOf('.') + 1);
  if (forbiddenNames.has(property)) return property;
  if (canonical === 'document.cookie'
    || canonical === 'globalThis.document.cookie'
    || canonical === 'window.document.cookie') return 'document.cookie';
  if (canonical === 'navigator.storage.getDirectory'
    || canonical === 'globalThis.navigator.storage.getDirectory'
    || canonical === 'window.navigator.storage.getDirectory') {
    return 'origin-private-file-system';
  }
  return undefined;
}

function registerAlias(aliases, ambiguousAliases, name, canonical) {
  if (canonical === undefined || ambiguousAliases.has(name)) return;
  const previous = aliases.get(name);
  if (previous !== undefined && previous !== canonical) {
    aliases.delete(name);
    ambiguousAliases.add(name);
    return;
  }
  aliases.set(name, canonical);
}

function bindingPropertyName(element) {
  const property = element.propertyName;
  if (property === undefined && ts.isIdentifier(element.name)) return element.name.text;
  if (property !== undefined && (ts.isIdentifier(property) || ts.isStringLiteralLike(property))) {
    return property.text;
  }
  return undefined;
}

function registerBindingAliases(name, canonical, aliases, ambiguousAliases, rejected) {
  if (ts.isIdentifier(name)) {
    registerAlias(aliases, ambiguousAliases, name.text, canonical);
    return;
  }
  if (!ts.isObjectBindingPattern(name) || canonical === undefined) return;
  for (const element of name.elements) {
    if (element.dotDotDotToken !== undefined) continue;
    const property = bindingPropertyName(element);
    if (property === undefined) continue;
    const member = `${canonical}.${property}`;
    const forbidden = forbiddenCanonical(member);
    if (forbidden !== undefined) rejected.add(forbidden);
    registerBindingAliases(element.name, member, aliases, ambiguousAliases, rejected);
  }
}

function collectAliases(sourceFile, rejected) {
  const aliases = new Map();
  const ambiguousAliases = new Set();
  const declarations = [];
  const collect = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer !== undefined) {
      declarations.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  // Resolve chains independently from source order so a closure declared before its alias is still
  // checked. The small fixed point is bounded by the number of declarations in the source file.
  for (let pass = 0; pass <= declarations.length; pass += 1) {
    const sizeBefore = aliases.size;
    for (const declaration of declarations) {
      const canonical = canonicalExpression(declaration.initializer, aliases);
      registerBindingAliases(
        declaration.name, canonical, aliases, ambiguousAliases, rejected,
      );
    }
    if (aliases.size === sizeBefore) break;
  }
  return aliases;
}

function forbiddenMember(node, aliases) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
  return forbiddenCanonical(canonicalExpression(node, aliases));
}

async function scanTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanTree(absolute);
      continue;
    }
    if (!entry.isFile() || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx'))) continue;
    const source = await readFile(absolute, 'utf8');
    const kind = entry.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, kind);
    const rejected = new Set();
    const aliases = collectAliases(sourceFile, rejected);
    const visit = (node) => {
      if (ts.isIdentifier(node) && forbiddenNames.has(node.text)) rejected.add(node.text);
      // A computed lookup must not bypass the identifier gate (`globalThis['indexedDB']`).
      if (ts.isStringLiteralLike(node) && forbiddenNames.has(node.text)) rejected.add(node.text);
      const member = forbiddenMember(node, aliases);
      if (member !== undefined) rejected.add(member);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (rejected.size > 0) failures.set(path.relative(root, absolute), [...rejected].sort());
  }
}

await scanTree(root);
if (failures.size > 0) {
  for (const [file, APIs] of [...failures].sort(([left], [right]) => left.localeCompare(right))) {
    console.error(`browser durable storage usage is forbidden: ${file} (${APIs.join(', ')})`);
  }
  process.exit(1);
}
console.log('browser durable storage policy passed');
