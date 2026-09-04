import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run this check through npm run check:package')
const temp = mkdtempSync(join(tmpdir(), 'gptimg-package-smoke-'))

function runNpm(args, options) {
  return execFileSync(process.execPath, [npmCli, ...args], options)
}

try {
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  const packResult = JSON.parse(runNpm(
    ['pack', '--json', '--pack-destination', temp],
    { cwd: repo, encoding: 'utf8' },
  ))
  const packed = packResult?.[manifest.name]
  if (typeof packed?.filename !== 'string') throw new Error('npm pack did not report a tarball filename')
  const tarball = join(temp, packed.filename)
  const consumer = join(temp, 'consumer')

  mkdirSync(consumer)
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  runNpm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', consumer, tarball],
    { cwd: temp, stdio: 'inherit' },
  )

  const smoke = join(consumer, 'smoke.ts')
  writeFileSync(smoke, [
    'import { GptImg, VERSION } from "gptimg"',
    'if (typeof GptImg !== "function") throw new Error("GptImg is not exported")',
    `if (VERSION !== ${JSON.stringify(manifest.version)}) throw new Error(\`Unexpected VERSION \${VERSION}\`)`,
    'console.log(`Imported gptimg ${VERSION}`)',
  ].join('\n'))

  execFileSync(
    process.execPath,
    [join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), smoke],
    { cwd: consumer, stdio: 'inherit' },
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}
