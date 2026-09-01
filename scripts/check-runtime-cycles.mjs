#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const SCAN_ROOTS = ['packages', 'services', 'console'];
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '__fixtures__', '__tests__', 'coverage', 'dist', 'fixture', 'fixtures',
  'node_modules', 'test', 'test-fixtures', 'tests',
]);
const NON_PRODUCTION_BASENAME = /(?:^|[._-])(?:fixture|fixtures|spec|test|tests)(?:[._-]|$)/u;

function portablePath(path) {
  return path.split(sep).join('/');
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function isProductionSourceFile(path) {
  const normalized = portablePath(path);
  const parts = normalized.split('/');
  const basename = parts.at(-1) ?? '';
  if (!SOURCE_EXTENSIONS.includes(extname(basename))) return false;
  if (/\.d\.(?:ts|tsx)$/u.test(basename)) return false;
  if (parts.some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase()))) return false;
  return !NON_PRODUCTION_BASENAME.test(basename.toLowerCase());
}

function scriptKind(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function moduleText(node) {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function importHasRuntimeBinding(node) {
  const clause = node.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
  if (bindings.elements.length === 0) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function exportHasRuntimeBinding(node) {
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return true;
  if (clause.elements.length === 0) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
}

function callModuleSpecifier(node) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return undefined;
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
  if (!isDynamicImport && !isRequire) return undefined;
  return moduleText(node.arguments[0]);
}

export function collectRuntimeModuleSpecifiers(sourceText, fileName = 'source.ts') {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const diagnostics = source.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const detail = ts.flattenDiagnosticMessageText(diagnostics[0].messageText, ' ');
    throw new Error(`cannot parse ${fileName}: ${detail}`);
  }
  const specifiers = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && importHasRuntimeBinding(node)) {
      const specifier = moduleText(node.moduleSpecifier);
      if (specifier !== undefined) specifiers.add(specifier);
    } else if (ts.isExportDeclaration(node) && exportHasRuntimeBinding(node)) {
      const specifier = moduleText(node.moduleSpecifier);
      if (specifier !== undefined) specifiers.add(specifier);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = moduleText(node.moduleReference.expression);
      if (specifier !== undefined) specifiers.add(specifier);
    } else {
      const specifier = callModuleSpecifier(node);
      if (specifier !== undefined) specifiers.add(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...specifiers].sort();
}

function scanDirectory(directory, output) {
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    if (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scanDirectory(path, output);
    else if (entry.isFile() && isProductionSourceFile(path)) output.push(resolve(path));
  }
}

export function collectProductionSourceFiles(rootDirectory, scanRoots = SCAN_ROOTS) {
  const files = [];
  for (const root of [...scanRoots].sort()) {
    const directory = resolve(rootDirectory, root);
    if (existsSync(directory)) scanDirectory(directory, files);
  }
  return files.sort();
}

function resolutionCandidates(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const extension = extname(base);
  if (SOURCE_EXTENSIONS.includes(extension)) {
    const candidates = [base];
    if (extension === '.js' || extension === '.jsx') {
      const stem = base.slice(0, -extension.length);
      candidates.push(`${stem}.ts`, `${stem}.tsx`);
    }
    return candidates;
  }
  return [
    ...SOURCE_EXTENSIONS.map((sourceExtension) => `${base}${sourceExtension}`),
    ...SOURCE_EXTENSIONS.map((sourceExtension) => join(base, `index${sourceExtension}`)),
  ];
}

export function resolveRelativeModule(fromFile, specifier, knownFiles) {
  if (!specifier.startsWith('.')) return undefined;
  for (const candidate of resolutionCandidates(fromFile, specifier)) {
    const absolute = resolve(candidate);
    if (knownFiles.has(absolute)) return absolute;
  }
  return undefined;
}

function workspacePackageEntries(rootDirectory, scanRoots, knownFiles) {
  const entries = new Map();
  const candidates = [];
  for (const scanRoot of scanRoots) {
    const directory = resolve(rootDirectory, scanRoot);
    if (!existsSync(directory)) continue;
    candidates.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(directory, entry.name));
    }
  }
  for (const directory of candidates.sort(compareText)) {
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) continue;
    const sourceEntry = SOURCE_EXTENSIONS
      .map((extension) => resolve(directory, `src/index${extension}`))
      .find((candidate) => knownFiles.has(candidate));
    if (sourceEntry === undefined) continue;
    if (entries.has(manifest.name)) {
      throw new Error(`duplicate workspace package name: ${manifest.name}`);
    }
    entries.set(manifest.name, sourceEntry);
  }
  return entries;
}

export function buildRuntimeDependencyGraph({ rootDirectory, scanRoots = SCAN_ROOTS }) {
  const absoluteRoot = resolve(rootDirectory);
  const files = collectProductionSourceFiles(absoluteRoot, scanRoots);
  const knownFiles = new Set(files);
  const workspaceEntries = workspacePackageEntries(absoluteRoot, scanRoots, knownFiles);
  const graph = new Map();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const dependencies = new Set();
    for (const specifier of collectRuntimeModuleSpecifiers(source, file)) {
      const target = resolveRelativeModule(file, specifier, knownFiles)
        ?? workspaceEntries.get(specifier);
      if (target !== undefined) dependencies.add(portablePath(relative(absoluteRoot, target)));
    }
    graph.set(portablePath(relative(absoluteRoot, file)), dependencies);
  }
  return graph;
}

export function findStronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  const connect = (node) => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of [...(graph.get(node) ?? [])].sort()) {
      if (!indices.has(target)) {
        connect(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component.sort());
  };

  for (const node of [...graph.keys()].sort()) if (!indices.has(node)) connect(node);
  return components.sort((left, right) => compareText(left[0], right[0]));
}

function representativeCycle(graph, component) {
  const members = new Set(component);
  const start = component[0];
  const path = [start];
  const visited = new Set([start]);
  const search = (node) => {
    for (const target of [...(graph.get(node) ?? [])].filter((entry) => members.has(entry)).sort()) {
      if (target === start) return [...path, start];
      if (visited.has(target)) continue;
      visited.add(target);
      path.push(target);
      const cycle = search(target);
      if (cycle !== undefined) return cycle;
      path.pop();
      visited.delete(target);
    }
    return undefined;
  };
  return search(start) ?? [...component, start];
}

export function findRuntimeCycles(graph) {
  return findStronglyConnectedComponents(graph)
    .filter((component) => component.length > 1 || graph.get(component[0])?.has(component[0]))
    .map((members) => ({ members, path: representativeCycle(graph, members) }));
}

export function formatRuntimeCycles(cycles) {
  return cycles.map((cycle, index) => [
    `  ${index + 1}. ${cycle.path.join(' -> ')}`,
    `     SCC (${cycle.members.length}): ${cycle.members.join(', ')}`,
  ].join('\n')).join('\n');
}

export function runRuntimeCycleCheck({
  rootDirectory = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const graph = buildRuntimeDependencyGraph({ rootDirectory });
  const cycles = findRuntimeCycles(graph);
  const edgeCount = [...graph.values()].reduce((total, dependencies) => total + dependencies.size, 0);
  if (cycles.length === 0) {
    stdout.write(`runtime-cycles: VERDE (${graph.size} archivos, ${edgeCount} dependencias, 0 ciclos)\n`);
    return 0;
  }
  stderr.write(`runtime-cycles: ROJO (${cycles.length} ciclos, ${graph.size} archivos)\n`);
  stderr.write(`${formatRuntimeCycles(cycles)}\n`);
  return 1;
}

function isDirectExecution() {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && pathToFileURL(resolve(entryPoint)).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    process.exitCode = runRuntimeCycleCheck();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`runtime-cycles: ERROR: ${detail}\n`);
    process.exitCode = 2;
  }
}
