/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { devices } from 'playwright';

import type { Config, ToolCapability } from '../config.js';
import type { BrowserContextOptions, LaunchOptions } from 'playwright';
import { sanitizeForFilePath } from './tools/utils.js';

export type CLIOptions = {
  allowedOrigins?: string[];
  blockedOrigins?: string[];
  blockServiceWorkers?: boolean;
  browser?: string;
  caps?: string[];
  cdpEndpoint?: string;
  config?: string;
  device?: string;
  executablePath?: string;
  headless?: boolean;
  host?: string;
  ignoreHttpsErrors?: boolean;
  isolated?: boolean;
  imageResponses?: 'allow' | 'omit';
  sandbox?: boolean;
  outputDir?: string;
  port?: number;
  proxyBypass?: string;
  proxyServer?: string;
  saveTrace?: boolean;
  storageState?: string;
  userAgent?: string;
  userDataDir?: string;
  viewportSize?: string;
};

const defaultConfig: FullConfig = {
  browser: {
    browserName: 'chromium',
    launchOptions: {
      channel: 'chrome',
      headless: os.platform() === 'linux' && !process.env.DISPLAY,
      chromiumSandbox: true,
    },
    contextOptions: {
      viewport: null,
    },
  },
  network: {
    allowedOrigins: undefined,
    blockedOrigins: undefined,
  },
  server: {},
  outputDir: path.join(os.tmpdir(), 'playwright-mcp-output', sanitizeForFilePath(new Date().toISOString())),
};

type BrowserUserConfig = NonNullable<Config['browser']>;

export type FullConfig = Config & {
  browser: Omit<BrowserUserConfig, 'browserName'> & {
    browserName: 'chromium' | 'firefox' | 'webkit';
    launchOptions: NonNullable<BrowserUserConfig['launchOptions']>;
    contextOptions: NonNullable<BrowserUserConfig['contextOptions']>;
  },
  network: NonNullable<Config['network']>,
  outputDir: string;
  server: NonNullable<Config['server']>,
};

export async function resolveConfig(config: Config): Promise<FullConfig> {
  return mergeConfig(defaultConfig, config);
}

export async function resolveCLIConfig(cliOptions: CLIOptions): Promise<FullConfig> {
  const configInFile = await loadConfig(cliOptions.config);
  const envOverrides = configFromEnv();
  const cliOverrides = configFromCLIOptions(cliOptions);
  let result = defaultConfig;
  result = mergeConfig(result, configInFile);
  result = mergeConfig(result, envOverrides);
  result = mergeConfig(result, cliOverrides);
  // Derive artifact output directory from config.outputDir
  if (result.saveTrace)
    result.browser.launchOptions.tracesDir = path.join(result.outputDir, 'traces');
  return result;
}

export function configFromCLIOptions(cliOptions: CLIOptions): Config {
  let browserName: 'chromium' | 'firefox' | 'webkit' | undefined;
  let channel: string | undefined;
  switch (cliOptions.browser) {
    case 'chrome':
    case 'chrome-beta':
    case 'chrome-canary':
    case 'chrome-dev':
    case 'chromium':
    case 'msedge':
    case 'msedge-beta':
    case 'msedge-canary':
    case 'msedge-dev':
      browserName = 'chromium';
      channel = cliOptions.browser;
      break;
    case 'firefox':
      browserName = 'firefox';
      break;
    case 'webkit':
      browserName = 'webkit';
      break;
  }

  // Launch options
  const launchOptions: LaunchOptions = {
    channel,
    executablePath: cliOptions.executablePath,
    headless: cliOptions.headless,
  };

  // --no-sandbox was passed, disable the sandbox
  if (!cliOptions.sandbox)
    launchOptions.chromiumSandbox = false;

  if (cliOptions.proxyServer) {
    launchOptions.proxy = {
      server: cliOptions.proxyServer
    };
    if (cliOptions.proxyBypass)
      launchOptions.proxy.bypass = cliOptions.proxyBypass;
  }

  if (cliOptions.device && cliOptions.cdpEndpoint)
    throw new Error('Device emulation is not supported with cdpEndpoint.');

  // Context options
  const contextOptions: BrowserContextOptions = cliOptions.device ? devices[cliOptions.device] : {};
  if (cliOptions.storageState)
    contextOptions.storageState = cliOptions.storageState;

  if (cliOptions.userAgent)
    contextOptions.userAgent = cliOptions.userAgent;

  if (cliOptions.viewportSize) {
    try {
      const [width, height] = cliOptions.viewportSize.split(',').map(n => +n);
      if (isNaN(width) || isNaN(height))
        throw new Error('bad values');
      contextOptions.viewport = { width, height };
    } catch (e) {
      throw new Error('Invalid viewport size format: use "width,height", for example --viewport-size="800,600"');
    }
  }

  if (cliOptions.ignoreHttpsErrors)
    contextOptions.ignoreHTTPSErrors = true;

  if (cliOptions.blockServiceWorkers)
    contextOptions.serviceWorkers = 'block';

  const result: Config = {
    browser: {
      browserName,
      isolated: cliOptions.isolated,
      userDataDir: cliOptions.userDataDir,
      launchOptions,
      contextOptions,
      cdpEndpoint: cliOptions.cdpEndpoint,
    },
    server: {
      port: cliOptions.port,
      host: cliOptions.host,
    },
    capabilities: cliOptions.caps as ToolCapability[],
    network: {
      allowedOrigins: cliOptions.allowedOrigins,
      blockedOrigins: cliOptions.blockedOrigins,
    },
    saveTrace: cliOptions.saveTrace,
    outputDir: cliOptions.outputDir,
    imageResponses: cliOptions.imageResponses,
  };

  return result;
}

function configFromEnv(): Config {
  const options: CLIOptions = {};
  options.allowedOrigins = semicolonSeparatedList(process.env.PLAYWRIGHT_MCP_ALLOWED_ORIGINS);
  options.blockedOrigins = semicolonSeparatedList(process.env.PLAYWRIGHT_MCP_BLOCKED_ORIGINS);
  options.blockServiceWorkers = envToBoolean(process.env.PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS);
  options.browser = envToString(process.env.PLAYWRIGHT_MCP_BROWSER);
  options.caps = commaSeparatedList(process.env.PLAYWRIGHT_MCP_CAPS);
  options.cdpEndpoint = envToString(process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT);
  options.config = envToString(process.env.PLAYWRIGHT_MCP_CONFIG);
  options.device = envToString(process.env.PLAYWRIGHT_MCP_DEVICE);
  options.executablePath = envToString(process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH);
  options.headless = envToBoolean(process.env.PLAYWRIGHT_MCP_HEADLESS);
  options.host = envToString(process.env.PLAYWRIGHT_MCP_HOST);
  options.ignoreHttpsErrors = envToBoolean(process.env.PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS);
  options.isolated = envToBoolean(process.env.PLAYWRIGHT_MCP_ISOLATED);
  if (process.env.PLAYWRIGHT_MCP_IMAGE_RESPONSES === 'omit')
    options.imageResponses = 'omit';
  options.sandbox = envToBoolean(process.env.PLAYWRIGHT_MCP_SANDBOX);
  options.outputDir = envToString(process.env.PLAYWRIGHT_MCP_OUTPUT_DIR);
  options.port = envToNumber(process.env.PLAYWRIGHT_MCP_PORT);
  options.proxyBypass = envToString(process.env.PLAYWRIGHT_MCP_PROXY_BYPASS);
  options.proxyServer = envToString(process.env.PLAYWRIGHT_MCP_PROXY_SERVER);
  options.saveTrace = envToBoolean(process.env.PLAYWRIGHT_MCP_SAVE_TRACE);
  options.storageState = envToString(process.env.PLAYWRIGHT_MCP_STORAGE_STATE);
  options.userAgent = envToString(process.env.PLAYWRIGHT_MCP_USER_AGENT);
  options.userDataDir = envToString(process.env.PLAYWRIGHT_MCP_USER_DATA_DIR);
  options.viewportSize = envToString(process.env.PLAYWRIGHT_MCP_VIEWPORT_SIZE);
  return configFromCLIOptions(options);
}

async function loadConfig(configFile: string | undefined): Promise<Config> {
  if (!configFile)
    return {};

  try {
    return JSON.parse(await fs.promises.readFile(configFile, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to load config file: ${configFile}, ${error}`);
  }
}

export async function outputFile(config: FullConfig, name: string): Promise<string> {
  await fs.promises.mkdir(config.outputDir, { recursive: true });
  const fileName = sanitizeForFilePath(name);
  return path.join(config.outputDir, fileName);
}

function pickDefined<T extends object>(obj: T | undefined): Partial<T> {
  return Object.fromEntries(
      Object.entries(obj ?? {}).filter(([_, v]) => v !== undefined)
  ) as Partial<T>;
}

function mergeConfig(base: FullConfig, overrides: Config): FullConfig {
  const browser: FullConfig['browser'] = {
    ...pickDefined(base.browser),
    ...pickDefined(overrides.browser),
    browserName: overrides.browser?.browserName ?? base.browser?.browserName ?? 'chromium',
    isolated: overrides.browser?.isolated ?? base.browser?.isolated ?? false,
    launchOptions: {
      ...pickDefined(base.browser?.launchOptions),
      ...pickDefined(overrides.browser?.launchOptions),
      ...{ assistantMode: true },
    },
    contextOptions: {
      ...pickDefined(base.browser?.contextOptions),
      ...pickDefined(overrides.browser?.contextOptions),
    },
  };

  if (browser.browserName !== 'chromium' && browser.launchOptions)
    delete browser.launchOptions.channel;

  return {
    ...pickDefined(base),
    ...pickDefined(overrides),
    browser,
    network: {
      ...pickDefined(base.network),
      ...pickDefined(overrides.network),
    },
    server: {
      ...pickDefined(base.server),
      ...pickDefined(overrides.server),
    },
  } as FullConfig;
}

export function semicolonSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  return value.split(';').map(v => v.trim());
}

export function commaSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  return value.split(',').map(v => v.trim());
}

function envToNumber(value: string | undefined): number | undefined {
  if (!value)
    return undefined;
  return +value;
}

function envToBoolean(value: string | undefined): boolean | undefined {
  if (value === 'true' || value === '1')
    return true;
  if (value === 'false' || value === '0')
    return false;
  return undefined;
}

function envToString(value: string | undefined): string | undefined {
  return value ? value.trim() : undefined;
}
