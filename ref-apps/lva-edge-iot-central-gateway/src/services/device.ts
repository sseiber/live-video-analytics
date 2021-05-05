import { Server } from '@hapi/hapi';
import { IIotCentralModule } from '../plugins/iotCentralModule';
import { AvaPipeline } from './avaPipeline';
import { ICameraDeviceProvisionInfo } from './cameraGateway';
import { HealthState } from './health';
import { Mqtt as IoTHubTransport } from 'azure-iot-device-mqtt';
import {
    DeviceMethodRequest,
    DeviceMethodResponse,
    Client as IoTDeviceClient,
    Twin,
    Message as IoTMessage
} from 'azure-iot-device';
import * as moment from 'moment';
import { bind, defer, emptyObj } from '../utils';

export type DevicePropertiesHandler = (desiredChangedSettings: any) => Promise<void>;

export interface IClientConnectResult {
    clientConnectionStatus: boolean;
    clientConnectionMessage: string;
}

export interface IMediaProfileInfo {
    mediaProfileName: string;
    mediaProfileToken: string;
}

export interface IOnvifCameraInformation {
    rpManufacturer: string;
    rpModel: string;
    rpFirmwareVersion: string;
    rpHardwareId: string;
    rpSerialNumber: string;
    rpMediaProfile1: IMediaProfileInfo;
    rpMediaProfile2: IMediaProfileInfo;
}

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

enum CameraState {
    Inactive = 'inactive',
    Active = 'active'
}

export enum OnvifCameraCapability {
    tlSystemHeartbeat = 'tlSystemHeartbeat',
    stIoTCentralClientState = 'stIoTCentralClientState',
    stCameraState = 'stCameraState',
    rpCameraName = 'rpCameraName',
    evUploadImage = 'evUploadImage',
    rpIpAddress = 'rpIpAddress',
    rpOnvifUsername = 'rpOnvifUsername',
    rpOnvifPassword = 'rpOnvifPassword',
    rpIotcModelId = 'rpIotcModelId',
    rpAvaPipelineName = 'rpAvaPipelineName',
    rpMediaProfile1 = 'rpMediaProfile1',
    rpMediaProfile2 = 'rpMediaProfile2',
    rpCaptureImageUrl = 'rpCaptureImageUrl',
    wpVideoPlaybackHost = 'wpVideoPlaybackHost',
    cmCaptureImage = 'cmCaptureImage',
    cmRestartCamera = 'cmRestartCamera'
}

interface IOnvifCameraSettings {
    [OnvifCameraCapability.wpVideoPlaybackHost]: string;
}

const defaultVideoPlaybackHost = 'http://localhost:8094';
const defaultInferenceTimeout = 5;
const defaultMaxVideoInferenceTime = 10;

enum StartAvaProcessingCommandRequestParams {
    AvaPipelineInstanceName = 'StartAvaProcessingRequestParams_AvaPipelineInstanceName',
    MediaProfileToken = 'StartAvaProcessingRequestParams_MediaProfileToken'
}

enum CaptureImageCommandRequestParams {
    MediaProfileToken = 'CaptureImageRequestParams_MediaProfileToken'
}

enum CommandResponseParams {
    StatusCode = 'CommandResponseParams_StatusCode',
    Message = 'CommandResponseParams_Message',
    Data = 'CommandResponseParams_Data'
}

enum AvaEdgeOperationsCapability {
    evPipelineInstanceCreated = 'evPipelineInstanceCreated',
    evPipelineInstanceDeleted = 'evPipelineInstanceDeleted',
    evPipelineInstanceStarted = 'evPipelineInstanceStarted',
    evPipelineInstanceStopped = 'evPipelineInstanceStopped',
    evRecordingStarted = 'evRecordingStarted',
    evRecordingStopped = 'evRecordingStopped',
    evRecordingAvailable = 'evRecordingAvailable',
    wpMaxVideoInferenceTime = 'wpMaxVideoInferenceTime',
    cmStartAvaProcessing = 'cmStartAvaProcessing',
    cmStopAvaProcessing = 'cmStopAvaProcessing'
}

interface IAvaEdgeOperationsSettings {
    [AvaEdgeOperationsCapability.wpMaxVideoInferenceTime]: number;
}

enum AvaEdgeDiagnosticsCapability {
    evRuntimeError = 'evRuntimeError',
    evAuthenticationError = 'evAuthenticationError',
    evAuthorizationError = 'evAuthorizationError',
    evDataDropped = 'evDataDropped',
    evMediaFormatError = 'evMediaFormatError',
    evMediaSessionEstablished = 'evMediaSessionEstablished',
    evNetworkError = 'evNetworkError',
    evProtocolError = 'evProtocolError',
    evStorageError = 'evStorageError',
    wpDebugTelemetry = 'wpDebugTelemetry'
}

interface IAvaEdgeDiagnosticsSettings {
    [AvaEdgeDiagnosticsCapability.wpDebugTelemetry]: boolean;
}

export enum AiInferenceCapability {
    tlInferenceEntity = 'tlInferenceEntity',
    evInferenceEventVideoUrl = 'evInferenceEventVideoUrl',
    rpInferenceVideoUrl = 'rpInferenceVideoUrl',
    wpInferenceTimeout = 'wpInferenceTimeout'
}

export enum UnmodeledTelemetry {
    tlFullInferenceEntity = 'tlFullInferenceEntity',
}

interface IAiInferenceSettings {
    [AiInferenceCapability.wpInferenceTimeout]: number;
}

export abstract class AvaCameraDevice {
    protected server: Server;
    protected iotCentralModule: IIotCentralModule;
    protected onvifModuleId: string;
    protected avaEdgeModuleId: string;
    protected appScopeId: string;
    protected pipelineTopology: any;
    protected avaPipeline: AvaPipeline;
    protected cameraInfo: ICameraDeviceProvisionInfo;
    protected deviceClient: IoTDeviceClient;
    protected deviceTwin: Twin;

    protected deferredStart = defer();
    protected healthState = HealthState.Good;
    protected lastInferenceTime: moment.Moment = moment.utc(0);
    protected videoInferenceStartTime: moment.Moment = moment.utc();
    protected onvifCameraSettings: IOnvifCameraSettings = {
        wpVideoPlaybackHost: defaultVideoPlaybackHost
    };
    protected avaEdgeOperationsSettings: IAvaEdgeOperationsSettings = {
        [AvaEdgeOperationsCapability.wpMaxVideoInferenceTime]: defaultMaxVideoInferenceTime
    };
    protected avaEdgeDiagnosticsSettings: IAvaEdgeDiagnosticsSettings = {
        [AvaEdgeDiagnosticsCapability.wpDebugTelemetry]: false
    };
    protected aiInferenceSettings: IAiInferenceSettings = {
        [AiInferenceCapability.wpInferenceTimeout]: defaultInferenceTimeout
    };
    private inferenceInterval: NodeJS.Timeout;
    private createVideoLinkForInferenceTimeout = false;

    constructor(server: Server, onvifModuleId: string, avaEdgeModuleId: string, appScopeId: string, pipelineTopology: any, cameraInfo: ICameraDeviceProvisionInfo) {
        this.server = server;
        this.iotCentralModule = server.settings.app.iotCentralModule;
        this.onvifModuleId = onvifModuleId;
        this.avaEdgeModuleId = avaEdgeModuleId;
        this.appScopeId = appScopeId;
        this.pipelineTopology = pipelineTopology;
        this.cameraInfo = cameraInfo;
    }

    public abstract setPipelineParams(): any;
    public abstract deviceReady(): Promise<void>;
    public abstract processAvaInferences(inferenceData: any): Promise<void>;

    public async connectDeviceClient(dpsHubConnectionString: string): Promise<IClientConnectResult> {
        let clientConnectionResult: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        try {
            this.avaPipeline = new AvaPipeline(this.server, this.avaEdgeModuleId, this.cameraInfo, this.pipelineTopology);

            clientConnectionResult = await this.connectDeviceClientInternal(dpsHubConnectionString, this.onHandleDeviceProperties);

            if (clientConnectionResult.clientConnectionStatus === true) {
                await this.deferredStart.promise;

                await this.deviceReady();

                await this.sendMeasurement({
                    [OnvifCameraCapability.stIoTCentralClientState]: IoTCentralClientState.Connected,
                    [OnvifCameraCapability.stCameraState]: CameraState.Inactive
                });
            }
        }
        catch (ex) {
            clientConnectionResult.clientConnectionStatus = false;
            clientConnectionResult.clientConnectionMessage = `An error occurred while accessing the device twin properties`;

            this.server.log([this.cameraInfo.cameraId, 'error'], clientConnectionResult.clientConnectionMessage);
        }

        return clientConnectionResult;
    }

    @bind
    public async getHealth(): Promise<number> {
        await this.sendMeasurement({
            [OnvifCameraCapability.tlSystemHeartbeat]: this.healthState
        });

        return this.healthState;
    }

    public async deleteCamera(): Promise<void> {
        this.server.log([this.cameraInfo.cameraId, 'info'], `Deleting camera device instance for cameraId: ${this.cameraInfo.cameraId}`);

        try {
            this.server.log([this.cameraInfo.cameraId, 'info'], `Deactiving pipeline instance: ${this.avaPipeline.instanceName}`);

            await this.avaPipeline.deleteAvaPipeline();

            if (this.deviceTwin) {
                this.deviceTwin.removeAllListeners();
            }

            if (this.deviceClient) {
                this.deviceClient.removeAllListeners();

                await this.deviceClient.close();
            }

            this.deviceClient = null;
            this.deviceTwin = null;

            await this.sendMeasurement({
                [OnvifCameraCapability.stCameraState]: CameraState.Inactive
            });
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Error while deleting camera: ${this.cameraInfo.cameraId}`);
        }
    }

    public async sendAvaEvent(avaEvent: string, messageJson?: any): Promise<void> {
        let eventField;
        let eventValue = this.cameraInfo.cameraId;

        switch (avaEvent) {
            case 'Microsoft.VideoAnalyzer.Operational.RecordingStarted':
                eventField = AvaEdgeOperationsCapability.evRecordingStarted;
                eventValue = messageJson?.outputLocation || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Operational.RecordingStopped':
                eventField = AvaEdgeOperationsCapability.evRecordingStopped;
                eventValue = messageJson?.outputLocation || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Operational.RecordingAvailable':
                eventField = AvaEdgeOperationsCapability.evRecordingAvailable;
                eventValue = messageJson?.outputLocation || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.RuntimeError':
                eventField = AvaEdgeDiagnosticsCapability.evRuntimeError;
                eventValue = messageJson?.code || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.AuthenticationError':
                eventField = AvaEdgeDiagnosticsCapability.evAuthenticationError;
                eventValue = messageJson?.errorCode || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.AuthorizationError':
                eventField = AvaEdgeDiagnosticsCapability.evAuthorizationError;
                eventValue = messageJson?.errorCode || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.DataDropped':
                eventField = AvaEdgeDiagnosticsCapability.evDataDropped;
                eventValue = messageJson?.dataType || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.MediaFormatError':
                eventField = AvaEdgeDiagnosticsCapability.evMediaFormatError;
                eventValue = messageJson?.code || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.MediaSessionEstablished':
                eventField = AvaEdgeDiagnosticsCapability.evMediaSessionEstablished;
                eventValue = this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.NetworkError':
                eventField = AvaEdgeDiagnosticsCapability.evNetworkError;
                eventValue = messageJson?.errorCode || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.ProtocolError':
                eventField = AvaEdgeDiagnosticsCapability.evProtocolError;
                eventValue = `${messageJson?.protocol}: ${messageJson?.errorCode}` || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.VideoAnalyzer.Diagnostics.StorageError':
                eventField = AvaEdgeDiagnosticsCapability.evStorageError;
                eventValue = messageJson?.storageAccountName || this.cameraInfo.cameraId;
                break;

            default:
                this.server.log([this.cameraInfo.cameraId, 'warning'], `Received Unknown AVA event telemetry: ${avaEvent}`);
                break;
        }

        if (avaEvent) {
            await this.sendMeasurement({
                [eventField]: eventValue
            });
        }
        else {
            this.server.log([this.cameraInfo.cameraId, 'warning'], `Received Unknown AVA event telemetry: ${avaEvent}`);
        }
    }

    protected debugTelemetry(): boolean {
        return this.avaEdgeDiagnosticsSettings[AvaEdgeDiagnosticsCapability.wpDebugTelemetry];
    }

    protected async getCameraProps(): Promise<IOnvifCameraInformation> {
        try {
            const deviceInfoResult = await this.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetDeviceInformation',
                {
                    Address: this.cameraInfo.ipAddress,
                    Username: this.cameraInfo.onvifUsername,
                    Password: this.cameraInfo.onvifPassword
                });

            const mediaProfileResult = await this.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetMediaProfileList',
                {
                    Address: this.cameraInfo.ipAddress,
                    Username: this.cameraInfo.onvifUsername,
                    Password: this.cameraInfo.onvifPassword
                });

            return {
                rpManufacturer: deviceInfoResult.payload?.Manufacturer || '',
                rpModel: deviceInfoResult.payload?.Model || '',
                rpFirmwareVersion: deviceInfoResult.payload?.Firmware || '',
                rpHardwareId: deviceInfoResult.payload?.HardwareId || '',
                rpSerialNumber: deviceInfoResult.payload?.SerialNumber || '',

                rpMediaProfile1: {
                    mediaProfileName: mediaProfileResult.payload[0]?.MediaProfileName || '',
                    mediaProfileToken: mediaProfileResult.payload[0]?.MediaProfileToken || ''
                },
                rpMediaProfile2: {
                    mediaProfileName: mediaProfileResult.payload[1]?.MediaProfileName || '',
                    mediaProfileToken: mediaProfileResult.payload[1]?.MediaProfileToken || ''
                }
            };
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Error getting onvif device properties: ${ex.message}`);
        }

        return;
    }

    protected async getRtspStreamUrl(mediaProfileToken: string): Promise<string> {
        let rtspUrl = '';

        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword,
                MediaProfileToken: mediaProfileToken
            };

            const serviceResponse = await this.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetRTSPStreamURI',
                requestParams);

            rtspUrl = serviceResponse.status === 200 ? serviceResponse.payload : '';
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `An error occurred while getting onvif stream uri from device id: ${this.cameraInfo.cameraId}`);
        }

        return rtspUrl;
    }

    protected async onHandleDeviceProperties(desiredChangedSettings: any): Promise<void> {
        try {
            this.server.log([this.cameraInfo.cameraId, 'info'], `onHandleDeviceProperties`);
            if (this.debugTelemetry()) {
                this.server.log([this.cameraInfo.cameraId, 'info'], JSON.stringify(desiredChangedSettings, null, 4));
            }

            const patchedProperties = {};

            for (const setting in desiredChangedSettings) {
                if (!Object.prototype.hasOwnProperty.call(desiredChangedSettings, setting)) {
                    continue;
                }

                if (setting === '$version') {
                    continue;
                }

                const value = Object.prototype.hasOwnProperty.call(desiredChangedSettings[setting], 'value')
                    ? desiredChangedSettings[setting].value
                    : desiredChangedSettings[setting];

                switch (setting) {
                    case OnvifCameraCapability.wpVideoPlaybackHost:
                        patchedProperties[setting] = {
                            value: (this.onvifCameraSettings[setting] as any) = value || defaultVideoPlaybackHost,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    case AvaEdgeOperationsCapability.wpMaxVideoInferenceTime:
                        patchedProperties[setting] = {
                            value: (this.avaEdgeOperationsSettings[setting] as any) = value || defaultMaxVideoInferenceTime,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    case AvaEdgeDiagnosticsCapability.wpDebugTelemetry:
                        patchedProperties[setting] = {
                            value: (this.avaEdgeDiagnosticsSettings[setting] as any) = value || false,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    case AiInferenceCapability.wpInferenceTimeout:
                        patchedProperties[setting] = {
                            value: (this.aiInferenceSettings[setting] as any) = value || defaultInferenceTimeout,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    default:
                        break;
                }
            }

            if (!emptyObj(patchedProperties)) {
                await this.updateDeviceProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Exception while handling desired properties: ${ex.message}`);
        }
    }

    protected async updateDeviceProperties(properties: any): Promise<void> {
        if (!properties || !this.deviceTwin) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.deviceTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve('');
                });
            });

            if (this.debugTelemetry()) {
                this.server.log([this.cameraInfo.cameraId, 'info'], `Device live properties updated: ${JSON.stringify(properties, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Error while updating client properties: ${ex.message}`);
        }
    }

    protected async sendMeasurement(data: any): Promise<void> {
        if (!data || !this.deviceClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            await this.deviceClient.sendEvent(iotcMessage);

            if (this.debugTelemetry()) {
                this.server.log([this.cameraInfo.cameraId, 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `sendMeasurement: ${ex.message}`);
            this.server.log([this.cameraInfo.cameraId, 'error'], `inspect the error: ${JSON.stringify(ex, null, 4)}`);
        }
    }

    private async startAvaProcessingInternal(pipelineInstanceName: string, mediaProfileToken: string): Promise<boolean> {
        const pipelineInstance = await this.server.settings.app.blobStorage.getFileFromBlobStorage(`${pipelineInstanceName}.json`);
        if (!pipelineInstance) {
            this.server.log(['ModuleService', 'error'], `Could not retrieve ${pipelineInstanceName} instance configuration`);
        }

        this.server.log(['ModuleService', 'info'], `Successfully downloaded ${pipelineInstanceName} instance configuration`);

        const rtspUrl = await this.getRtspStreamUrl(mediaProfileToken);

        const startAvaPipelineResult = await this.avaPipeline.startAvaPipeline(pipelineInstance, {
            rtspUrl,
            ...this.setPipelineParams()
        });

        if (this.debugTelemetry()) {
            this.server.log([this.cameraInfo.cameraId, 'info'], `Pipeline Instance Name: ${JSON.stringify(this.avaPipeline.instanceName, null, 4)}`);
            this.server.log([this.cameraInfo.cameraId, 'info'], `Pipeline Instance: ${JSON.stringify(this.avaPipeline.instanceName, null, 4)}`);
            this.server.log([this.cameraInfo.cameraId, 'info'], `Pipeline Topology Name: ${JSON.stringify(this.avaPipeline.instanceName, null, 4)}`);
            this.server.log([this.cameraInfo.cameraId, 'info'], `Pipeline Topology: ${JSON.stringify(this.avaPipeline.instanceName, null, 4)}`);
        }

        await this.sendMeasurement({
            [OnvifCameraCapability.stCameraState]: startAvaPipelineResult === true ? CameraState.Active : CameraState.Inactive
        });

        return startAvaPipelineResult;
    }

    private async stopAvaProcessingInternal(): Promise<boolean> {
        clearInterval(this.inferenceInterval);
        this.inferenceInterval = null;

        return this.avaPipeline.stopAvaPipeline();
    }

    private async inferenceTimer(): Promise<void> {
        try {
            if (this.debugTelemetry()) {
                this.server.log([this.cameraInfo.cameraId, 'info'], `Inference timer`);
            }

            const videoInferenceDuration = moment.duration(moment.utc().diff(this.videoInferenceStartTime));

            if (moment.duration(moment.utc().diff(this.lastInferenceTime)) >= moment.duration(this.aiInferenceSettings[AiInferenceCapability.wpInferenceTimeout], 'seconds')) {
                if (this.createVideoLinkForInferenceTimeout) {
                    this.createVideoLinkForInferenceTimeout = false;

                    this.server.log([this.cameraInfo.cameraId, 'info'], `InferenceTimeout reached`);

                    await this.sendMeasurement({
                        [AiInferenceCapability.evInferenceEventVideoUrl]: this.avaPipeline.createInferenceVideoLink(
                            this.onvifCameraSettings[OnvifCameraCapability.wpVideoPlaybackHost],
                            this.videoInferenceStartTime,
                            Math.trunc(videoInferenceDuration.asSeconds()))
                    });
                }

                this.videoInferenceStartTime = moment.utc();
            }
            else {
                this.createVideoLinkForInferenceTimeout = true;

                if (videoInferenceDuration >= moment.duration(this.avaEdgeOperationsSettings[AvaEdgeOperationsCapability.wpMaxVideoInferenceTime], 'seconds')) {
                    this.server.log([this.cameraInfo.cameraId, 'info'], `MaxVideoInferenceTime reached`);

                    await this.sendMeasurement({
                        [AiInferenceCapability.evInferenceEventVideoUrl]: this.avaPipeline.createInferenceVideoLink(
                            this.onvifCameraSettings[OnvifCameraCapability.wpVideoPlaybackHost],
                            this.videoInferenceStartTime,
                            Math.trunc(videoInferenceDuration.asSeconds()))
                    });

                    this.videoInferenceStartTime = moment.utc();
                }
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Inference timer error: ${ex.message}`);
        }
    }

    private async connectDeviceClientInternal(
        dpsHubConnectionString: string,
        devicePropertiesHandler: DevicePropertiesHandler): Promise<IClientConnectResult> {

        const result: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        if (this.deviceClient) {
            if (this.deviceTwin) {
                this.deviceTwin.removeAllListeners();
            }

            if (this.deviceClient) {
                this.deviceTwin.removeAllListeners();

                await this.deviceClient.close();
            }

            this.deviceClient = null;
            this.deviceTwin = null;
        }

        try {
            this.deviceClient = await IoTDeviceClient.fromConnectionString(dpsHubConnectionString, IoTHubTransport);
            if (!this.deviceClient) {
                result.clientConnectionStatus = false;
                result.clientConnectionMessage = `Failed to connect device client interface from connection string - device: ${this.cameraInfo.cameraId}`;
            }
            else {
                result.clientConnectionStatus = true;
                result.clientConnectionMessage = `Successfully connected to IoT Central - device: ${this.cameraInfo.cameraId}`;
            }
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `Failed to instantiate client interface from configuraiton: ${ex.message}`;

            this.server.log([this.cameraInfo.cameraId, 'error'], `${result.clientConnectionMessage}`);
        }

        if (result.clientConnectionStatus === false) {
            return result;
        }

        try {
            this.deviceClient.on('connect', this.onDeviceClientConnect);
            this.deviceClient.on('disconnect', this.onDeviceClientDisconnect);
            this.deviceClient.on('error', this.onDeviceClientError);

            await this.deviceClient.open();

            this.server.log([this.cameraInfo.cameraId, 'info'], `Device client is connected`);

            this.deviceTwin = await this.deviceClient.getTwin();
            this.deviceTwin.on('properties.desired', devicePropertiesHandler);

            this.deviceClient.onDeviceMethod(AvaEdgeOperationsCapability.cmStartAvaProcessing, this.startAvaProcessingDirectMethod);
            this.deviceClient.onDeviceMethod(AvaEdgeOperationsCapability.cmStopAvaProcessing, this.stopAvaProcessingDirectMethod);
            this.deviceClient.onDeviceMethod(OnvifCameraCapability.cmCaptureImage, this.captureImageDirectMethod);
            this.deviceClient.onDeviceMethod(OnvifCameraCapability.cmRestartCamera, this.restartCameraDirectMethod);

            result.clientConnectionStatus = true;
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `IoT Central connection error: ${ex.message}`;

            this.server.log([this.cameraInfo.cameraId, 'error'], result.clientConnectionMessage);
        }

        return result;
    }

    @bind
    private onDeviceClientConnect() {
        this.server.log([this.cameraInfo.cameraId, 'info'], `The module received a connect event`);
    }

    @bind
    private onDeviceClientDisconnect() {
        this.server.log([this.cameraInfo.cameraId, 'info'], `The module received a disconnect event`);
    }

    @bind
    private onDeviceClientError(error: Error) {
        this.deviceClient = null;
        this.deviceTwin = null;

        this.server.log([this.cameraInfo.cameraId, 'error'], `Device client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    private async captureImage(mediaProfileToken: string): Promise<boolean> {
        let result = true;

        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword,
                MediaProfileToken: mediaProfileToken
            };

            this.server.log([this.cameraInfo.cameraId, 'info'], `Starting onvif image capture...`);

            const captureImageResult = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetSnapshot',
                requestParams);

            let blobUrl;

            if (captureImageResult.status >= 200 && captureImageResult.status < 300) {
                this.server.log([this.cameraInfo.cameraId, 'info'], `Image capture complete, uploading image data to blob storage...`);

                blobUrl = await this.blobStore.uploadBase64ImageToContainer(captureImageResult.payload as string);

                this.server.log([this.cameraInfo.cameraId, 'info'], `Blob store image transfer complete`);
            }

            if (blobUrl) {
                await this.sendMeasurement({
                    [OnvifCameraCapability.evUploadImage]: blobUrl
                });

                await this.updateDeviceProperties({
                    [OnvifCameraCapability.rpCaptureImageUrl]: blobUrl
                });
            }
            else {
                this.server.log([this.cameraInfo.cameraId, 'error'], `An error occurred while uploading the captured image to the blob storage service`);
                result = false;
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `An error occurred while attempting to capture an image on device: ${this.cameraInfo.cameraId}: ${ex.message}`);
            result = false;
        }

        return result;
    }

    private async restartCamera(): Promise<boolean> {
        let result = true;

        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword
            };

            const restartResult = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'Reboot',
                requestParams);

            if (restartResult.status >= 200 && restartResult.status < 300) {
                this.server.log([this.cameraInfo.cameraId, 'info'], `Camera restart command completed`);
            }
            else {
                this.server.log([this.cameraInfo.cameraId, 'error'], `An error occurred while attempting to restart the camera device`);
                result = false;
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Error while attempting to restart camera (${this.cameraInfo.cameraId}): ${ex.message}`);
            result = false;
        }

        return result;
    }

    @bind
    // @ts-ignore
    private async startAvaProcessingDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([this.cameraInfo.cameraId, 'info'], `${AvaEdgeOperationsCapability.cmStartAvaProcessing} command received`);

        const startAvaProcessingResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };

        const pipelineInstanceName = commandRequest?.payload?.[StartAvaProcessingCommandRequestParams.AvaPipelineInstanceName];
        const mediaProfileToken = commandRequest?.payload?.[StartAvaProcessingCommandRequestParams.MediaProfileToken];

        try {
            if (!pipelineInstanceName || !mediaProfileToken) {
                const errorMessage = `Missing required parameters for command ${AvaEdgeOperationsCapability.cmStartAvaProcessing}`;

                this.server.log([this.cameraInfo.cameraId, 'error'], errorMessage);
                await commandResponse.send(200, {
                    [CommandResponseParams.StatusCode]: 400,
                    [CommandResponseParams.Message]: errorMessage,
                    [CommandResponseParams.Data]: ''
                });

                return;
            }

            const startAvaPipelineResult = await this.startAvaProcessingInternal(pipelineInstanceName, mediaProfileToken);

            if (startAvaPipelineResult) {
                startAvaProcessingResponse[CommandResponseParams.Message] = `AVA edge processing started`;
            }
            else {
                startAvaProcessingResponse[CommandResponseParams.StatusCode] = 500;
                startAvaProcessingResponse[CommandResponseParams.Message] = `AVA edge processing failed to start`;
            }

            this.server.log([this.cameraInfo.cameraId, 'info'], startAvaProcessingResponse[CommandResponseParams.Message]);

            if (startAvaPipelineResult) {
                this.lastInferenceTime = moment.utc(0);
                this.videoInferenceStartTime = moment.utc();
                this.createVideoLinkForInferenceTimeout = false;

                this.inferenceInterval = setInterval(async () => {
                    await this.inferenceTimer();
                }, 1000);
            }
        }
        catch (ex) {
            startAvaProcessingResponse[CommandResponseParams.StatusCode] = 500;
            startAvaProcessingResponse[CommandResponseParams.Message] = `Error while trying to start AVA processing: ${ex.message}`;

            this.server.log([this.cameraInfo.cameraId, 'error'], startAvaProcessingResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, startAvaProcessingResponse);
    }

    @bind
    // @ts-ignore
    private async stopAvaProcessingDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([this.cameraInfo.cameraId, 'info'], `${AvaEdgeOperationsCapability.cmStopAvaProcessing} command received`);

        const stopAvaProcessingResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };

        try {
            const stopAvaProcessingResult = await this.stopAvaProcessingInternal();
            if (stopAvaProcessingResult) {
                stopAvaProcessingResponse[CommandResponseParams.Message] = `AVA edge processing successfully stopped`;

                await this.sendMeasurement({
                    [OnvifCameraCapability.stCameraState]: CameraState.Inactive
                });
            }
            else {
                stopAvaProcessingResponse[CommandResponseParams.StatusCode] = 500;
                stopAvaProcessingResponse[CommandResponseParams.Message] = `AVA edge processing failed to stop`;
            }

            this.server.log([this.cameraInfo.cameraId, 'info'], stopAvaProcessingResponse[CommandResponseParams.Message]);
        }
        catch (ex) {
            stopAvaProcessingResponse[CommandResponseParams.StatusCode] = 500;
            stopAvaProcessingResponse[CommandResponseParams.Message] = `Error while trying to stop AVA processing: ${ex.message}`;

            this.server.log([this.cameraInfo.cameraId, 'error'], stopAvaProcessingResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, stopAvaProcessingResponse);
    }

    @bind
    // @ts-ignore (commandRequest)
    private async captureImageDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([this.cameraInfo.cameraId, 'info'], `Received device command: ${OnvifCameraCapability.cmCaptureImage}`);

        const captureImageResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };

        const mediaProfileToken = commandRequest?.payload?.[CaptureImageCommandRequestParams.MediaProfileToken];

        try {
            if (!mediaProfileToken) {
                const errorMessage = `Missing required parameters for command ${OnvifCameraCapability.cmCaptureImage}`;

                this.server.log([this.cameraInfo.cameraId, 'error'], errorMessage);
                await commandResponse.send(200, {
                    [CommandResponseParams.StatusCode]: 400,
                    [CommandResponseParams.Message]: errorMessage,
                    [CommandResponseParams.Data]: ''
                });

                return;
            }

            const captureImageResult = await this.captureImage(mediaProfileToken);

            if (captureImageResult) {
                captureImageResponse[CommandResponseParams.Message] = `Image capture completed successfully`;
            }
            else {
                captureImageResponse[CommandResponseParams.StatusCode] = 500;
                captureImageResponse[CommandResponseParams.Message] = `An error occurred while capturing camera image`;
            }

            this.server.log(['IoTCentralService', 'info'], captureImageResponse[CommandResponseParams.Message]);
        }
        catch (ex) {
            captureImageResponse[CommandResponseParams.StatusCode] = 500;
            captureImageResponse[CommandResponseParams.Message] = `An error occurred while capturing camera image: ${ex.message}`;

            this.server.log(['IoTCentralService', 'error'], captureImageResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, captureImageResponse);
    }

    @bind
    // @ts-ignore (commandRequest)
    private async restartCameraDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([this.cameraInfo.cameraId, 'info'], `Received device command: ${OnvifCameraCapability.cmRestartCamera}`);

        const restartCameraResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };

        try {
            await this.stopAvaProcessingInternal();

            const restartCameraResult = await this.restartCamera();

            if (restartCameraResult) {
                restartCameraResponse[CommandResponseParams.Message] = `Camera restart command completed`;
            }
            else {
                restartCameraResponse[CommandResponseParams.StatusCode] = 500;
                restartCameraResponse[CommandResponseParams.Message] = `An error occurred while attempting to restart the camera device`;
            }

            this.server.log(['IoTCentralService', 'info'], restartCameraResponse[CommandResponseParams.Message]);
        }
        catch (ex) {
            restartCameraResponse[CommandResponseParams.StatusCode] = 500;
            restartCameraResponse[CommandResponseParams.Message] = `Error while attempting to restart camera: ${ex.message}`;

            this.server.log(['IoTCentralService', 'error'], restartCameraResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, restartCameraResponse);
    }
}
