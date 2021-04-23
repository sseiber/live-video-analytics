import { HapiPlugin, inject } from 'spryly';
import { Server, Plugin } from '@hapi/hapi';
import { resolve as pathResolve } from 'path';
import * as fse from 'fs-extra';
import * as _get from 'lodash.get';

export interface IConfigPluginOptions {
    config: any;
}

export interface IConfig {
    getConfig(key: string): any;
}

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        config?: IConfig;
    }
}

const moduleName = 'ConfigPlugin';

const configPlugin: Plugin<any> = {
    name: 'ConfigPlugin',

    // @ts-ignore (server, options)
    register: async (server: Server, options: IConfigPluginOptions) => {
        server.log([moduleName, 'info'], 'register');

        if (!options.config) {
            throw new Error('Missing required option config in IConfigPluginOptions');
        }

        server.settings.app.config = new ConfigModule(server, options);
    }
};

export class ConfigPlugin implements HapiPlugin {
    @inject('$server')
    private server: Server;

    public async init(): Promise<void> {
        this.server.log([moduleName, 'info'], `init`);
    }

    // @ts-ignore (options)
    public async register(server: Server, options: any): Promise<void> {
        server.log([moduleName, 'info'], 'register');

        try {
            await server.register([
                {
                    plugin: configPlugin,
                    options: {
                        config: {
                            type: 'file',
                            data: pathResolve(this.server.settings.app.storageRootDirectory || '/data/storage', 'state.json')
                        }
                    }
                }
            ]);
        }
        catch (ex) {
            server.log([moduleName, 'error'], `Error while registering : ${ex.message}`);
        }
    }
}

class ConfigModule implements IConfig {
    private server: Server;
    private options: IConfigPluginOptions;
    private appConfig: any;

    constructor(server: Server, options: IConfigPluginOptions) {
        this.server = server;
        this.options = options;
    }

    public async initialize(): Promise<boolean> {
        this.server.log([moduleName, 'info'], 'initialize');

        if (this.options.config?.type === 'file') {
            this.appConfig = await fse.readJson(this.options.config?.data);
        }
        else {
            this.appConfig = this.options.config?.data || {};
        }

        return true;
    }

    public getConfig(key: string): any {
        return _get(this.appConfig, key);
    }
}
