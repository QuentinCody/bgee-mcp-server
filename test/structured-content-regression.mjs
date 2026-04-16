#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assertContains(filePath, haystack, needle, testName) {
  totalTests++;
  if (haystack.includes(needle)) {
    console.log(`${GREEN}✓${RESET} ${testName}`);
    passedTests++;
  } else {
    console.log(`${RED}✗${RESET} ${testName}`);
    console.log(`  Missing: ${needle}`);
    console.log(`  File: ${filePath}`);
    failedTests++;
  }
}

function readFile(relPath) {
  const absPath = path.resolve(SERVER_ROOT, relPath);
  return fs.readFileSync(absPath, 'utf8');
}

console.log(`${BLUE}🧪 Bgee Structured Content Regression Tests${RESET}`);

const codeMode = readFile('src/tools/code-mode.ts');
assertContains('src/tools/code-mode.ts', codeMode, 'createSparqlExecuteTool', 'code-mode.ts uses createSparqlExecuteTool');
assertContains('src/tools/code-mode.ts', codeMode, 'BGEE_SPARQL_ENDPOINT', 'code-mode.ts wires Bgee endpoint');
assertContains('src/tools/code-mode.ts', codeMode, 'createBgeeSparqlFetch', 'code-mode.ts uses Bgee SPARQL adapter');

const sparqlAdapter = readFile('src/lib/sparql.ts');
assertContains('src/lib/sparql.ts', sparqlAdapter, 'https://www.bgee.org/sparql/', 'sparql.ts hardcodes Bgee endpoint');
assertContains('src/lib/sparql.ts', sparqlAdapter, 'application/sparql-results+json', 'sparql.ts requests SPARQL JSON results');

const indexContent = readFile('src/index.ts');
assertContains('src/index.ts', indexContent, 'BgeeDataDO', 'index.ts exports BgeeDataDO');
assertContains('src/index.ts', indexContent, 'McpAgent', 'index.ts uses McpAgent');
assertContains('src/index.ts', indexContent, 'registerCodeMode', 'index.ts registers Code Mode SPARQL execute tool');

const doContent = readFile('src/do.ts');
assertContains('src/do.ts', doContent, 'extends RestStagingDO', 'do.ts extends RestStagingDO');
assertContains('src/do.ts', doContent, 'sparql_results', 'do.ts has SPARQL-aware schema hints');

console.log(`\n${BLUE}📊 Test Results Summary${RESET}`);
console.log(`Total tests: ${totalTests}`);
console.log(`${GREEN}Passed: ${passedTests}${RESET}`);
console.log(`${RED}Failed: ${failedTests}${RESET}`);

if (failedTests > 0) {
  console.log(`\n${RED}❌ Regression tests failed.${RESET}`);
  process.exit(1);
}

console.log(`\n${GREEN}✅ Bgee structured content regression tests passed.${RESET}`);
