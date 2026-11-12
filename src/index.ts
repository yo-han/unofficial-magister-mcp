import { existsSync } from 'node:fs';
import { run } from './cli.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const code = await run(process.argv.slice(2));
if (code !== null) process.exitCode = code;
