import { Server } from '@hapi/hapi';
import { IIotCentralModule } from '../plugins/iotCentralModule';
import { ICameraDeviceProvisionInfo } from './cameraGateway';
import { Message as IoTMessage } from 'azure-iot-device';
import * as moment from 'moment';

const moduleName = 'AvaPipeline';

export interface IPipelinePackage {
    data: any;
    instance: any;
    topology: any;
}

export class AvaPipeline {
    public static getCameraIdFromAvaMessage(message: IoTMessage): string {
        const subject = AvaPipeline.getAvaMessageProperty(message, 'subject');
        if (subject) {
            const pipelinePathElements = subject.split('/');
            if (pipelinePathElements.length >= 3 && pipelinePathElements[1] === 'livePipelines') {
                const pipelineInstanceName = pipelinePathElements[2] || '';
                if (pipelineInstanceName) {
                    return pipelineInstanceName.substring(pipelineInstanceName.indexOf('_') + 1) || '';
                }
            }
        }

        return '';
    }

    public static getAvaMessageProperty(message: IoTMessage, propertyName: string): string {
        const messageProperty = (message.properties?.propertyList || []).find(property => property.key === propertyName);

        return messageProperty?.value || '';
    }

    private server: Server;
    private iotCentralModule: IIotCentralModule;
    private avaEdgeModuleId: string;
    private cameraInfo: ICameraDeviceProvisionInfo;
    private instance: any;
    private topology: any;

    private avaAssetName: string;
    private instanceName: any;
    private topologyName: any;

    constructor(server: Server, avaEdgeModuleId: string, cameraInfo: ICameraDeviceProvisionInfo, pipelinePackage: IPipelinePackage) {
        this.server = server;
        this.iotCentralModule = server.settings.app.iotCentralModule;
        this.avaEdgeModuleId = avaEdgeModuleId;
        this.cameraInfo = cameraInfo;
        this.instance = {
            ...pipelinePackage.instance,
            name: cameraInfo.cameraId
        };
        this.topology = {
            ...pipelinePackage.topology
        };

        this.avaAssetName = '';
        this.instanceName = {
            ['@apiVersion']: this.instance['@apiVersion'],
            name: this.instance.name
        };

        this.topologyName = {
            ['@apiVersion']: this.topology['@apiVersion'],
            name: this.topology.name
        };
    }

    public getInstance(): any {
        return this.instance;
    }

    public getTopology(): any {
        return this.topology;
    }

    public getInstanceName(): string {
        return this.instanceName?.name || '';
    }

    public getTopologyName(): string {
        return this.topologyName?.name || '';
    }

    public setParam(paramName: string, value: any): void {
        if (!paramName || value === undefined) {
            this.server.log([moduleName, this.cameraInfo.cameraId, 'error'], `setParam error - param: ${paramName}, value: ${value}`);
            return;
        }

        const params = this.instance.properties?.parameters || [];
        const param = params.find(item => item.name === paramName);
        if (!param) {
            this.server.log([moduleName, this.cameraInfo.cameraId, 'warning'], `setParam no param named: ${paramName}`);
            return;
        }

        param.value = value;
    }

    public async startAvaPipeline(pipelineParameters: any): Promise<boolean> {
        this.server.log([moduleName, this.cameraInfo.cameraId, 'info'], `startAvaPipeline`);

        let result = false;

        try {
            result = await this.setTopology();

            if (result === true) {
                result = await this.setInstance(pipelineParameters);
            }

            if (result === true) {
                result = await this.activateInstance();
            }
        }
        catch (ex) {
            this.server.log([moduleName, this.cameraInfo.cameraId, 'error'], `startAvaPipeline error: ${ex.message}`);
        }

        return result;
    }

    public async stopAvaPipeline(): Promise<boolean> {
        this.server.log([moduleName, this.cameraInfo.cameraId, 'info'], `stopAvaPipeline`);

        let result = false;

        try {
            await this.deactivateInstance();

            result = true;
        }
        catch (ex) {
            this.server.log([moduleName, this.cameraInfo.cameraId, 'error'], `stopAvaPipeline error: ${ex.message}`);
        }

        return result;
    }

    public async deleteAvaPipeline(): Promise<boolean> {
        this.server.log([moduleName, this.cameraInfo.cameraId, 'info'], `deleteAvaPipeline`);

        let result = false;

        try {
            await this.deactivateInstance();
            await this.deleteInstance();
            await this.deleteTopology();

            result = true;
        }
        catch (ex) {
            this.server.log([moduleName, this.cameraInfo.cameraId, 'error'], `deleteAvaPipeline error: ${ex.message}`);
        }

        return result;
    }

    public createInferenceVideoLink(videoPlaybackHost: string, startTime: moment.Moment, duration: number): string {
        if (videoPlaybackHost.slice(-1) === '/') {
            videoPlaybackHost = videoPlaybackHost.slice(0, -1);
        }

        return `${videoPlaybackHost}/ampplayer?an=${this.avaAssetName}&st=${startTime.format('YYYY-MM-DDTHH:mm:ss[Z]')}&du=${duration}`;
    }

    private async setTopology(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.avaEdgeModuleId, `pipelineTopologySet`, this.topology);

        return response.status === 200;
    }

    // @ts-ignore
    private async deleteTopology(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.avaEdgeModuleId, `pipelineTopologyDelete`, this.topologyName);

        return response.status === 200;
    }

    private async setInstance(pipelineParams: any): Promise<boolean> {
        this.avaAssetName = pipelineParams.assetName;
        this.setParam('assetName', this.avaAssetName);

        this.setParam('rtspAuthUsername', this.cameraInfo.onvifUsername);
        this.setParam('rtspAuthPassword', this.cameraInfo.onvifPassword);

        for (const param in pipelineParams) {
            if (!Object.prototype.hasOwnProperty.call(pipelineParams, param)) {
                continue;
            }

            this.setParam(param, pipelineParams[param]);
        }

        const response = await this.iotCentralModule.invokeDirectMethod(this.avaEdgeModuleId, `livePipelineSet`, this.instance);

        return response.status >= 200 && response.status < 300;
    }

    private async deleteInstance(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.avaEdgeModuleId, `livePipelineDelete`, this.instanceName);

        return response.status >= 200 && response.status < 300;
    }

    private async activateInstance(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.avaEdgeModuleId, `livePipelineActivate`, this.instanceName);

        return response.status >= 200 && response.status < 300;
    }

    private async deactivateInstance(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.avaEdgeModuleId, `livePipelineDeactivate`, this.instanceName);

        return response.status >= 200 && response.status < 300;
    }
}
