import {
  yarn,
  spin,
  Dependency,
  Utils
} from '@walmart/ern-util'
import shell from 'shelljs'
import _ from 'lodash'
import chalk from 'chalk'

const {yarnAdd, yarnInfo} = yarn
let plugins: Array<Dependency>

export default class ApiImplGen {
  async generateApiImplementation (api: string, // npm package || git location || file path file:/Users/x/y/z
                                   paths: Object,
                                   platforms: Array<string>) {
    console.log(`inside generateApiImplementation for api:${api},  platforms:${platforms}`)

    await this.downloadApiAndDependencies(api, paths.pluginsDownloadFolder)

    log.info(chalk.green(`Done!.`))
  }

  async downloadApiAndDependencies (api: string, path) {
    try {
      shell.cd(path)
      Utils.throwIfShellCommandFailed()
      await this.spinAndDownload(api)
      plugins = await this.getDependencies(api)
      if (plugins) {
        console.log('Downloading dependencies')
        for (let dependency of plugins) {
          await this.spinAndDownload(dependency)
        }
      }
    } catch (e) {
      Utils.logErrorAndExitProcess(`Error while downloading API: ${e}`)
    }
  }

  async spinAndDownload (dependency: string | Dependency) {
    await spin(`Downloading ${dependency}`, yarnAdd(dependency))
  }

  async getDependencies (api: string): Array<Dependency> {
    try {
      console.log(`Looking for peerDependencies`)
      return await yarnInfo(api, {json: true}).then((result: Object) => {
        if (result.data.peerDependencies) {
          let pluginsNames = []
          for (let dependency in result.data.peerDependencies) {
            pluginsNames.push(`${dependency}@${result.data.peerDependencies[dependency]}`)
          }
          return _.map(pluginsNames, Dependency.fromString)
        } else {
          console.info('no peer dependencies found.')
        }
      })
    } catch (e) {
      Utils.logErrorAndExitProcess(`Error while downloading dependencies: ${e}`)
    }
  }
}
