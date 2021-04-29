import { Server } from '@hapi/hapi';
import { IIotCentralModule } from '../plugins/iotCentralModule';
import { ICameraDeviceProvisionInfo } from './cameraGateway';
import { Message as IoTMessage } from 'azure-iot-device';
import * as moment from 'moment';

const moduleName = 'AvaPipeline';

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
    private topologyInternal: any;
    private instanceInternal: any;

    private avaAssetName: string;
    private topologyNameObject: any;
    private instanceNameObject: any;

    constructor(server: Server, avaEdgeModuleId: string, cameraInfo: ICameraDeviceProvisionInfo, pipelineTopology: any) {
        this.server = server;
        this.iotCentralModule = server.settings.app.iotCentralModule;
        this.avaEdgeModuleId = avaEdgeModuleId;
        this.cameraInfo = cameraInfo;
        this.topologyInternal = {
            ...pipelineTopology
        };
        this.instanceInternal = {
            name: cameraInfo.cameraId
        };

        this.avaAssetName = '';

        this.topologyNameObject = {
            ['@apiVersion']: this.topologyInternal['@apiVersion'],
            name: this.topologyInternal.name
        };

        this.instanceNameObject = {
            ['@apiVersion']: this.topologyInternal['@apiVersion'],
            name: this.instanceInternal.name
        };
    }

    public get topologyName(): string {
        return this.topologyNameObject?.name || '';
    }

    public get instanceName(): string {
        return this.instanceNameObject?.name || '';
    }

    public get topology(): any {
        return this.topologyInternal;
    }

    public get instance(): any {
        return this.instanceInternal;
    }

    public setInstanceParam(paramName: string, value: any): void {
        if (!paramName || value === undefined) {
            this.server.log([moduleName, this.cameraInfo.cameraId, 'error'], `setInstanceParam error - param: ${paramName}, value: ${value}`);
            return;
        }

        const params = this.instanceInternal.properties?.parameters || [];
        const param = params.find(item => item.name === paramName);
        if (!param) {
            this.server.log([moduleName, this.cameraInfo.cameraId, 'warning'], `setInstanceParam no param named: ${paramName}`);
            return;
        }

        param.value = value;
    }

    public async startAvaPipeline(pipelineInstance: any, pipelineParameters: any): Promise<boolean> {
        this.server.log([moduleName, this.cameraInfo.cameraId, 'info'], `startAvaPipeline`);

        let result = false;

        try {
            this.instanceInternal = {
                ...pipelineInstance,
                name: this.cameraInfo.cameraId
            };

            this.server.log([moduleName, this.cameraInfo.cameraId, '#####'], `going to call setTopology`);
            result = await this.setTopology();
            this.server.log([moduleName, this.cameraInfo.cameraId, '#####'], `setTopology result is ${result}`);

            if (result === true) {
                this.server.log([moduleName, this.cameraInfo.cameraId, '#####'], `going to call setInstance`);
                result = await this.setInstance(pipelineParameters);
                this.server.log([moduleName, this.cameraInfo.cameraId, '#####'], `setInstance result is ${result}`);
            }

            if (result === true) {
                this.server.log([moduleName, this.cameraInfo.cameraId, '#####'], `going to call activateInstance`);
                result = await this.activateInstance();
                this.server.log([moduleName, this.cameraInfo.cameraId, '#####'], `activateInstance result is ${result}`);
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
        const response = await this.iotCentralModule.invokeDirectMethod(this.avaEdgeModuleId, `pipelineTopologySet`, this.topologyInternal);

        return response.status >= 200 && response.status < 300;
    }

    // @ts-ignore
    private async deleteTopology(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.avaEdgeModuleId, `pipelineTopologyDelete`, this.topologyNameObject);

        return response.status >= 200 && response.status < 300;
    }

    private async setInstance(pipelineParams: any): Promise<boolean> {
        this.avaAssetName = pipelineParams.assetName;
        this.setInstanceParam('assetName', this.avaAssetName);

        this.setInstanceParam('rtspAuthUsername', this.cameraInfo.onvifUsername);
        this.setInstanceParam('rtspAuthPassword', this.cameraInfo.onvifPassword);

        for (const param in pipelineParams) {
            if (!Object.prototype.hasOwnProperty.call(pipelineParams, param)) {
                continue;
            }

            this.setInstanceParam(param, pipelineParams[param]);
        }

        const response = await this.iotCentralModule.invokeDirectMethod(this.avaEdgeModuleId, `livePipelineSet`, this.instanceInternal);

        return response.status >= 200 && response.status < 300;
    }

    private async deleteInstance(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.avaEdgeModuleId, `livePipelineDelete`, this.instanceNameObject);

        return response.status >= 200 && response.status < 300;
    }

    private async activateInstance(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.avaEdgeModuleId, `livePipelineActivate`, this.instanceNameObject);

        return response.status >= 200 && response.status < 300;
    }

    private async deactivateInstance(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.avaEdgeModuleId, `livePipelineDeactivate`, this.instanceNameObject);

        return response.status >= 200 && response.status < 300;
    }
}
