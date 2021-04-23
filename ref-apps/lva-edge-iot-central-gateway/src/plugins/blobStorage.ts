import { HapiPlugin, inject } from 'spryly';
import { Server, Plugin } from '@hapi/hapi';
import {
    BlobServiceClient,
    ContainerClient
} from '@azure/storage-blob';

export interface IBlobStoragePluginOptions {
    blobConnectionString: string;
    blobHostUrl: string;
    blobContainer: string;
    blobAccountName: string;
    blobAccountKey: string;
}

export interface IBlobStorage {
    getFileFromBlobStorage(fileName: string): Promise<any>;
}

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        blobStorage?: IBlobStorage;
    }
}

const pluginModuleName = 'BlobStoragePlugin';
const moduleName = 'BlobStorageModule';

export const blobStoragePlugin: Plugin<any> = {
    name: 'BlobStoragePlugin',

    // @ts-ignore (server, options)
    register: async (server: Server, options: IBlobStoragePluginOptions) => {
        server.log([pluginModuleName, 'info'], 'register');

        if (!options.blobConnectionString) {
            throw new Error('Missing required option (blobConnectionString) in IBlobStoragePluginOptions');
        }

        const plugin = new BlobStorageModule(server, options);

        await plugin.initialize();

        server.settings.app.blobStorage = plugin;
    }
};

export class BlobStoragePlugin implements HapiPlugin {
    @inject('$server')
    private server: Server;

    public async init(): Promise<void> {
        this.server.log([moduleName, 'info'], `init`);
    }

    // @ts-ignore (options)
    public async register(server: Server, options: any): Promise<void> {
        server.log([moduleName, 'info'], 'register');

        try {
            const blobConfig = server.settings.app.config.getConfig('blobStorage');
            await server.register([
                {
                    plugin: blobStoragePlugin,
                    options: {
                        ...blobConfig
                    }
                }
            ]);
        }
        catch (ex) {
            server.log([moduleName, 'error'], `Error while registering : ${ex.message}`);
        }
    }
}

class BlobStorageModule implements IBlobStorage {
    private server: Server;
    private options: IBlobStoragePluginOptions;
    private blobStorageServiceClient: BlobServiceClient;

    constructor(server: Server, options: IBlobStoragePluginOptions) {
        this.server = server;
        this.options = options;
    }

    public async initialize(): Promise<boolean> {
        this.ensureBlobServiceClient();

        const containerClient = await this.ensureContainer();
        if (!containerClient) {
            return false;
        }

        return true;
    }

    public async getFileFromBlobStorage(fileName: string): Promise<any> {
        this.ensureBlobServiceClient();

        try {
            const containerClient = this.blobStorageServiceClient.getContainerClient(this.options.blobContainer);
            const blobClient = containerClient.getBlobClient(fileName);

            const downloadBlockBlobResponse = await blobClient.download();
            const bufferData = await this.streamToBuffer(downloadBlockBlobResponse.readableStreamBody);

            return JSON.parse(bufferData.toString());
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error while downloading blob file: ${ex.message}`);
        }

        return;
    }

    private ensureBlobServiceClient(): void {
        try {
            if (!this.blobStorageServiceClient) {
                this.blobStorageServiceClient = BlobServiceClient.fromConnectionString(this.options.blobConnectionString);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error creating the blob storage service shared key and client: ${ex.message}`);
        }
    }

    private async ensureContainer(): Promise<ContainerClient> {
        let blobStoreContainerClient;

        try {
            blobStoreContainerClient = this.blobStorageServiceClient.getContainerClient(this.options.blobContainer);

            const containerExists = await blobStoreContainerClient.exists();
            if (!containerExists) {
                const { containerClient, containerCreateResponse } = await this.blobStorageServiceClient.createContainer(this.options.blobContainer, { access: 'blob' });
                // eslint-disable-next-line no-underscore-dangle
                if (containerCreateResponse?._response.status === 201) {
                    // eslint-disable-next-line no-underscore-dangle
                    this.server.log([moduleName, 'info'], `Created blob storage container: ${containerCreateResponse?._response.status}, path: ${this.options.blobContainer}`);

                    blobStoreContainerClient = containerClient;
                }
                else {
                    // eslint-disable-next-line no-underscore-dangle
                    this.server.log([moduleName, 'info'], `Error creating blob storage container: ${containerCreateResponse?._response.status}, code: ${containerCreateResponse?.errorCode}`);
                }
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error accessing blob store container ${this.options.blobContainer}: ${ex.message}`);
        }

        return blobStoreContainerClient;
    }

    private async streamToBuffer(readableStream): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks = [];

            readableStream.on('data', (data) => {
                chunks.push(data instanceof Buffer ? data : Buffer.from(data));
            });

            readableStream.on('end', () => {
                resolve(Buffer.concat(chunks));
            });

            readableStream.on('error', reject);
        });
    }
}
