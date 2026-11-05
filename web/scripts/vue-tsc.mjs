#!/usr/bin/env node
// vue-tsc resolves `typescript/lib/tsc` from its own (hoisted) location. In this
// workspace that is the root TypeScript 7 package, which no longer exports the
// compiler subpath. Resolve the web workspace's pinned TypeScript 5.9 compiler
// explicitly and turn off peer auto-resolution ambiguity for the root toolchain.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRequire = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))
const tscPath = webRequire.resolve('typescript/lib/tsc')
const vueTsc = webRequire('vue-tsc')
vueTsc.run(tscPath)
