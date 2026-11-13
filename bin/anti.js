#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  'anti' CLI wrapper – supports: anti gravity proxy <command>
// ─────────────────────────────────────────────────────────────
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rawArgs = process.argv.slice(2);

// Check for "gravity proxy <command>" pattern
if (rawArgs[0]?.toLowerCase() === 'gravity') {
  if (rawArgs[1]?.toLowerCase() === 'proxy') {
    // anti gravity proxy <command> ...
    process.argv = [process.argv[0], process.argv[1], ...rawArgs.slice(2)];
  } else {
    // anti gravity <command> ...
    process.argv = [process.argv[0], process.argv[1], ...rawArgs.slice(1)];
  }
} else if (rawArgs[0]?.toLowerCase() === 'proxy') {
  // anti proxy <command> ...
  process.argv = [process.argv[0], process.argv[1], ...rawArgs.slice(1)];
}

// Forward to cli.js using valid file URL
await import(pathToFileURL(path.join(__dirname, 'cli.js')).href);
