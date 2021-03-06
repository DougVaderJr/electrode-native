import {
  childProcess,
  manifest,
  iosUtil,
  injectReactNativeVersionKeysInObject,
  utils,
  PackagePath,
  shell,
  log,
  NativePlatform,
  kax,
  PluginConfig,
  readPackageJson,
  writePackageJson,
  yarn,
} from 'ern-core'
import {
  ContainerGenerator,
  ContainerGeneratorConfig,
  ContainerGenResult,
  generatePluginsMustacheViews,
  populateApiImplMustacheView,
  generateContainer,
} from 'ern-container-gen'

import fs from 'fs-extra'
import path from 'path'
import xcode from 'xcode-ern'
import _ from 'lodash'
import readDir from 'fs-readdir-recursive'
import { Composite } from 'ern-composite-gen'
import semver from 'semver'

const ROOT_DIR = process.cwd()
const PATH_TO_HULL_DIR = path.join(__dirname, 'hull')

export default class IosGenerator implements ContainerGenerator {
  get name(): string {
    return 'IosGenerator'
  }

  get platform(): NativePlatform {
    return 'ios'
  }

  public async generate(
    config: ContainerGeneratorConfig
  ): Promise<ContainerGenResult> {
    return generateContainer(config, {
      fillContainerHull: this.fillContainerHull.bind(this),
      postCopyRnpmAssets: this.addResources.bind(this),
    })
  }

  public async addResources(config: ContainerGeneratorConfig) {
    const containerProjectPath = path.join(
      config.outDir,
      'ElectrodeContainer.xcodeproj',
      'project.pbxproj'
    )
    const containerIosProject = await this.getIosContainerProject(
      containerProjectPath
    )

    const containerResourcesPath = path.join(
      config.outDir,
      'ElectrodeContainer',
      'Resources'
    )
    const resourceFiles = readDir(containerResourcesPath)
    resourceFiles.forEach(resourceFile => {
      containerIosProject.addResourceFile(
        path.join('Resources', resourceFile),
        null,
        containerIosProject.findPBXGroupKey({ name: 'Resources' })
      )
    })

    fs.writeFileSync(containerProjectPath, containerIosProject.writeSync())
  }

  public async fillContainerHull(
    config: ContainerGeneratorConfig
  ): Promise<void> {
    const pathSpec = {
      outputDir: config.outDir,
      projectHullDir: path.join(PATH_TO_HULL_DIR, '{.*,*}'),
      rootDir: ROOT_DIR,
    }

    const projectSpec = {
      projectName: 'ElectrodeContainer',
    }

    const reactNativePlugin = _.find(
      config.plugins,
      p => p.name === 'react-native'
    )
    if (!reactNativePlugin) {
      throw new Error('react-native was not found in plugins list !')
    }
    if (!reactNativePlugin.version) {
      throw new Error('react-native plugin does not have a version !')
    }

    const mustacheView: any = {}
    mustacheView.jsMainModuleName = config.jsMainModuleName || 'index'
    injectReactNativeVersionKeysInObject(
      mustacheView,
      reactNativePlugin.version
    )

    await kax
      .task('Preparing Native Dependencies Injection')
      .run(this.buildiOSPluginsViews(config.plugins, mustacheView))

    await kax
      .task('Preparing API Implementations Injection')
      .run(
        this.buildApiImplPluginViews(
          config.plugins,
          config.composite,
          mustacheView,
          projectSpec
        )
      )
    const { iosProject, projectPath } = await iosUtil.fillProjectHull(
      pathSpec,
      projectSpec,
      config.plugins,
      mustacheView,
      config.composite
    )

    await kax
      .task('Adding Native Dependencies Hooks')
      .run(
        this.addiOSPluginHookClasses(iosProject, config.plugins, config.outDir)
      )

    fs.writeFileSync(projectPath, iosProject.writeSync())

    if (semver.gte(reactNativePlugin.version!, '0.61.0')) {
      //
      // Add all native dependencies to package.json dependencies so that
      // !use_native_modules can detect them to add their pod to the Podfile
      const dependencies = await config.composite.getNativeDependencies({})
      const resDependencies = [
        ...dependencies.thirdPartyInManifest,
        ...dependencies.thirdPartyNotInManifest,
      ]
      const addDependencies: any = {}
      resDependencies.forEach(p => {
        addDependencies[p.name!] = p.version
      })

      //
      // Create package.json in container directory root
      // so that native modules pods can be resolved
      // by use_native_modules! RN ruby script
      const pjsonObj = {
        dependencies: addDependencies,
        name: 'container',
      }
      await writePackageJson(config.outDir, pjsonObj)

      //
      // Copy all native dependencies from composite node_modules
      // to container node_modules so that pods can be found local
      // to the container directory
      const containerNodeModulesPath = path.join(config.outDir, 'node_modules')
      shell.mkdir('-p', containerNodeModulesPath)
      resDependencies.forEach(p => {
        shell.cp('-rf', p.basePath!, containerNodeModulesPath)
      })
      // Add @react-native-community/cli-platform-ios because
      // it contains the scripts needed for native modules pods linking
      // look in composite to match proper version
      const compositeNodeModulesPath = path.join(
        config.composite.path,
        'node_modules'
      )
      const cliPlatformIosPkg = '@react-native-community/cli-platform-ios'
      const cliPlatformIosPkgVersion = (
        await readPackageJson(
          path.join(compositeNodeModulesPath, cliPlatformIosPkg)
        )
      ).version
      shell.pushd(config.outDir)
      try {
        await yarn.add(
          PackagePath.fromString(
            `${cliPlatformIosPkg}@${cliPlatformIosPkgVersion}`
          )
        )
      } finally {
        shell.popd()
      }

      //
      // Run pod install
      shell.pushd(config.outDir)
      try {
        await kax
          .task('Running pod install')
          .run(childProcess.spawnp('pod', ['install']))
      } finally {
        shell.popd()
      }

      //
      // Clean node_modules by only keeping the directories that are
      // needed for proper container build.
      shell.pushd(config.outDir)
      try {
        //
        // Look in the Pods pbxproj for any references to some files
        // kepts in some node_module subdirectory (basically react-native
        // as well as all native modules)
        const f = fs.readFileSync('Pods/Pods.xcodeproj/project.pbxproj', {
          encoding: 'utf8',
        })

        //
        // Build an array of these directories
        const re = RegExp('"../node_modules/([^"]+)"', 'g')
        const matches = []
        let match = re.exec(f)
        while (match !== null) {
          matches.push(match[1])
          match = re.exec(f)
        }
        const res = matches
          .map(r => r.split('/'))
          .filter(x => x[0] !== 'react-native')
          .map(x => x.join('/'))
          .concat('react-native')

        //
        // Copy all retained directories from 'node_modules'
        // to a new directory 'node_modules_light'
        const nodeModulesLightDir = 'node_modules_light'
        const nodeModulesDir = 'node_modules'
        shell.mkdir('-p', nodeModulesLightDir)
        for (const b of res) {
          shell.mkdir('-p', path.join(nodeModulesLightDir, b))
          shell.cp(
            '-Rf',
            path.join(nodeModulesDir, b, '{.*,*}'),
            path.join(nodeModulesLightDir, b)
          )
        }
        //
        // Replace the huge 'node_modules' directory with the skimmed one
        shell.rm('-rf', nodeModulesDir)
        shell.mv(nodeModulesLightDir, nodeModulesDir)
        //
        // Finally get rid of all android directories to further reduce
        // overall 'node_modules' directory size, as they are not needed
        // for iOS container builds.
        shell.rm('-rf', path.join(nodeModulesDir, '**/android'))
      } finally {
        shell.popd()
      }
    }
  }

  // Code to keep backward compatibility
  public switchToOldDirectoryStructure(
    pluginSourcePath: string,
    tail: string
  ): boolean {
    // This is to check if the api referenced during container generation is created using the old or new directory structure to help keep the backward compatibility.
    const pathToSwaggersAPIs = path.join(
      'IOS',
      'IOS',
      'Classes',
      'SwaggersAPIs'
    )
    if (
      path.dirname(tail) === 'IOS' &&
      fs.pathExistsSync(
        path.join(pluginSourcePath, path.dirname(pathToSwaggersAPIs))
      )
    ) {
      return true
    }
    return false
  }

  public async buildiOSPluginsViews(
    plugins: PackagePath[],
    mustacheView: any
  ): Promise<any> {
    mustacheView.plugins = await generatePluginsMustacheViews(plugins, 'ios')
  }

  public async addiOSPluginHookClasses(
    containerIosProject: any,
    plugins: PackagePath[],
    outDir: string
  ): Promise<any> {
    for (const plugin of plugins) {
      if (plugin.name === 'react-native') {
        continue
      }
      const pluginConfig:
        | PluginConfig<'ios'>
        | undefined = await manifest.getPluginConfig(plugin, 'ios')
      if (!pluginConfig) {
        log.warn(
          `${plugin.name} does not have any injection configuration for ios platform`
        )
        continue
      }

      const { pluginHook } = pluginConfig!

      if (pluginHook?.name) {
        if (!pluginConfig.path) {
          throw new Error('No plugin config path was set. Cannot proceed.')
        }

        const pluginConfigPath = pluginConfig.path
        const pathToCopyPluginHooksTo = path.join(outDir, 'ElectrodeContainer')

        log.debug(`Adding ${pluginHook.name}.h`)
        const pathToPluginHookHeader = path.join(
          pluginConfigPath,
          `${pluginHook.name}.h`
        )
        shell.cp(pathToPluginHookHeader, pathToCopyPluginHooksTo)
        containerIosProject.addHeaderFile(
          `${pluginHook.name}.h`,
          { public: true },
          containerIosProject.findPBXGroupKey({ name: 'ElectrodeContainer' })
        )

        log.debug(`Adding ${pluginHook.name}.m`)
        const pathToPluginHookSource = path.join(
          pluginConfigPath,
          `${pluginHook.name}.m`
        )
        shell.cp(pathToPluginHookSource, pathToCopyPluginHooksTo)
        containerIosProject.addSourceFile(
          `${pluginHook.name}.m`,
          null,
          containerIosProject.findPBXGroupKey({ name: 'ElectrodeContainer' })
        )
      }
    }
  }

  public async getIosContainerProject(
    containerProjectPath: string
  ): Promise<any> {
    const containerProject = xcode.project(containerProjectPath)
    return new Promise((resolve, reject) => {
      containerProject.parse((err: any) => {
        if (err) {
          reject(err)
        }
        resolve(containerProject)
      })
    })
  }

  public async buildApiImplPluginViews(
    plugins: PackagePath[],
    composite: Composite,
    mustacheView: any,
    projectSpec: any
  ) {
    for (const plugin of plugins) {
      const pluginConfig = await manifest.getPluginConfig(
        plugin,
        'ios',
        projectSpec.projectName
      )
      if (!pluginConfig) {
        continue
      }

      if (await utils.isDependencyPathNativeApiImpl(plugin.basePath)) {
        populateApiImplMustacheView(plugin.basePath, mustacheView, true)
      }
    }

    if (mustacheView.apiImplementations) {
      mustacheView.hasApiImpl = true
      for (const api of mustacheView.apiImplementations) {
        if (api.hasConfig) {
          mustacheView.hasAtleastOneApiImplConfig = true
          break
        }
      }
    }
  }
}
