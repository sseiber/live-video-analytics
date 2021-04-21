import { IIoTCentralModule } from '../plugins/iotCentral';
import {
    IEnvConfig,
    ICameraDeviceProvisionInfo
} from './cameraGateway';
import { Message as IoTMessage } from 'azure-iot-device';
import * as fse from 'fs-extra';
import { resolve as pathResolve } from 'path';
import * as moment from 'moment';

const moduleName = 'AmsGraph';
const contentRootDirectory = process.env.CONTENT_ROOT || '/data/content';

export class AmsGraph {
    public static async createAmsGraph(iotCentralModule: IIoTCentralModule, cameraInfo: ICameraDeviceProvisionInfo): Promise<AmsGraph> {
        try {
            const pipelineInstancePath = pathResolve(contentRootDirectory, `${cameraInfo.detectionType}PipelineInstance.json`);
            const pipelineInstance = fse.readJSONSync(pipelineInstancePath);

            pipelineInstance.name = cameraInfo.cameraId;

            // iotCentralModule.logger([moduleName, cameraInfo.cameraId, 'info'], `### graphData: ${JSON.stringify(pipelineInstance, null, 4)}`);

            const pipelineTopologyPath = pathResolve(contentRootDirectory, `${cameraInfo.detectionType}PipelineTopology.json`);
            const pipelineTopology = fse.readJSONSync(pipelineTopologyPath);

            // iotCentralModule.logger([moduleName, cameraInfo.cameraId, 'info'], `### graphData: ${JSON.stringify(pipelineTopology, null, 4)}`);

            const amsGraph = new AmsGraph(iotCentralModule, cameraInfo, pipelineInstance, pipelineTopology);

            return amsGraph;
        }
        catch (ex) {
            iotCentralModule.logger([moduleName, cameraInfo.cameraId, 'error'], `Error while loading pipeline topology: ${ex.message}`);
        }
    }

    public static getCameraIdFromLvaMessage(message: IoTMessage): string {
        const subject = AmsGraph.getLvaMessageProperty(message, 'subject');
        if (subject) {
            const graphPathElements = subject.split('/');
            if (graphPathElements.length >= 3 && graphPathElements[1] === 'pipelineInstances') {
                const pipelineInstanceName = graphPathElements[2] || '';
                if (pipelineInstanceName) {
                    return pipelineInstanceName.substring(pipelineInstanceName.indexOf('_') + 1) || '';
                }
            }
        }

        return '';
    }

    public static getLvaMessageProperty(message: IoTMessage, propertyName: string): string {
        const messageProperty = (message.properties?.propertyList || []).find(property => property.key === propertyName);

        return messageProperty?.value || '';
    }

    private iotCentralModule: IIoTCentralModule;
    private envConfig: IEnvConfig;
    private cameraInfo: ICameraDeviceProvisionInfo;
    private instance: any;
    private topology: any;

    private rtspUrl: string;
    private amsAssetName: string;
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
        this.amsAssetName = '';
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

    public async startLvaGraph(graphParameters: any): Promise<boolean> {
        this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'info'], `startLvaGraph`);

        let result = false;

        try {
            result = await this.resolveOnvifRtspConnection('');

            if (result === true) {
                result = await this.setTopology();
            }

            if (result === true) {
                result = await this.setInstance(graphParameters);
            }

            if (result === true) {
                result = await this.activateInstance();
            }
        }
        catch (ex) {
            this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'error'], `startLvaGraph error: ${ex.message}`);
        }

        return result;
    }

    public async stopLvaGraph(): Promise<boolean> {
        this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'info'], `stopLvaGraph`);

        let result = false;

        try {
            await this.deactivateInstance();

            result = true;
        }
        catch (ex) {
            this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'error'], `stopLvaGraph error: ${ex.message}`);
        }

        return result;
    }

    public async deleteLvaGraph(): Promise<boolean> {
        this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'info'], `deleteLvaGraph`);

        let result = false;

        try {
            await this.deactivateInstance();
            await this.deleteInstance();
            await this.deleteTopology();

            result = true;
        }
        catch (ex) {
            this.iotCentralModule.logger([moduleName, this.cameraInfo.cameraId, 'error'], `deleteLvaGraph error: ${ex.message}`);
        }

        return result;
    }

    public createInferenceVideoLink(videoPlaybackHost: string, startTime: moment.Moment, duration: number): string {
        if (videoPlaybackHost.slice(-1) === '/') {
            videoPlaybackHost = videoPlaybackHost.slice(0, -1);
        }

        return `${videoPlaybackHost}/ampplayer?ac=${this.envConfig.amsAccountName}&an=${this.amsAssetName}&st=${startTime.format('YYYY-MM-DDTHH:mm:ss[Z]')}&du=${duration}`;
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
        const response = await this.iotCentralModule.invokeDirectMethod(this.envConfig.lvaEdgeModuleId, `PipelineTopologySet`, this.topology);

        return response.status === 200;
    }

    // @ts-ignore
    private async deleteTopology(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.envConfig.lvaEdgeModuleId, `PipelineTopologyDelete`, this.topologyName);

        return response.status === 200;
    }

    private async setInstance(graphParameters: any): Promise<boolean> {
        this.amsAssetName = graphParameters.assetName;
        this.setParam('assetName', this.amsAssetName);

        this.setParam('rtspUrl', this.rtspUrl);
        this.setParam('rtspAuthUsername', this.cameraInfo.onvifUsername);
        this.setParam('rtspAuthPassword', this.cameraInfo.onvifPassword);

        for (const param in graphParameters) {
            if (!Object.prototype.hasOwnProperty.call(graphParameters, param)) {
                continue;
            }

            this.setParam(param, graphParameters[param]);
        }

        const response = await this.iotCentralModule.invokeDirectMethod(this.envConfig.lvaEdgeModuleId, `PipelineInstanceSet`, this.instance);

        return response.status === 200;
    }

    private async deleteInstance(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.envConfig.lvaEdgeModuleId, `PipelineInstanceDelete`, this.instanceName);

        return response.status === 200;
    }

    private async activateInstance(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.envConfig.lvaEdgeModuleId, `PipelineInstanceActivate`, this.instanceName);

        return response.status === 200;
    }

    private async deactivateInstance(): Promise<boolean> {
        const response = await this.iotCentralModule.invokeDirectMethod(this.envConfig.lvaEdgeModuleId, `PipelineInstanceDeactivate`, this.instanceName);

        return response.status === 200;
    }
}
