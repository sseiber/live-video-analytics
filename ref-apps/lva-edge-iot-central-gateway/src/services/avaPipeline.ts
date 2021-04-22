import { IIoTCentralModule } from '../plugins/iotCentral';
import {
    IEnvConfig,
    ICameraDeviceProvisionInfo
} from './cameraGateway';
import { Message as IoTMessage } from 'azure-iot-device';
import * as fse from 'fs-extra';
import { resolve as pathResolve } from 'path';
import * as moment from 'moment';

const moduleName = 'AvaPipeline';
const contentRootDirectory = process.env.CONTENT_ROOT || '/data/content';

export class AvaPipeline {
    public static async createAvaPipeline(iotCentralModule: IIoTCentralModule, cameraInfo: ICameraDeviceProvisionInfo): Promise<AvaPipeline> {
        try {
            const pipelineInstancePath = pathResolve(contentRootDirectory, `${cameraInfo.detectionType}PipelineInstance.json`);
            const pipelineInstance = fse.readJSONSync(pipelineInstancePath);

            pipelineInstance.name = cameraInfo.cameraId;

            // iotCentralModule.logger([moduleName, cameraInfo.cameraId, 'info'], `### pipelineData: ${JSON.stringify(pipelineInstance, null, 4)}`);

            const pipelineTopologyPath = pathResolve(contentRootDirectory, `${cameraInfo.detectionType}PipelineTopology.json`);
            const pipelineTopology = fse.readJSONSync(pipelineTopologyPath);

            // iotCentralModule.logger([moduleName, cameraInfo.cameraId, 'info'], `### pipelineData: ${JSON.stringify(pipelineTopology, null, 4)}`);

            const avaPipeline = new AvaPipeline(iotCentralModule, cameraInfo, pipelineInstance, pipelineTopology);

            return avaPipeline;
        }
        catch (ex) {
            iotCentralModule.logger([moduleName, cameraInfo.cameraId, 'error'], `Error while loading pipeline topology: ${ex.message}`);
        }
    }

    public static getCameraIdFromAvaMessage(message: IoTMessage): string {
        const subject = AvaPipeline.getAvaMessageProperty(message, 'subject');
        if (subject) {
            const pipelinePathElements = subject.split('/');
            if (pipelinePathElements.length >= 3 && pipelinePathElements[1] === 'graphInstances') {
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

    private iotCentralModule: IIoTCentralModule;
    private envConfig: IEnvConfig;
    private cameraInfo: ICameraDeviceProvisionInfo;
    private instance: any;
    private topology: any;

    private rtspUrl: string;
    private avaAssetName: string;
    private instanceName: any;
    private topologyName: any;

    constructor(iotCentralModule: IIoTCentralModule,
        cameraInfo: ICameraDeviceProvisionInfo,
        instance: any,
        topology: any) {

        this.iotCentralModule = iotCentralModule;
        this.envConfig = iotCentralModule.getAppConfig().env;
        this.cameraInfo = cameraInfo;
        this.instance = instance;
        this.topology = topology;

        this.rtspUrl = '';
        this.avaAssetName = '';
        this.instanceName = {
            ['@apiVersion']: instance['@apiVersion'],
            name: instance.name
        };

        this.topologyName = {
            ['@apiVersion']: topology['@apiVersion'],
            name: topology.name
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
            this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'error'], `setParam error - param: ${paramName}, value: ${value}`);
            return;
        }

        const params = this.instance.properties?.parameters || [];
        const param = params.find(item => item.name === paramName);
        if (!param) {
            this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'warning'], `setParam no param named: ${paramName}`);
            return;
        }

        param.value = value;
    }

    public async startAvaPipeline(pipelineParameters: any): Promise<boolean> {
        this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'info'], `startAvaPipeline`);

        let result = false;

        try {
            result = await this.resolveOnvifRtspConnection('');

            if (result === true) {
                result = await this.setTopology();
            }

            if (result === true) {
                result = await this.setInstance(pipelineParameters);
            }

            if (result === true) {
                result = await this.activateInstance();
            }
        }
        catch (ex) {
            this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'error'], `startAvaPipeline error: ${ex.message}`);
        }

        return result;
    }

    public async stopAvaPipeline(): Promise<boolean> {
        this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'info'], `stopAvaPipeline`);

        let result = false;

        try {
            await this.deactivateInstance();

            result = true;
        }
        catch (ex) {
            this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'error'], `stopAvaPipeline error: ${ex.message}`);
        }

        return result;
    }

    public async deleteAvaPipeline(): Promise<boolean> {
        this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'info'], `deleteAvaPipeline`);

        let result = false;

        try {
            await this.deactivateInstance();
            await this.deleteInstance();
            await this.deleteTopology();

            result = true;
        }
        catch (ex) {
            this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'error'], `deleteAvaPipeline error: ${ex.message}`);
        }

        return result;
    }

    public createInferenceVideoLink(videoPlaybackHost: string, startTime: moment.Moment, duration: number): string {
        if (videoPlaybackHost.slice(-1) === '/') {
            videoPlaybackHost = videoPlaybackHost.slice(0, -1);
        }

        return `${videoPlaybackHost}/ampplayer?ac=${this.envConfig.avaAccountName}&an=${this.avaAssetName}&st=${startTime.format('YYYY-MM-DDTHH:mm:ss[Z]')}&du=${duration}`;
    }

    private async resolveOnvifRtspConnection(mediaProfileToken: string): Promise<boolean> {
        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword,
                MediaProfileToken: mediaProfileToken
            };

            const serviceResponse = await this.iotCentralModule.invokeDirectMethod(
                this.envConfig.onvifModuleId,
                'GetRTSPStreamURI',
                requestParams);

            this.rtspUrl = serviceResponse.status === 200 ? serviceResponse.payload : '';
        }
        catch (ex) {
            this.iotCentralModule.logger([moduleName, 'error'], `An error occurred while getting onvif stream uri from device id: ${this.cameraInfo.cameraId}`);
        }

        return !!this.rtspUrl;
    }

    private async setTopology(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.envConfig.avaEdgeModuleId, `PipelineTopologySet`, this.topology);

        return response.status === 200;
    }

    // @ts-ignore
    private async deleteTopology(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.envConfig.avaEdgeModuleId, `PipelineTopologyDelete`, this.topologyName);

        return response.status === 200;
    }

    private async setInstance(pipelineParams: any): Promise<boolean> {
        this.avaAssetName = pipelineParams.assetName;
        this.setParam('assetName', this.avaAssetName);

        this.setParam('rtspUrl', this.rtspUrl);
        this.setParam('rtspAuthUsername', this.cameraInfo.onvifUsername);
        this.setParam('rtspAuthPassword', this.cameraInfo.onvifPassword);

        for (const param in pipelineParams) {
            if (!Object.prototype.hasOwnProperty.call(pipelineParams, param)) {
                continue;
            }

            this.setParam(param, pipelineParams[param]);
        }

        const response = await this.iotCentralModule.invokeDirectMethod(this.envConfig.avaEdgeModuleId, `PipelineInstanceSet`, this.instance);

        return response.status === 200;
    }

    private async deleteInstance(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.envConfig.avaEdgeModuleId, `PipelineInstanceDelete`, this.instanceName);

        return response.status === 200;
    }

    private async activateInstance(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.envConfig.avaEdgeModuleId, `PipelineInstanceActivate`, this.instanceName);

        return response.status === 200;
    }

    private async deactivateInstance(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.envConfig.avaEdgeModuleId, `PipelineInstanceDeactivate`, this.instanceName);

        return response.status === 200;
    }
}
