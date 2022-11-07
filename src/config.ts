import * as fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import * as core from '@actions/core'
import * as z from 'zod'
import {
  ConfigurationOptions,
  ConfigurationOptionsSchema,
  SeveritySchema,
  SCOPES
} from './schemas'
import {isSPDXValid, octokitClient} from './utils'

type licenseKey = 'allow-licenses' | 'deny-licenses'

function getOptionalBoolean(name: string): boolean | undefined {
  const value = core.getInput(name)
  return value.length > 0 ? core.getBooleanInput(name) : undefined
}

function getOptionalInput(name: string): string | undefined {
  const value = core.getInput(name)
  return value.length > 0 ? value : undefined
}

function parseList(list: string | undefined): string[] | undefined {
  if (list === undefined) {
    return list
  } else {
    return list.split(',').map(x => x.trim())
  }
}

function validateLicenses(
  key: licenseKey,
  licenses: string[] | undefined
): void {
  if (licenses === undefined) {
    return
  }
  const invalid_licenses = licenses.filter(license => !isSPDXValid(license))

  if (invalid_licenses.length > 0) {
    throw new Error(
      `Invalid license(s) in ${key}: ${invalid_licenses.join(', ')}`
    )
  }
}

export async function readConfig(): Promise<ConfigurationOptions> {
  const inlineConfig = readInlineConfig()

  const configFile = getOptionalInput('config-file')
  if (configFile !== undefined) {
    const externalConfig = await readConfigFile(configFile)
    console.log('externalConfig====', externalConfig)
    // TO DO check order of precedence
    return mergeConfigs(inlineConfig, externalConfig)
  }
  return inlineConfig
}

export function readInlineConfig(): ConfigurationOptions {
  const fail_on_severity = SeveritySchema.parse(
    getOptionalInput('fail-on-severity')
  )
  const fail_on_scopes = z
    .array(z.enum(SCOPES))
    .default(['runtime'])
    .parse(parseList(getOptionalInput('fail-on-scopes')))

  const allow_licenses = parseList(getOptionalInput('allow-licenses'))
  const deny_licenses = parseList(getOptionalInput('deny-licenses'))

  if (allow_licenses !== undefined && deny_licenses !== undefined) {
    throw new Error("Can't specify both allow_licenses and deny_licenses")
  }
  validateLicenses('allow-licenses', allow_licenses)
  validateLicenses('deny-licenses', deny_licenses)

  const allow_ghsas = parseList(getOptionalInput('allow-ghsas'))

  const license_check = z
    .boolean()
    .default(true)
    .parse(getOptionalBoolean('license-check'))
  const vulnerability_check = z
    .boolean()
    .default(true)
    .parse(getOptionalBoolean('vulnerability-check'))
  if (license_check === false && vulnerability_check === false) {
    throw new Error("Can't disable both license-check and vulnerability-check")
  }

  const base_ref = getOptionalInput('base-ref')
  const head_ref = getOptionalInput('head-ref')

  return {
    fail_on_severity,
    fail_on_scopes,
    allow_licenses,
    deny_licenses,
    allow_ghsas,
    license_check,
    vulnerability_check,
    base_ref,
    head_ref
  }
}

export async function readConfigFile(
  filePath: string
): Promise<ConfigurationOptions> {
  const format = new RegExp(
    '(?<owner>[^/]+)/(?<repo>[^/]+)/(?<path>[^@]+)@(?<ref>.*)'
  )
  let data: string

  const pieces = format.exec(filePath)
  try {
    if (pieces?.groups && pieces.length === 5) {
      data = await getRemoteConfig({
        owner: pieces.groups.owner,
        repo: pieces.groups.repo,
        path: pieces.groups.path,
        ref: pieces.groups.ref
      })
    } else {
      data = fs.readFileSync(path.resolve(filePath), 'utf-8')
    }
    return parseConfigFile(data)
  } catch (error) {
    core.debug(error as string)
    throw new Error('Unable to fetch config file')
  }
}

export function parseConfigFile(configData: string): ConfigurationOptions {
  try {
    const data = YAML.parse(configData)
    for (const key of Object.keys(data)) {
      if (key === 'allow-licenses' || key === 'deny-licenses') {
        validateLicenses(key, data[key])
      }
      // get rid of the ugly dashes from the actions conventions
      if (key.includes('-')) {
        data[key.replace(/-/g, '_')] = data[key]
        delete data[key]
      }
    }
    const values = ConfigurationOptionsSchema.parse(data)
    return values
  } catch (error) {
    throw error
  }
}

async function getRemoteConfig(configOpts: {
  [key: string]: string
}): Promise<string> {
  try {
    const {data} = await octokitClient(
      'remote-config-repo-token',
      false
    ).rest.repos.getContent({
      mediaType: {
        format: 'raw'
      },
      owner: configOpts.owner,
      repo: configOpts.repo,
      path: configOpts.path,
      ref: configOpts.ref
    })

    // When using mediaType.format = 'raw', the response.data is a string but this is not reflected
    // in the return type of getContent. So we're casting the return value to a string.
    return z.string().parse(data as unknown)
  } catch (error) {
    core.debug(error as string)
    throw new Error('Error fetching remote config file')
  }
}

function mergeConfigs(
  ...configs: ConfigurationOptions[]
): ConfigurationOptions {
  return configs.reduce(
    (mergedConfig: ConfigurationOptions, config: ConfigurationOptions) => {
      for (const [key, value] of Object.entries(config)) {
        if (Array.isArray(value)) {
          const currentValue: string[] = mergedConfig[key] || []
          mergedConfig[key] = [...currentValue, ...value]
        } else {
          mergedConfig[key] = value
        }
      }
      return mergedConfig
    },
    {}
  )
}
