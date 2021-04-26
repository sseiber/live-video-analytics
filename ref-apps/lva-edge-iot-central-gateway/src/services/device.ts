import { Server } from '@hapi/hapi';
import { IIotCentralModule } from '../plugins/iotCentralModule';
import {
    IPipelinePackage,
    AvaPipeline
} from './avaPipeline';
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

enum OnvifMediaProfile {
    MediaProfile1 = 'mediaprofile1',
    MediaProfile2 = 'mediaprofile2'
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
    rpIpAddress = 'rpIpAddress',
    rpOnvifUsername = 'rpOnvifUsername',
    rpOnvifPassword = 'rpOnvifPassword',
    rpAvaPipelineName = 'rpAvaPipelineName',
    rpMediaProfile1 = 'rpMediaProfile1',
    rpMediaProfile2 = 'rpMediaProfile2',
    wpOnvifMediaProfileSelector = 'wpOnvifMediaProfileSelector',
    wpVideoPlaybackHost = 'wpVideoPlaybackHost',
    cmCaptureImage = 'cmCaptureImage',
    cmRestartCamera = 'cmRestartCamera'
}

interface IOnvifCameraSettings {
    mediaProfiles: IMediaProfileInfo[];
    [OnvifCameraCapability.wpOnvifMediaProfileSelector]: string;
    [OnvifCameraCapability.wpVideoPlaybackHost]: string;
}

const defaultVideoPlaybackHost = 'http://localhost:8094';
const defaultInferenceTimeout = 5;
const defaultMaxVideoInferenceTime = 10;

enum AvaEdgeOperationsCapability {
    evPipelineInstanceCreated = 'evPipelineInstanceCreated',
    evPipelineInstanceDeleted = 'evPipelineInstanceDeleted',
    evPipelineInstanceStarted = 'evPipelineInstanceStarted',
    evPipelineInstanceStopped = 'evPipelineInstanceStopped',
    evRecordingStarted = 'evRecordingStarted',
    evRecordingStopped = 'evRecordingStopped',
    evRecordingAvailable = 'evRecordingAvailable',
    evStartAvaPipelineCommandReceived = 'evStartAvaPipelineCommandReceived',
    evStopAvaPipelineCommandReceived = 'evStopAvaPipelineCommandReceived',
    wpAutoStart = 'wpAutoStart',
    wpMaxVideoInferenceTime = 'wpMaxVideoInferenceTime',
    cmStartAvaProcessing = 'cmStartAvaProcessing',
    cmStopAvaProcessing = 'cmStopAvaProcessing'
}

interface IAvaEdgeOperationsSettings {
    [AvaEdgeOperationsCapability.wpAutoStart]: boolean;
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
    tlInferenceCount = 'tlInferenceCount',
    tlInference = 'tlInference',
    evInferenceEventVideoUrl = 'evInferenceEventVideoUrl',
    rpInferenceVideoUrl = 'rpInferenceVideoUrl',
    rpInferenceImageUrl = 'rpInferenceImageUrl',
    wpInferenceTimeout = 'wpInferenceTimeout'
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
    protected pipelinePackage: IPipelinePackage;
    protected avaPipeline: AvaPipeline;
    protected cameraInfo: ICameraDeviceProvisionInfo;
    protected deviceClient: IoTDeviceClient;
    protected deviceTwin: Twin;

    protected deferredStart = defer();
    protected healthState = HealthState.Good;
    protected lastInferenceTime: moment.Moment = moment.utc(0);
    protected videoInferenceStartTime: moment.Moment = moment.utc();
    protected onvifCameraSettings: IOnvifCameraSettings = {
        mediaProfiles: [],
        wpOnvifMediaProfileSelector: OnvifMediaProfile.MediaProfile1,
        wpVideoPlaybackHost: defaultVideoPlaybackHost
    };
    protected avaEdgeOperationsSettings: IAvaEdgeOperationsSettings = {
        [AvaEdgeOperationsCapability.wpAutoStart]: false,
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

    constructor(server: Server, onvifModuleId: string, avaEdgeModuleId: string, appScopeId: string, pipelinePackage: IPipelinePackage, cameraInfo: ICameraDeviceProvisionInfo) {
        this.server = server;
        this.iotCentralModule = server.settings.app.iotCentralModule;
        this.onvifModuleId = onvifModuleId;
        this.avaEdgeModuleId = avaEdgeModuleId;
        this.appScopeId = appScopeId;
        this.pipelinePackage = pipelinePackage;
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
            this.avaPipeline = new AvaPipeline(this.server, this.avaEdgeModuleId, this.cameraInfo, this.pipelinePackage);

            clientConnectionResult = await this.connectDeviceClientInternal(dpsHubConnectionString, this.onHandleDeviceProperties);

            if (clientConnectionResult.clientConnectionStatus === true) {
                await this.deferredStart.promise;

                await this.deviceReady();

                await this.sendMeasurement({
                    [OnvifCameraCapability.stIoTCentralClientState]: IoTCentralClientState.Connected,
                    [OnvifCameraCapability.stCameraState]: CameraState.Inactive
                });
            }

            if (this.avaEdgeOperationsSettings[AvaEdgeOperationsCapability.wpAutoStart] === true) {
                try {
                    await this.startAvaProcessingInternal(true);
                }
                catch (ex) {
                    this.server.log([this.cameraInfo.cameraId, 'error'], `Error while trying to auto-start AVA pipeline: ${ex.message}`);
                }
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
            this.server.log([this.cameraInfo.cameraId, 'info'], `Deactiving pipeline instance: ${this.avaPipeline.getInstanceName()}`);

            await this.avaPipeline.deleteAvaPipeline();

            this.deviceTwin?.removeAllListeners();
            this.deviceClient.removeAllListeners();

            await this.deviceClient.close();

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

            case 'Microsoft.Media.Edge.Diagnostics.RuntimeError':
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

            this.onvifCameraSettings.mediaProfiles = (mediaProfileResult.payload || []).map((profile) => {
                return {
                    mediaProfileName: profile.MediaProfileName,
                    mediaProfileToken: profile.MediaProfileToken
                };
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

    protected async getRtspStreamUrl(): Promise<string> {
        let rtspUrl = '';

        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword,
                MediaProfileToken: this.onvifCameraSettings.mediaProfiles[this.onvifCameraSettings.wpOnvifMediaProfileSelector === OnvifMediaProfile.MediaProfile1 ? 0 : 1].mediaProfileToken
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
                    case OnvifCameraCapability.wpOnvifMediaProfileSelector:
                        patchedProperties[setting] = (this.onvifCameraSettings[setting] as any) = value || OnvifMediaProfile.MediaProfile1;
                        break;

                    case OnvifCameraCapability.wpVideoPlaybackHost:
                        patchedProperties[setting] = (this.onvifCameraSettings[setting] as any) = value || defaultVideoPlaybackHost;
                        break;

                    case AvaEdgeOperationsCapability.wpAutoStart:
                        patchedProperties[setting] = (this.avaEdgeOperationsSettings[setting] as any) = value || false;
                        break;

                    case AvaEdgeOperationsCapability.wpMaxVideoInferenceTime:
                        patchedProperties[setting] = (this.avaEdgeOperationsSettings[setting] as any) = value || defaultMaxVideoInferenceTime;
                        break;

                    case AvaEdgeDiagnosticsCapability.wpDebugTelemetry:
                        patchedProperties[setting] = (this.avaEdgeDiagnosticsSettings[setting] as any) = value || false;
                        break;

                    case AiInferenceCapability.wpInferenceTimeout:
                        patchedProperties[setting] = (this.aiInferenceSettings[setting] as any) = value || defaultInferenceTimeout;
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

            // TODO:
            // Detect DPS/Hub reprovisioning scenarios - sample exeption:
            //
            // [12:41:54 GMT+0000], [log,[this.cameraInfo.cameraId, error]] data: inspect the error: {
            //     "name": "UnauthorizedError",
            //     "transportError": {
            //         "name": "NotConnectedError",
            //         "transportError": {
            //             "code": 5
            //         }
            //     }
            // }
        }
    }

    private async startAvaProcessingInternal(autoStart: boolean): Promise<boolean> {
        await this.sendMeasurement({
            [AvaEdgeOperationsCapability.evStartAvaPipelineCommandReceived]: autoStart ? 'AutoStart' : 'Command'
        });

        const rtspUrl = await this.getRtspStreamUrl();

        const startAvaPipelineResult = await this.avaPipeline.startAvaPipeline({
            rtspUrl,
            ...this.setPipelineParams()
        });

        if (this.debugTelemetry()) {
            this.server.log([this.cameraInfo.cameraId, 'info'], `Pipeline Instance Name: ${JSON.stringify(this.avaPipeline.getInstanceName(), null, 4)}`);
            this.server.log([this.cameraInfo.cameraId, 'info'], `Pipeline Instance: ${JSON.stringify(this.avaPipeline.getInstance(), null, 4)}`);
            this.server.log([this.cameraInfo.cameraId, 'info'], `Pipeline Topology Name: ${JSON.stringify(this.avaPipeline.getInstanceName(), null, 4)}`);
            this.server.log([this.cameraInfo.cameraId, 'info'], `Pipeline Topology: ${JSON.stringify(this.avaPipeline.getTopology(), null, 4)}`);
        }

        await this.sendMeasurement({
            [OnvifCameraCapability.stCameraState]: startAvaPipelineResult === true ? CameraState.Active : CameraState.Inactive
        });

        return startAvaPipelineResult;
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

                    // await this.updateDeviceProperties({
                    //     // eslint-disable-next-line max-len
                    //     [AiInferenceCapability.rpInferenceImageUrl]: ''
                    // });
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
            this.deviceTwin?.removeAllListeners();
            this.deviceTwin.removeAllListeners();

            await this.deviceClient.close();

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
            await this.deviceClient.open();

            this.server.log([this.cameraInfo.cameraId, 'info'], `Device client is connected`);

            this.deviceTwin = await this.deviceClient.getTwin();
            this.deviceTwin.on('properties.desired', devicePropertiesHandler);

            this.deviceClient.on('error', this.onDeviceClientError);

            this.deviceClient.onDeviceMethod(AvaEdgeOperationsCapability.cmStartAvaProcessing, this.startAvaProcessingDirectMethod);
            this.deviceClient.onDeviceMethod(AvaEdgeOperationsCapability.cmStopAvaProcessing, this.stopAvaProcessingDirectMethod);

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
    private onDeviceClientError(error: Error) {
        this.server.log([this.cameraInfo.cameraId, 'error'], `Device client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    @bind
    // @ts-ignore
    private async startAvaProcessingDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([this.cameraInfo.cameraId, 'info'], `${AvaEdgeOperationsCapability.cmStartAvaProcessing} command received`);

        try {
            const startAvaPipelineResult = await this.startAvaProcessingInternal(false);

            const responseMessage = `AVA Edge start pipeline request: ${startAvaPipelineResult ? 'succeeded' : 'failed'}`;
            this.server.log([this.cameraInfo.cameraId, 'info'], responseMessage);

            await commandResponse.send(200, {
                message: responseMessage
            });

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
            this.server.log([this.cameraInfo.cameraId, 'error'], `startAvaProcessing error: ${ex.message}`);
        }
    }

    @bind
    // @ts-ignore
    private async stopAvaProcessingDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([this.cameraInfo.cameraId, 'info'], `${AvaEdgeOperationsCapability.cmStopAvaProcessing} command received`);

        try {
            clearInterval(this.inferenceInterval);
            this.inferenceInterval = null;

            await this.sendMeasurement({
                [AvaEdgeOperationsCapability.evStopAvaPipelineCommandReceived]: this.cameraInfo.cameraId
            });

            const stopAvaPipelineResult = await this.avaPipeline.stopAvaPipeline();
            if (stopAvaPipelineResult) {
                await this.sendMeasurement({
                    [OnvifCameraCapability.stCameraState]: CameraState.Inactive
                });
            }

            const responseMessage = `AVA Edge stop pipeline request: ${stopAvaPipelineResult ? 'succeeded' : 'failed'}`;
            this.server.log([this.cameraInfo.cameraId, 'info'], responseMessage);

            await commandResponse.send(200, {
                message: responseMessage
            });
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Stop AVA error ${ex.message}`);
        }
    }
}
