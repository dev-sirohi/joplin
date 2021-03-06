import Plugin from './Plugin';
import manifestFromObject from './utils/manifestFromObject';
import Global from './api/Global';
import BasePluginRunner from './BasePluginRunner';
import BaseService  from '../BaseService';
import shim from '../../shim';
import { filename, dirname, rtrimSlashes } from '../../path-utils';
import Setting from '../../models/Setting';
import Logger from '../../Logger';
import RepositoryApi from './RepositoryApi';
const compareVersions = require('compare-versions');
const uslug = require('uslug');
const md5File = require('md5-file/promise');

const logger = Logger.create('PluginService');

// Plugin data is split into two:
//
// - First there's the service `plugins` property, which contains the
//   plugin static data, as loaded from the plugin file or directory. For
//   example, the plugin ID, the manifest, the script files, etc.
//
// - Secondly, there's the `PluginSettings` data, which is dynamic and is
//   used for example to enable or disable a plugin. Its state is saved to
//   the user's settings.

export interface Plugins {
	[key: string]: Plugin;
}

export interface PluginSetting {
	enabled: boolean;
	deleted: boolean;
}

export function defaultPluginSetting(): PluginSetting {
	return {
		enabled: true,
		deleted: false,
	};
}

export interface PluginSettings {
	[pluginId: string]: PluginSetting;
}

function makePluginId(source: string): string {
	// https://www.npmjs.com/package/slug#options
	return uslug(source).substr(0,32);
}

export default class PluginService extends BaseService {

	private static instance_: PluginService = null;

	public static instance(): PluginService {
		if (!this.instance_) {
			this.instance_ = new PluginService();
		}

		return this.instance_;
	}

	private appVersion_: string;
	private store_: any = null;
	private platformImplementation_: any = null;
	private plugins_: Plugins = {};
	private runner_: BasePluginRunner = null;

	public initialize(appVersion: string, platformImplementation: any, runner: BasePluginRunner, store: any) {
		this.appVersion_ = appVersion;
		this.store_ = store;
		this.runner_ = runner;
		this.platformImplementation_ = platformImplementation;
	}

	public get plugins(): Plugins {
		return this.plugins_;
	}

	private setPluginAt(pluginId: string, plugin: Plugin) {
		this.plugins_ = {
			...this.plugins_,
			[pluginId]: plugin,
		};
	}

	private deletePluginAt(pluginId: string) {
		if (!this.plugins_[pluginId]) return;

		this.plugins_ = { ...this.plugins_ };
		delete this.plugins_[pluginId];
	}

	public pluginById(id: string): Plugin {
		if (!this.plugins_[id]) throw new Error(`Plugin not found: ${id}`);

		return this.plugins_[id];
	}

	public unserializePluginSettings(settings: any): PluginSettings {
		const output = { ...settings };

		for (const pluginId in output) {
			output[pluginId] = {
				...defaultPluginSetting(),
				...output[pluginId],
			};
		}

		return output;
	}

	public serializePluginSettings(settings: PluginSettings): any {
		return JSON.stringify(settings);
	}

	public pluginIdByContentScriptId(contentScriptId: string): string {
		for (const pluginId in this.plugins_) {
			const plugin = this.plugins_[pluginId];
			const contentScript = plugin.contentScriptById(contentScriptId);
			if (contentScript) return pluginId;
		}
		return null;
	}

	private async parsePluginJsBundle(jsBundleString: string) {
		const scriptText = jsBundleString;
		const lines = scriptText.split('\n');
		const manifestText: string[] = [];

		const StateStarted = 1;
		const StateInManifest = 2;
		let state: number = StateStarted;

		for (let line of lines) {
			line = line.trim();

			if (state !== StateInManifest) {
				if (line === '/* joplin-manifest:') {
					state = StateInManifest;
				}
				continue;
			}

			if (state === StateInManifest) {
				if (line.indexOf('*/') === 0) {
					break;
				} else {
					manifestText.push(line);
				}
			}
		}

		if (!manifestText.length) throw new Error('Could not find manifest');

		return {
			scriptText: scriptText,
			manifestText: manifestText.join('\n'),
		};
	}

	public async loadPluginFromJsBundle(baseDir: string, jsBundleString: string, pluginIdIfNotSpecified: string = ''): Promise<Plugin> {
		baseDir = rtrimSlashes(baseDir);

		const r = await this.parsePluginJsBundle(jsBundleString);
		return this.loadPlugin(baseDir, r.manifestText, r.scriptText, pluginIdIfNotSpecified);
	}

	public async loadPluginFromPackage(baseDir: string, path: string): Promise<Plugin> {
		baseDir = rtrimSlashes(baseDir);

		const fname = filename(path);
		const hash = await md5File(path);

		const unpackDir = `${Setting.value('tempDir')}/${fname}`;
		const manifestFilePath = `${unpackDir}/manifest.json`;

		let manifest: any = await this.loadManifestToObject(manifestFilePath);

		if (!manifest || manifest._package_hash !== hash) {
			await shim.fsDriver().remove(unpackDir);
			await shim.fsDriver().mkdir(unpackDir);

			await require('tar').extract({
				strict: true,
				portable: true,
				file: path,
				cwd: unpackDir,
			});

			manifest = await this.loadManifestToObject(manifestFilePath);
			if (!manifest) throw new Error(`Missing manifest file at: ${manifestFilePath}`);

			manifest._package_hash = hash;

			await shim.fsDriver().writeFile(manifestFilePath, JSON.stringify(manifest), 'utf8');
		}

		return this.loadPluginFromPath(unpackDir);
	}

	// Loads the manifest as a simple object with no validation. Used only
	// when unpacking a package.
	private async loadManifestToObject(path: string): Promise<any> {
		try {
			const manifestText = await shim.fsDriver().readFile(path, 'utf8');
			return JSON.parse(manifestText);
		} catch (error) {
			return null;
		}
	}

	public async loadPluginFromPath(path: string): Promise<Plugin> {
		path = rtrimSlashes(path);

		const fsDriver = shim.fsDriver();

		if (path.toLowerCase().endsWith('.js')) {
			return this.loadPluginFromJsBundle(dirname(path), await fsDriver.readFile(path), filename(path));
		} else if (path.toLowerCase().endsWith('.jpl')) {
			return this.loadPluginFromPackage(dirname(path), path);
		} else {
			let distPath = path;
			if (!(await fsDriver.exists(`${distPath}/manifest.json`))) {
				distPath = `${path}/dist`;
			}

			logger.info(`Loading plugin from ${path}`);

			const scriptText = await fsDriver.readFile(`${distPath}/index.js`);
			const manifestText = await fsDriver.readFile(`${distPath}/manifest.json`);
			const pluginId = makePluginId(filename(path));

			return this.loadPlugin(distPath, manifestText, scriptText, pluginId);
		}
	}

	private async loadPlugin(baseDir: string, manifestText: string, scriptText: string, pluginIdIfNotSpecified: string): Promise<Plugin> {
		baseDir = rtrimSlashes(baseDir);

		const manifestObj = JSON.parse(manifestText);

		const deprecationNotices = [];

		if (!manifestObj.app_min_version) {
			manifestObj.app_min_version = '1.4';
			deprecationNotices.push('The manifest must contain an "app_min_version" key, which should be the minimum version of the app you support. It was automatically set to "1.4", but please update your manifest.json file.');
		}

		if (!manifestObj.id) {
			manifestObj.id = pluginIdIfNotSpecified;
			deprecationNotices.push(`The manifest must contain an "id" key, which should be a globally unique ID for your plugin, such as "com.example.MyPlugin" or a UUID. It was automatically set to "${manifestObj.id}", but please update your manifest.json file.`);
		}

		const manifest = manifestFromObject(manifestObj);

		const plugin = new Plugin(baseDir, manifest, scriptText, (action: any) => this.store_.dispatch(action));

		for (const msg of deprecationNotices) {
			plugin.deprecationNotice('1.5', msg);
		}

		// Sanity check, although at that point the plugin ID should have
		// been set, either automatically, or because it was defined in the
		// manifest.
		if (!plugin.id) throw new Error('Could not load plugin: ID is not set');

		return plugin;
	}

	private pluginEnabled(settings: PluginSettings, pluginId: string): boolean {
		if (!settings[pluginId]) return true;
		return settings[pluginId].enabled !== false;
	}

	public async loadAndRunPlugins(pluginDirOrPaths: string | string[], settings: PluginSettings, devMode: boolean = false) {
		let pluginPaths = [];

		if (Array.isArray(pluginDirOrPaths)) {
			pluginPaths = pluginDirOrPaths;
		} else {
			pluginPaths = (await shim.fsDriver().readDirStats(pluginDirOrPaths))
				.filter((stat: any) => {
					if (stat.isDirectory()) return true;
					if (stat.path.toLowerCase().endsWith('.js')) return true;
					if (stat.path.toLowerCase().endsWith('.jpl')) return true;
					return false;
				})
				.map((stat: any) => `${pluginDirOrPaths}/${stat.path}`);
		}

		for (const pluginPath of pluginPaths) {
			if (filename(pluginPath).indexOf('_') === 0) {
				logger.info(`Plugin name starts with "_" and has not been loaded: ${pluginPath}`);
				continue;
			}

			try {
				const plugin = await this.loadPluginFromPath(pluginPath);

				// After transforming the plugin path to an ID, multiple plugins might end up with the same ID. For
				// example "MyPlugin" and "myplugin" would have the same ID. Technically it's possible to have two
				// such folders but to keep things sane we disallow it.
				if (this.plugins_[plugin.id]) throw new Error(`There is already a plugin with this ID: ${plugin.id}`);

				this.setPluginAt(plugin.id, plugin);

				if (!this.pluginEnabled(settings, plugin.id)) {
					logger.info(`Not running disabled plugin: "${plugin.id}"`);
					continue;
				}

				plugin.devMode = devMode;

				await this.runPlugin(plugin);
			} catch (error) {
				logger.error(`Could not load plugin: ${pluginPath}`, error);
			}
		}
	}

	public async runPlugin(plugin: Plugin) {
		if (compareVersions(this.appVersion_, plugin.manifest.app_min_version) < 0) {
			throw new Error(`Plugin "${plugin.id}" was disabled because it requires Joplin version ${plugin.manifest.app_min_version} and current version is ${this.appVersion_}.`);
		} else {
			this.store_.dispatch({
				type: 'PLUGIN_ADD',
				plugin: {
					id: plugin.id,
					views: {},
					contentScripts: {},
				},
			});
		}

		const pluginApi = new Global(this.platformImplementation_, plugin, this.store_);
		return this.runner_.run(plugin, pluginApi);
	}

	public async installPluginFromRepo(repoApi: RepositoryApi, pluginId: string): Promise<Plugin> {
		const pluginPath = await repoApi.downloadPlugin(pluginId);
		const plugin = await this.installPlugin(pluginPath);
		await shim.fsDriver().remove(pluginPath);
		return plugin;
	}

	public async installPlugin(jplPath: string): Promise<Plugin> {
		logger.info(`Installing plugin: "${jplPath}"`);

		// Before moving the plugin to the profile directory, we load it
		// from where it is now to check that it is valid and to retrieve
		// the plugin ID.
		const preloadedPlugin = await this.loadPluginFromPath(jplPath);

		const destPath = `${Setting.value('pluginDir')}/${preloadedPlugin.id}.jpl`;
		await shim.fsDriver().copy(jplPath, destPath);

		// Now load it from the profile directory
		const plugin = await this.loadPluginFromPath(destPath);
		if (!this.plugins_[plugin.id]) this.setPluginAt(plugin.id, plugin);
		return plugin;
	}

	private async pluginPath(pluginId: string) {
		const stats = await shim.fsDriver().readDirStats(Setting.value('pluginDir'), { recursive: false });

		for (const stat of stats) {
			if (filename(stat.path) === pluginId) {
				return `${Setting.value('pluginDir')}/${stat.path}`;
			}
		}

		return null;
	}

	public async uninstallPlugin(pluginId: string) {
		logger.info(`Uninstalling plugin: "${pluginId}"`);

		const path = await this.pluginPath(pluginId);
		if (!path) {
			// Plugin might have already been deleted
			logger.error(`Could not find plugin path to uninstall - nothing will be done: ${pluginId}`);
		} else {
			await shim.fsDriver().remove(path);
		}

		this.deletePluginAt(pluginId);
	}

	public async uninstallPlugins(settings: PluginSettings): Promise<PluginSettings> {
		let newSettings = settings;

		for (const pluginId in settings) {
			if (settings[pluginId].deleted) {
				await this.uninstallPlugin(pluginId);
				newSettings = { ...settings };
				delete newSettings[pluginId];
			}
		}

		return newSettings;
	}

	public async destroy() {
		await this.runner_.waitForSandboxCalls();
	}

}
