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
import { IIoTCentralModule } from '../plugins/iotCentral';
import {
    IEnvConfig,
    ICameraDeviceProvisionInfo
} from './cameraGateway';
import { AvaPipeline } from './avaPipeline';
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
    wpOnvifMediaProfile = 'wpOnvifMediaProfile',
    wpVideoPlaybackHost = 'wpVideoPlaybackHost',
    cmCaptureImage = 'cmCaptureImage',
    cmRestartCamera = 'cmRestartCamera'
}

interface IOnvifCameraSettings {
    [OnvifCameraCapability.wpOnvifMediaProfile]: string;
    [OnvifCameraCapability.wpVideoPlaybackHost]: string;
}

const defaultVideoPlaybackHost = 'http://localhost:8094';
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

const defaultInferenceTimeout = 5;

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
    protected iotCentralModule: IIoTCentralModule;
    protected envConfig: IEnvConfig;
    protected avaPipeline: AvaPipeline;
    protected cameraInfo: ICameraDeviceProvisionInfo;
    protected deviceClient: IoTDeviceClient;
    protected deviceTwin: Twin;

    protected deferredStart = defer();
    protected healthState = HealthState.Good;
    protected lastInferenceTime: moment.Moment = moment.utc(0);
    protected videoInferenceStartTime: moment.Moment = moment.utc();
    protected onvifCameraSettings: IOnvifCameraSettings = {
        wpOnvifMediaProfile: OnvifMediaProfile.MediaProfile1,
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

    constructor(iotCentralModule: IIoTCentralModule, avaPipeline: AvaPipeline, cameraInfo: ICameraDeviceProvisionInfo) {
        this.iotCentralModule = iotCentralModule;
        this.envConfig = iotCentralModule.getAppConfig().env;
        this.avaPipeline = avaPipeline;
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
                    this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Error while trying to auto-start AVA pipeline: ${ex.message}`);
                }
            }
        }
        catch (ex) {
            clientConnectionResult.clientConnectionStatus = false;
            clientConnectionResult.clientConnectionMessage = `An error occurred while accessing the device twin properties`;

            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], clientConnectionResult.clientConnectionMessage);
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
        this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `Deleting camera device instance for cameraId: ${this.cameraInfo.cameraId}`);

        try {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `Deactiving pipeline instance: ${this.avaPipeline.getInstanceName()}`);

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
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Error while deleting camera: ${this.cameraInfo.cameraId}`);
        }
    }

    public async sendAvaEvent(avaEvent: string, messageJson?: any): Promise<void> {
        let eventField;
        let eventValue = this.cameraInfo.cameraId;

        switch (avaEvent) {
            case 'Microsoft.Media.Graph.Operational.RecordingStarted':
                eventField = AvaEdgeOperationsCapability.evRecordingStarted;
                eventValue = messageJson?.outputLocation || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Operational.RecordingStopped':
                eventField = AvaEdgeOperationsCapability.evRecordingStopped;
                eventValue = messageJson?.outputLocation || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Operational.RecordingAvailable':
                eventField = AvaEdgeOperationsCapability.evRecordingAvailable;
                eventValue = messageJson?.outputLocation || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Edge.Diagnostics.RuntimeError':
                eventField = AvaEdgeDiagnosticsCapability.evRuntimeError;
                eventValue = messageJson?.code || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.AuthenticationError':
                eventField = AvaEdgeDiagnosticsCapability.evAuthenticationError;
                eventValue = messageJson?.errorCode || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.AuthorizationError':
                eventField = AvaEdgeDiagnosticsCapability.evAuthorizationError;
                eventValue = messageJson?.errorCode || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.DataDropped':
                eventField = AvaEdgeDiagnosticsCapability.evDataDropped;
                eventValue = messageJson?.dataType || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.MediaFormatError':
                eventField = AvaEdgeDiagnosticsCapability.evMediaFormatError;
                eventValue = messageJson?.code || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.MediaSessionEstablished':
                eventField = AvaEdgeDiagnosticsCapability.evMediaSessionEstablished;
                eventValue = this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.NetworkError':
                eventField = AvaEdgeDiagnosticsCapability.evNetworkError;
                eventValue = messageJson?.errorCode || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.ProtocolError':
                eventField = AvaEdgeDiagnosticsCapability.evProtocolError;
                eventValue = `${messageJson?.protocol}: ${messageJson?.errorCode}` || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.StorageError':
                eventField = AvaEdgeDiagnosticsCapability.evStorageError;
                eventValue = messageJson?.storageAccountName || this.cameraInfo.cameraId;
                break;

            default:
                this.iotCentralModule.logger([this.cameraInfo.cameraId, 'warning'], `Received Unknown AVA event telemetry: ${avaEvent}`);
                break;
        }

        if (avaEvent) {
            await this.sendMeasurement({
                [eventField]: eventValue
            });
        }
        else {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'warning'], `Received Unknown AVA event telemetry: ${avaEvent}`);
        }
    }

    protected debugTelemetry(): boolean {
        return this.avaEdgeDiagnosticsSettings[AvaEdgeDiagnosticsCapability.wpDebugTelemetry];
    }

    protected async getCameraProps(): Promise<IOnvifCameraInformation> {
        try {
            let deviceInfoResult = await this.iotCentralModule.invokeDirectMethod(
                this.envConfig.onvifModuleId,
                'GetDeviceInformation',
                {
                    Address: this.cameraInfo.ipAddress,
                    Username: this.cameraInfo.onvifUsername,
                    Password: this.cameraInfo.onvifPassword
                });

            const cameraProps = {
                rpManufacturer: deviceInfoResult.payload?.Manufacturer || '',
                rpModel: deviceInfoResult.payload?.Model || '',
                rpFirmwareVersion: deviceInfoResult.payload?.Firmware || '',
                rpHardwareId: deviceInfoResult.payload?.HardwareId || '',
                rpSerialNumber: deviceInfoResult.payload?.SerialNumber || ''
            };

            deviceInfoResult = await this.iotCentralModule.invokeDirectMethod(
                this.envConfig.onvifModuleId,
                'GetMediaProfileList',
                {
                    Address: this.cameraInfo.ipAddress,
                    Username: this.cameraInfo.onvifUsername,
                    Password: this.cameraInfo.onvifPassword
                });

            const mediaProfile1 = {
                mediaProfileName: deviceInfoResult.payload[0]?.MediaProfileName || '',
                mediaProfileToken: deviceInfoResult.payload[0]?.MediaProfileToken || ''
            };

            const mediaProfile2 = {
                mediaProfileName: deviceInfoResult.payload[1]?.MediaProfileName || '',
                mediaProfileToken: deviceInfoResult.payload[1]?.MediaProfileToken || ''
            };

            return {
                ...cameraProps,
                rpMediaProfile1: {
                    ...mediaProfile1
                },
                rpMediaProfile2: {
                    ...mediaProfile2
                }
            };
        }
        catch (ex) {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Error getting onvif device properties: ${ex.message}`);
        }

        return;
    }

    protected async onHandleDeviceProperties(desiredChangedSettings: any): Promise<void> {
        this.iotCentralModule.logger([this.cameraInfo.cameraId, '#####'], `onHandleDeviceProperties BASE`);

        try {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `onHandleDeviceProperties`);
            if (this.iotCentralModule.debugTelemetry()) {
                this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], JSON.stringify(desiredChangedSettings, null, 4));
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
                    case OnvifCameraCapability.wpOnvifMediaProfile:
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
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Exception while handling desired properties: ${ex.message}`);
        }
    }

    // protected async onHandleDevicePropertiesInternal(desiredChangedSettings: any): Promise<void> {
    //     try {
    //         this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `onHandleDeviceProperties`);
    //         if (this.iotCentralModule.debugTelemetry()) {
    //             this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], JSON.stringify(desiredChangedSettings, null, 4));
    //         }

    //         const patchedProperties = {};

    //         for (const setting in desiredChangedSettings) {
    //             if (!Object.prototype.hasOwnProperty.call(desiredChangedSettings, setting)) {
    //                 continue;
    //             }

    //             if (setting === '$version') {
    //                 continue;
    //             }

    //             const value = Object.prototype.hasOwnProperty.call(desiredChangedSettings[setting], 'value')
    //                 ? desiredChangedSettings[setting].value
    //                 : desiredChangedSettings[setting];

    //             switch (setting) {
    //                 case OnvifCameraCapability.Setting.OnvifMediaProfile:
    //                     patchedProperties[setting] = (this.onvifCameraSettings[setting] as any) = value || MediaProfile.MediaProfile1;
    //                     break;

    //                 case OnvifCameraCapability.Setting.VideoPlaybackHost:
    //                     patchedProperties[setting] = (this.onvifCameraSettings[setting] as any) = value || defaultVideoPlaybackHost;
    //                     break;

    //                 case AvaEdgeOperationsCapability.wpAutoStart:
    //                     patchedProperties[setting] = (this.avaEdgeOperationsSettings[setting] as any) = value || false;
    //                     break;

    //                 case AvaEdgeOperationsCapability.wpMaxVideoInferenceTime:
    //                     patchedProperties[setting] = (this.avaEdgeOperationsSettings[setting] as any) = value || defaultMaxVideoInferenceTime;
    //                     break;

    //                 case AvaEdgeDiagnosticsCapability.wpDebugTelemetry:
    //                     patchedProperties[setting] = (this.avaEdgeDiagnosticsSettings[setting] as any) = value || false;
    //                     break;

    //                 case AiInferenceCapability.tlInferenceTimeout:
    //                     patchedProperties[setting] = (this.aiInferenceSettings[setting] as any) = value || defaultInferenceTimeout;
    //                     break;

    //                 default:
    //                     break;
    //             }
    //         }

    //         if (!emptyObj(patchedProperties)) {
    //             await this.updateDeviceProperties(patchedProperties);
    //         }
    //     }
    //     catch (ex) {
    //         this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Exception while handling desired properties: ${ex.message}`);
    //     }
    // }

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

            if (this.iotCentralModule.debugTelemetry()) {
                this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `Device live properties updated: ${JSON.stringify(properties, null, 4)}`);
            }
        }
        catch (ex) {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Error while updating client properties: ${ex.message}`);
        }
    }

    protected async sendMeasurement(data: any): Promise<void> {
        if (!data || !this.deviceClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            await this.deviceClient.sendEvent(iotcMessage);

            if (this.iotCentralModule.debugTelemetry()) {
                this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `sendMeasurement: ${ex.message}`);
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `inspect the error: ${JSON.stringify(ex, null, 4)}`);

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

    protected async startAvaProcessingInternal(autoStart: boolean): Promise<boolean> {
        await this.sendMeasurement({
            [AvaEdgeOperationsCapability.evStartAvaPipelineCommandReceived]: autoStart ? 'AutoStart' : 'Command'
        });

        const startAvaPipelineResult = await this.avaPipeline.startAvaPipeline(this.setPipelineParams());

        if (this.iotCentralModule.debugTelemetry()) {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `Pipeline Instance Name: ${JSON.stringify(this.avaPipeline.getInstanceName(), null, 4)}`);
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `Pipeline Instance: ${JSON.stringify(this.avaPipeline.getInstance(), null, 4)}`);
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `Pipeline Topology Name: ${JSON.stringify(this.avaPipeline.getInstanceName(), null, 4)}`);
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `Pipeline Topology: ${JSON.stringify(this.avaPipeline.getTopology(), null, 4)}`);
        }

        await this.sendMeasurement({
            [OnvifCameraCapability.stCameraState]: startAvaPipelineResult === true ? CameraState.Active : CameraState.Inactive
        });

        return startAvaPipelineResult;
    }

    private async inferenceTimer(): Promise<void> {
        try {
            if (this.iotCentralModule.debugTelemetry()) {
                this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `Inference timer`);
            }

            const videoInferenceDuration = moment.duration(moment.utc().diff(this.videoInferenceStartTime));

            if (moment.duration(moment.utc().diff(this.lastInferenceTime)) >= moment.duration(this.aiInferenceSettings[AiInferenceCapability.wpInferenceTimeout], 'seconds')) {
                if (this.createVideoLinkForInferenceTimeout) {
                    this.createVideoLinkForInferenceTimeout = false;

                    this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `InferenceTimeout reached`);

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
                    this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `MaxVideoInferenceTime reached`);

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
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Inference timer error: ${ex.message}`);
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

            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `${result.clientConnectionMessage}`);
        }

        if (result.clientConnectionStatus === false) {
            return result;
        }

        try {
            await this.deviceClient.open();

            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `Device client is connected`);

            this.deviceTwin = await this.deviceClient.getTwin();
            this.deviceTwin.on('properties.desired', devicePropertiesHandler);

            this.deviceClient.on('error', this.onDeviceClientError);

            this.deviceClient.onDeviceMethod(AvaEdgeOperationsCapability.cmStartAvaProcessing, this.startAvaProcessing);
            this.deviceClient.onDeviceMethod(AvaEdgeOperationsCapability.cmStopAvaProcessing, this.stopAvaProcessing);

            result.clientConnectionStatus = true;
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `IoT Central connection error: ${ex.message}`;

            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], result.clientConnectionMessage);
        }

        return result;
    }

    @bind
    private onDeviceClientError(error: Error) {
        this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Device client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    @bind
    // @ts-ignore
    private async startAvaProcessing(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `${AvaEdgeOperationsCapability.cmStartAvaProcessing} command received`);

        try {
            const startAvaPipelineResult = await this.startAvaProcessingInternal(false);

            const responseMessage = `AVA Edge start pipeline request: ${startAvaPipelineResult ? 'succeeded' : 'failed'}`;
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], responseMessage);

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
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `startAvaProcessing error: ${ex.message}`);
        }
    }

    @bind
    // @ts-ignore
    private async stopAvaProcessing(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `${AvaEdgeOperationsCapability.cmStopAvaProcessing} command received`);

        try {
            clearInterval(this.inferenceInterval);

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
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], responseMessage);

            await commandResponse.send(200, {
                message: responseMessage
            });
        }
        catch (ex) {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Stop AVA error ${ex.message}`);
        }
    }
}
