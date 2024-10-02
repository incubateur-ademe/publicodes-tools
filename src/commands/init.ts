import fs from 'fs'
import path from 'path'
import { execSync } from 'node:child_process'
import { Command, Flags } from '@oclif/core'
import * as p from '@clack/prompts'
import chalk from 'chalk'

import {
  exitWithError,
  runAsyncWithSpinner,
  runWithSpinner,
  Spinner,
} from '../utils/cli'
import { basePackageJson, getPackageJson, PackageJson } from '../utils/pjson'
import { OptionFlag } from '@oclif/core/lib/interfaces'
import { spawn } from 'child_process'

type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun'

export default class Init extends Command {
  static override args = {}

  static override summary = 'Initialize a new project.'

  static override description = `
If no package.json file is found in the current directory, this command will
create one and install the necessary dependencies with the specified package
manager. Otherwise, it will update the existing package.json file.
`

  static override examples = [
    {
      command: '<%= config.bin %> <%= command.id %>',
      description: 'Initialize a new project.',
    },
    {
      command: '<%= config.bin %> <%= command.id %> -p yarn',
      description: 'Initialize a new project with Yarn.',
    },
  ]

  static override flags = {
    'pkg-manager': Flags.string({
      char: 'p',
      summary: 'The package manager to use.',
      description: `The package manager that will be used to install dependencies. If not provided,
the command will try to detect the package manager based on the lock files
present in the project directory, otherwise it will prompt the user to choose
one.
`,
      options: ['npm', 'yarn', 'pnpm', 'bun'],
    }) as OptionFlag<PackageManager | undefined>,
    'no-install': Flags.boolean({
      char: 'n',
      summary: 'Skip the installation of dependencies.',
      description: `By default, the commmand will try to install the dependencies using the
specified package manager (or the detected one). Use this flag to skip the
installation.`,
    }),
    install: Flags.boolean({
      char: 'i',
      summary: 'Install dependencies.',
      hidden: true,
    }),
  }

  public async run(): Promise<void> {
    p.intro(chalk.bgHex('#2975d1')(' publicodes init '))

    const { flags } = await this.parse(Init)
    let pkgJSON = getPackageJson()

    if (pkgJSON) {
      p.log.info(`Updating existing ${chalk.bold('package.json')} file`)
      this.updatePackageJson(pkgJSON)
    } else {
      p.log.step(`Creating a new ${chalk.bold('package.json')} file`)
      pkgJSON = await askPackageJsonInfo()
      this.updatePackageJson(pkgJSON)
    }

    const pkgManager: PackageManager =
      flags['pkg-manager'] ??
      findPackageManager() ??
      (await askPackageManager())

    const shouldInstall =
      flags.install ||
      (flags['no-install'] === undefined
        ? await p.confirm({
            message: 'Do you want to install the dependencies?',
          })
        : !flags['no-install'])

    if (shouldInstall) {
      await installDeps(pkgManager)
    }

    await generateBaseFiles(pkgJSON, pkgManager)

    p.note(
      `${chalk.bold('You can now:')}
- write your Publicodes rules in ${chalk.bold.yellow('.src/')}
- compile them using: ${chalk.bold.yellow(`${pkgManager} run compile`)}`,
      chalk.bold('Publicodes is ready to use 🚀'),
    )

    p.outro(
      `New to Publicodes? Learn more at ${chalk.underline.cyan('https://publi.codes/docs')}`,
    )
  }

  private updatePackageJson(pkgJSON: PackageJson): void {
    const packageJsonPath = path.join(process.cwd(), 'package.json')

    pkgJSON.type = basePackageJson.type
    pkgJSON.main = basePackageJson.main
    pkgJSON.types = basePackageJson.types
    pkgJSON.license = pkgJSON.license ?? basePackageJson.license
    pkgJSON.version = pkgJSON.version ?? basePackageJson.version
    pkgJSON.description = pkgJSON.description ?? basePackageJson.description
    pkgJSON.author = pkgJSON.author ?? basePackageJson.author
    pkgJSON.files = basePackageJson.files!.concat(pkgJSON.files ?? [])
    pkgJSON.peerDependencies = {
      ...pkgJSON.peerDependencies,
      ...basePackageJson.peerDependencies,
    }
    pkgJSON.devDependencies = {
      ...pkgJSON.devDependencies,
      '@publicodes/tools': `^${this.config.pjson.version}`,
    }
    pkgJSON.scripts = {
      ...pkgJSON.scripts,
      ...basePackageJson.scripts,
    }
    if (pkgJSON.name.startsWith('@')) {
      pkgJSON.publishConfig = { access: 'public' }
    }

    try {
      fs.writeFileSync(packageJsonPath, JSON.stringify(pkgJSON, null, 2))
      p.log.step(`${chalk.bold('package.json')} file written`)
    } catch (error) {
      exitWithError({
        ctx: `An error occurred while writing the ${chalk.bold('package.json')} file`,
        msg: error.message,
      })
    }
  }
}

function askPackageJsonInfo(): Promise<PackageJson> {
  const currentDir = path.basename(process.cwd())

  return p.group(
    {
      name: () =>
        p.text({
          message: 'Name',
          defaultValue: currentDir,
          placeholder: currentDir,
        }),
      description: () => p.text({ message: 'Description', defaultValue: '' }),
      version: () =>
        p.text({
          message: 'Version',
          defaultValue: '0.1.0',
          placeholder: '0.1.0',
        }),
      author: () => p.text({ message: 'Author', defaultValue: '' }),
      license: () =>
        p.text({
          message: 'License',
          defaultValue: 'MIT',
          placeholder: 'MIT',
        }),
    },
    {
      onCancel: () => {
        p.cancel('init cancelled')
        process.exit(1)
      },
    },
  )
}

function findPackageManager(): PackageManager | undefined {
  if (fs.existsSync('yarn.lock')) {
    return 'yarn'
  }
  if (fs.existsSync('pnpm-lock.yaml')) {
    return 'pnpm'
  }
  if (fs.existsSync('bun.lock')) {
    return 'bun'
  }
  if (fs.existsSync('package-lock.json')) {
    return 'npm'
  }
}

function askPackageManager(): Promise<PackageManager> {
  const checkIfInstalled = (cmd: string): boolean => {
    try {
      execSync(`${cmd} -v`, { stdio: 'ignore' })
      return true
    } catch (error) {
      return false
    }
  }
  return p.select<any, PackageManager>({
    message: 'Choose a package manager',
    options: ['npm', 'yarn', 'pnpm', 'bun']
      .filter((pm) => checkIfInstalled(pm))
      .map((pm) => ({ value: pm, label: pm })),
  }) as Promise<PackageManager>
}

async function installDeps(pkgManager: PackageManager): Promise<void> {
  return runAsyncWithSpinner(
    'Installing dependencies',
    'Dependencies installed',
    (spinner: Spinner) => {
      return new Promise<void>((resolve) => {
        const program = spawn(pkgManager, ['install', '-y'], {
          stdio: 'ignore',
        })

        program.on('error', (error) => {
          exitWithError({
            ctx: 'An error occurred while installing dependencies',
            msg: error.message,
            spinner,
          })
        })

        program.on('close', (code) => {
          if (code !== 0) {
            exitWithError({
              ctx: `An error occurred while installing dependencies (exec: ${pkgManager} install -y)`,
              msg: `Process exited with code ${code}`,
              spinner,
            })
          }
          resolve()
        })
      })
    },
  )
}

async function generateBaseFiles(
  pjson: PackageJson,
  pkgManager: PackageManager,
): Promise<void> {
  return runWithSpinner('Generating files', 'Files generated', (spinner) => {
    try {
      // Generate README.md
      if (!fs.existsSync('README.md')) {
        fs.writeFileSync('README.md', getReadmeContent(pjson, pkgManager))
      }

      // Generate src directory with a base.publicodes file as an example
      if (!fs.existsSync('src')) {
        fs.mkdirSync('src')
      }
      if (!fs.existsSync('src/base.publicodes')) {
        fs.writeFileSync('src/base.publicodes', BASE_PUBLICODES)
      }
    } catch (error) {
      exitWithError({
        ctx: 'An error occurred while generating files',
        msg: error.message,
        spinner,
      })
    }
  })
}

function getReadmeContent(
  pjson: PackageJson,
  pkgManager: PackageManager,
): string {
  return `# ${pjson.name}

${pjson.description}

## Installation

\`\`\`sh
npm install ${pjson.name} publicodes
\`\`\`

## Usage

\`\`\`typescript
import { Engine } from 'publicodes'
import rules from '${pjson.name}'

const engine = new Engine(rules)

console.log(engine.evaluate('salaire net').nodeValue)
// 1957.5

engine.setSituation({ 'salaire brut': 4000 })
console.log(engine.evaluate('salaire net').nodeValue)
// 3120
\`\`\`

## Development

\`\`\`sh
// Install the dependencies
${pkgManager} install

// Compile the Publicodes rules
${pkgManager} run compile

// Run the documentation server
${pkgManager} run doc
\`\`\`
`
}

const BASE_PUBLICODES = `# Règles d'exemples automatiquement générées
# Supprimez ce fichier ou ajoutez vos propres règles

salaire net: salaire brut - cotisations salariales

salaire brut:
  titre: Salaire brut mensuel
  par défaut: 2500 €/mois

cotisations salariales:
  produit:
    - salaire brut
    - taux
  avec:
    taux: 21.7%
`
