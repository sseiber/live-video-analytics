import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { StorageService } from './storage';
import { HealthState } from './health';
import { AmsGraph } from './amsGraph';
import { AmsCameraDevice, OnvifCameraCapability } from './device';
import { AmsMotionDetectorDevice } from './motionDetectorDevice';
import { AmsObjectDetectorDevice } from './objectDetectorDevice';
import { SymmetricKeySecurityClient } from 'azure-iot-security-symmetric-key';
import { ProvisioningDeviceClient } from 'azure-iot-provisioning-device';
import { Mqtt as ProvisioningTransport } from 'azure-iot-provisioning-device-mqtt';
import {
    Message as IoTMessage,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import {
    arch as osArch,
    platform as osPlatform,
    release as osRelease,
    cpus as osCpus,
    totalmem as osTotalMem,
    freemem as osFreeMem,
    loadavg as osLoadAvg
} from 'os';
import * as crypto from 'crypto';
import * as Wreck from '@hapi/wreck';
import { bind, emptyObj, forget } from '../utils';

const moduleName = 'CameraGatewayService';
const iotcOutput = 'iotc';

type DeviceOperation = 'DELETE_CAMERA' | 'SEND_EVENT' | 'SEND_INFERENCES';

export interface IEnvConfig {
    onvifModuleId: string;
    lvaEdgeModuleId: string;
    amsAccountName: string;
}

interface IAppConfig {
    system: {
        systemName: string;
        systemId: string;
    };
    device: {
        manufacturer: string;
        model: string;
        processorManufacturer: string;
        totalStorage: number;
    };
    iotCentral: {
        appHost: string;
        apiToken: string;
        deviceKey: string;
        scopeId: string;
    };
    env: IEnvConfig;
}

export interface ICameraDeviceProvisionInfo {
    cameraId: string;
    cameraName: string;
    ipAddress: string;
    onvifUsername: string;
    onvifPassword: string;
    detectionType: AddCameraDetectionType;
}

interface ICameraOperationInfo {
    cameraId: string;
    operationInfo: any;
}

interface IProvisionResult {
    dpsProvisionStatus: boolean;
    dpsProvisionMessage: string;
    dpsHubConnectionString: string;
    clientConnectionStatus: boolean;
    clientConnectionMessage: string;
    amsInferenceDevice: AmsCameraDevice;
}

interface IDeviceOperationResult {
    status: boolean;
    message: string;
}

interface ISystemProperties {
    cpuModel: string;
    cpuCores: number;
    cpuUsage: number;
    totalMemory: number;
    freeMemory: number;
}

enum IotcEdgeHostDevicePropNames {
    Manufacturer = 'manufacturer',
    Model = 'model',
    SwVersion = 'swVersion',
    OsName = 'osName',
    ProcessorArchitecture = 'processorArchitecture',
    ProcessorManufacturer = 'processorManufacturer',
    TotalStorage = 'totalStorage',
    TotalMemory = 'totalMemory'
}

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

enum ModuleState {
    Inactive = 'inactive',
    Active = 'active'
}

enum AddCameraCommandRequestParams {
    CameraId = 'AddCameraRequestParams_CameraId',
    CameraName = 'AddCameraRequestParams_CameraName',
    IpAddress = 'AddCameraRequestParams_IpAddress',
    OnvifUsername = 'AddCameraRequestParams_OnvifUsername',
    OnvifPassword = 'AddCameraRequestParams_OnvifPassword',
    DetectionType = 'AddCameraRequestParams_DetectionType'
}

enum AddCameraDetectionType {
    Motion = 'motion',
    Object = 'object'
}

const LvaCameraDeviceTypeMap = {
    [AddCameraDetectionType.Object]: {
        templateId: 'dtmi:com:azuremedia:model:LvaEdgeObjectDetectorDevice;1',
        deviceClass: AmsObjectDetectorDevice
    },
    [AddCameraDetectionType.Motion]: {
        templateId: 'dtmi:com:azuremedia:model:LvaEdgeMotionDetectorDevice;1',
        deviceClass: AmsMotionDetectorDevice
    }
};
const LvaOperationsInterfaceId = 'dtmi:com:azuremedia:LvaEdgeObjectDetectorDevice:LvaEdgeOperations;1';

enum RestartModuleCommandRequestParams {
    Timeout = 'RestartModuleRequestParams_Timeout'
}

enum DeleteCameraCommandRequestParams {
    CameraId = 'DeleteCameraRequestParams_CameraId'
}

enum CommandResponseParams {
    StatusCode = 'CommandResponseParams_StatusCode',
    Message = 'CommandResponseParams_Message',
    Data = 'CommandResponseParams_Data'
}

enum LvaGatewayCapability {
    tlSystemHeartbeat = 'tlSystemHeartbeat',
    tlFreeMemory = 'tlFreeMemory',
    tlConnectedCameras = 'tlConnectedCameras',
    stIoTCentralClientState = 'stIoTCentralClientState',
    stModuleState = 'stModuleState',
    evCreateCamera = 'evCreateCamera',
    evDeleteCamera = 'evDeleteCamera',
    evModuleStarted = 'evModuleStarted',
    evModuleStopped = 'evModuleStopped',
    evModuleRestart = 'evModuleRestart',
    wpDebugTelemetry = 'wpDebugTelemetry',
    wpDebugRoutedMessage = 'wpDebugRoutedMessage',
    cmAddCamera = 'cmAddCamera',
    cmDeleteCamera = 'cmDeleteCamera',
    cmRestartModule = 'cmRestartModule'
}

interface ILvaGatewaySettings {
    [LvaGatewayCapability.wpDebugTelemetry]: boolean;
    [LvaGatewayCapability.wpDebugRoutedMessage]: boolean;
}

const LvaGatewayEdgeInputs = {
    CameraCommand: 'cameracommand',
    LvaDiagnostics: 'lvaDiagnostics',
    LvaOperational: 'lvaOperational',
    LvaTelemetry: 'lvaTelemetry'
};

const LvaGatewayCommands = {
    CreateCamera: 'createcamera',
    DeleteCamera: 'deletecamera',
    SendDeviceTelemetry: 'senddevicetelemetry',
    SendDeviceInferences: 'senddeviceinferences'
};

const defaultDpsProvisioningHost = 'global.azure-devices-provisioning.net';
const defaultHealthCheckRetries = 3;

@service('cameraGateway')
export class CameraGatewayService {
    @inject('$server')
    private server: Server;

    @inject('storage')
    private storage: StorageService;

    private healthCheckRetries: number = defaultHealthCheckRetries;
    private healthState = HealthState.Good;
    private healthCheckFailStreak = 0;
    private moduleSettings: ILvaGatewaySettings = {
        [LvaGatewayCapability.wpDebugTelemetry]: false,
        [LvaGatewayCapability.wpDebugRoutedMessage]: false
    };
    private appConfig: IAppConfig = {
        system: {
            systemName: 'IoT Central Edge Gateway',
            systemId: '00000000-0000-0000-0000-000000000000'
        },
        device: {
            manufacturer: '',
            model: '',
            processorManufacturer: '',
            totalStorage: 0
        },
        iotCentral: {
            appHost: '',
            apiToken: '',
            deviceKey: '',
            scopeId: ''
        },
        env: {
            onvifModuleId: '',
            lvaEdgeModuleId: '',
            amsAccountName: ''
        }
    };
    private amsInferenceDeviceMap = new Map<string, AmsCameraDevice>();
    private dpsProvisioningHost: string = defaultDpsProvisioningHost;

    public async init(): Promise<void> {
        this.server.log([moduleName, 'info'], 'initialize');
    }

    @bind
    public getAppConfig(): any {
        return this.appConfig;
    }

    @bind
    public debugTelemetry(): boolean {
        return this.moduleSettings[LvaGatewayCapability.wpDebugTelemetry];
    }

    @bind
    public async onHandleModuleProperties(desiredChangedSettings: any): Promise<void> {
        try {
            this.server.log([moduleName, 'info'], `onHandleModuleProperties`);
            if (this.debugTelemetry()) {
                this.server.log([moduleName, 'info'], `desiredChangedSettings:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);
            }

            const patchedProperties = {};

            for (const setting in desiredChangedSettings) {
                if (!Object.prototype.hasOwnProperty.call(desiredChangedSettings, setting)) {
                    continue;
                }

                if (setting === '$version') {
                    continue;
                }

                const value = desiredChangedSettings[setting];

                switch (setting) {
                    case LvaGatewayCapability.wpDebugTelemetry:
                    case LvaGatewayCapability.wpDebugRoutedMessage:
                        patchedProperties[setting] = this.moduleSettings[setting] = value || false;
                        break;

                    default:
                        this.server.log([moduleName, 'error'], `Received desired property change for unknown setting '${setting}'`);
                        break;
                }
            }

            if (!emptyObj(patchedProperties)) {
                await this.server.settings.app.iotCentralModule.updateModuleProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Exception while handling desired properties: ${ex.message}`);
        }
    }

    @bind
    public onModuleClientError(error: Error): void {
        this.server.log([moduleName, 'error'], `Module client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    @bind
    public async onHandleDownstreamMessages(inputName: string, message: IoTMessage): Promise<void> {
        try {
            if (inputName === LvaGatewayEdgeInputs.LvaDiagnostics && !this.debugTelemetry()) {
                return;
            }

            const messageData = message.getBytes().toString('utf8');
            if (!messageData) {
                return;
            }

            const messageJson = JSON.parse(messageData);

            if (this.moduleSettings[LvaGatewayCapability.wpDebugRoutedMessage] === true) {
                if (message.properties?.propertyList) {
                    this.server.log([moduleName, 'info'], `Routed message properties: ${JSON.stringify(message.properties?.propertyList, null, 4)}`);
                }

                this.server.log([moduleName, 'info'], `Routed message data: ${JSON.stringify(messageJson, null, 4)}`);
            }

            switch (inputName) {
                case LvaGatewayEdgeInputs.CameraCommand: {
                    const edgeInputCameraCommand = messageJson?.command;
                    const edgeInputCameraCommandData = messageJson?.data;

                    switch (edgeInputCameraCommand) {
                        case LvaGatewayCommands.CreateCamera:
                            await this.createAmsInferenceDevice({
                                cameraId: edgeInputCameraCommandData?.cameraId,
                                cameraName: edgeInputCameraCommandData?.cameraName,
                                ipAddress: edgeInputCameraCommandData?.ipAddress,
                                onvifUsername: edgeInputCameraCommandData?.onvifUsername,
                                onvifPassword: edgeInputCameraCommandData?.onvifPassword,
                                detectionType: edgeInputCameraCommandData?.detectionType
                            });
                            break;

                        case LvaGatewayCommands.DeleteCamera:
                            await this.amsInferenceDeviceOperation('DELETE_CAMERA', edgeInputCameraCommandData);
                            break;

                        case LvaGatewayCommands.SendDeviceTelemetry:
                            await this.amsInferenceDeviceOperation('SEND_EVENT', edgeInputCameraCommandData);
                            break;

                        case LvaGatewayCommands.SendDeviceInferences:
                            await this.amsInferenceDeviceOperation('SEND_INFERENCES', edgeInputCameraCommandData);
                            break;

                        default:
                            this.server.log([moduleName, 'warning'], `Warning: received routed message for unknown input: ${inputName}`);
                            break;
                    }

                    break;
                }

                case LvaGatewayEdgeInputs.LvaDiagnostics:
                case LvaGatewayEdgeInputs.LvaOperational:
                case LvaGatewayEdgeInputs.LvaTelemetry: {
                    const cameraId = AmsGraph.getCameraIdFromLvaMessage(message);
                    if (!cameraId) {
                        this.server.log([moduleName, 'error'], `Received LvaDiagnostics telemetry but no cameraId found in subject`);
                        this.server.log([moduleName, 'error'], `LvaDiagnostics eventType: ${AmsGraph.getLvaMessageProperty(message, 'eventType')}`);
                        this.server.log([moduleName, 'error'], `LvaDiagnostics subject: ${AmsGraph.getLvaMessageProperty(message, 'subject')}`);
                        break;
                    }

                    const amsInferenceDevice = this.amsInferenceDeviceMap.get(cameraId);
                    if (!amsInferenceDevice) {
                        this.server.log([moduleName, 'error'], `Received Lva Edge telemetry for cameraId: "${cameraId}" but that device does not exist in Lva Gateway`);
                    }
                    else {
                        if (inputName === LvaGatewayEdgeInputs.LvaOperational || inputName === LvaGatewayEdgeInputs.LvaDiagnostics) {
                            await amsInferenceDevice.sendLvaEvent(AmsGraph.getLvaMessageProperty(message, 'eventType'), messageJson);
                        }
                        else {
                            await amsInferenceDevice.processLvaInferences(messageJson.inferences);
                        }
                    }

                    break;
                }

                default:
                    this.server.log([moduleName, 'warning'], `Warning: received routed message for unknown input: ${inputName}`);
                    break;
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error while handling downstream message: ${ex.message}`);
        }
    }

    @bind
    public async onModuleReady(): Promise<void> {
        this.server.log([moduleName, 'info'], `Module ready`);

        this.dpsProvisioningHost = process.env.dpsProvisioningHost || defaultDpsProvisioningHost;
        this.healthCheckRetries = Number(process.env.healthCheckRetries) || defaultHealthCheckRetries;
        this.healthState = this.server.settings.app.iotCentralModule.getModuleClient() ? HealthState.Good : HealthState.Critical;

        const systemProperties = await this.getSystemProperties();

        const hostConfig = await this.getAppConfigFromHost();
        this.appConfig = {
            ...hostConfig,
            env: {
                onvifModuleId: process.env.onvifModuleId || '',
                lvaEdgeModuleId: process.env.lvaEdgeModuleId || '',
                amsAccountName: process.env.amsAccountName || ''
            }
        };

        this.server.settings.app.iotCentralModule.addDirectMethod(LvaGatewayCapability.cmAddCamera, this.addCameraDirectMethod);
        this.server.settings.app.iotCentralModule.addDirectMethod(LvaGatewayCapability.cmDeleteCamera, this.deleteCameraDirectMethod);
        this.server.settings.app.iotCentralModule.addDirectMethod(LvaGatewayCapability.cmRestartModule, this.restartModuleDirectMethod);

        await this.server.settings.app.iotCentralModule.updateModuleProperties({
            ...this.appConfig.device,
            [IotcEdgeHostDevicePropNames.OsName]: osPlatform() || '',
            [IotcEdgeHostDevicePropNames.SwVersion]: osRelease() || '',
            [IotcEdgeHostDevicePropNames.ProcessorArchitecture]: osArch() || '',
            [IotcEdgeHostDevicePropNames.TotalMemory]: systemProperties.totalMemory
        });

        await this.server.settings.app.iotCentralModule.sendMeasurement({
            [LvaGatewayCapability.stIoTCentralClientState]: IoTCentralClientState.Connected,
            [LvaGatewayCapability.stModuleState]: ModuleState.Active,
            [LvaGatewayCapability.evModuleStarted]: 'Module initialization'
        }, iotcOutput);

        await this.recreateExistingDevices();
    }

    public async createCamera(cameraInfo: ICameraDeviceProvisionInfo): Promise<IProvisionResult> {
        return this.createAmsInferenceDevice(cameraInfo);
    }

    public async deleteCamera(cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        return this.amsInferenceDeviceOperation('DELETE_CAMERA', cameraOperationInfo);
    }

    public async sendCameraTelemetry(cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        return this.amsInferenceDeviceOperation('SEND_EVENT', cameraOperationInfo);
    }

    public async sendCameraInferences(cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        return this.amsInferenceDeviceOperation('SEND_INFERENCES', cameraOperationInfo);
    }

    @bind
    public async getHealth(): Promise<number> {
        let healthState = this.healthState;

        try {
            if (healthState === HealthState.Good) {
                const healthTelemetry = {};
                const systemProperties = await this.getSystemProperties();
                const freeMemory = systemProperties?.freeMemory || 0;

                healthTelemetry[LvaGatewayCapability.tlFreeMemory] = freeMemory;
                healthTelemetry[LvaGatewayCapability.tlConnectedCameras] = this.amsInferenceDeviceMap.size;

                // TODO:
                // Find the right threshold for this metric
                if (freeMemory === 0) {
                    healthState = HealthState.Critical;
                }

                healthTelemetry[LvaGatewayCapability.tlSystemHeartbeat] = healthState;

                await this.server.settings.app.iotCentralModule.sendMeasurement(healthTelemetry, iotcOutput);
            }

            this.healthState = healthState;

            for (const device of this.amsInferenceDeviceMap) {
                forget(device[1].getHealth);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error in healthState (may indicate a critical issue): ${ex.message}`);
            this.healthState = HealthState.Critical;
        }

        if (this.healthState < HealthState.Good) {
            this.server.log(['HealthService', 'warning'], `Health check warning: ${healthState}`);

            if (++this.healthCheckFailStreak >= this.healthCheckRetries) {
                this.server.log(['HealthService', 'warning'], `Health check too many warnings: ${healthState}`);

                await this.restartModule(0, 'checkHealthState');
            }
        }

        return this.healthState;
    }

    public async restartModule(timeout: number, reason: string): Promise<void> {
        this.server.log([moduleName, 'info'], `Module restart requested...`);

        try {
            await this.server.settings.app.iotCentralModule.sendMeasurement({
                [LvaGatewayCapability.evModuleRestart]: reason,
                [LvaGatewayCapability.stModuleState]: ModuleState.Inactive,
                [LvaGatewayCapability.evModuleStopped]: 'Module restart'
            }, iotcOutput);

            if (timeout > 0) {
                await new Promise((resolve) => {
                    setTimeout(() => {
                        return resolve('');
                    }, 1000 * timeout);
                });
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `${ex.message}`);
        }

        // let Docker restart our container
        this.server.log([moduleName, 'info'], `Shutting down main process - module container will restart`);
        process.exit(1);
    }

    private async getSystemProperties(): Promise<ISystemProperties> {
        const cpus = osCpus();
        const cpuUsageSamples = osLoadAvg();

        return {
            cpuModel: cpus[0]?.model || 'Unknown',
            cpuCores: cpus?.length || 0,
            cpuUsage: cpuUsageSamples[0],
            totalMemory: osTotalMem() / 1024,
            freeMemory: osFreeMem() / 1024
        };
    }

    private async getAppConfigFromHost(): Promise<any> {
        try {
            return this.storage.get('state');
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error reading host configuration data: ${ex.message}`);
        }

        return {};
    }

    private async validateLeafDeviceOwner(deviceId: string): Promise<ICameraDeviceProvisionInfo> {
        try {
            this.server.log([moduleName, 'info'], `Getting component interfaces on device: ${deviceId}`);

            const devicePropertiesResponse = await this.iotcApiRequest(
                `https://${this.appConfig.iotCentral.appHost}/api/preview/devices/${deviceId}/properties`,
                'get',
                {
                    headers: {
                        Authorization: this.appConfig.iotCentral.apiToken
                    },
                    json: true
                });

            if (!devicePropertiesResponse[LvaOperationsInterfaceId]) {
                this.server.log([moduleName, 'error'], `Could not find LVA interface(s) on device id: ${deviceId}`);
                return;
            }

            return {
                cameraId: deviceId,
                cameraName: devicePropertiesResponse[OnvifCameraCapability.rpCameraName],
                ipAddress: devicePropertiesResponse[OnvifCameraCapability.rpIpAddress],
                onvifUsername: devicePropertiesResponse[OnvifCameraCapability.rpOnvifUsername],
                onvifPassword: devicePropertiesResponse[OnvifCameraCapability.rpOnvifPassword],
                detectionType: devicePropertiesResponse[LvaCameraDeviceTypeMap[AddCameraDetectionType.Object].templateId]
                    ? AddCameraDetectionType.Object
                    : AddCameraDetectionType.Motion
            };
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error getting properties for device id: ${deviceId}`);
        }

        return;
    }

    private async recreateExistingDevices() {
        this.server.log([moduleName, 'info'], 'recreateExistingDevices');

        try {
            const deviceListResponse = await this.iotcApiRequest(
                `https://${this.appConfig.iotCentral.appHost}/api/preview/devices`,
                'get',
                {
                    headers: {
                        Authorization: this.appConfig.iotCentral.apiToken
                    },
                    json: true
                });

            const deviceList = deviceListResponse.payload?.value || [];

            this.server.log([moduleName, 'info'], `Found ${deviceList.length} devices`);
            if (this.debugTelemetry()) {
                this.server.log([moduleName, 'info'], `${JSON.stringify(deviceList, null, 4)}`);
            }

            for (const device of deviceList) {
                try {
                    const cameraInfo = await this.validateLeafDeviceOwner(device.id);
                    if (cameraInfo) {
                        this.server.log([moduleName, 'info'], `Recreating device: ${device.id} - detectionType: ${cameraInfo.detectionType}`);

                        await this.createAmsInferenceDevice(cameraInfo);
                    }
                }
                catch (ex) {
                    this.server.log([moduleName, 'error'], `An error occurred while re-creating devices: ${ex.message}`);
                }
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Failed to get device list: ${ex.message}`);
        }

        // If there were errors, we may be in a bad state (e.g. an ams inference device exists
        // but we were not able to re-connect to it's client interface). Consider setting the health
        // state to critical here to restart the gateway module.
    }

    private async createAmsInferenceDevice(cameraInfo: ICameraDeviceProvisionInfo): Promise<IProvisionResult> {
        this.server.log([moduleName, 'info'], `createAmsInferenceDevice - cameraId: ${cameraInfo.cameraId}, cameraName: ${cameraInfo.cameraName}, detectionType: ${cameraInfo.detectionType}`);

        let deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            amsInferenceDevice: null
        };

        try {
            if (!cameraInfo.cameraId) {
                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing device configuration - skipping DPS provisioning`;

                this.server.log([moduleName, 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            if (!this.appConfig.iotCentral.appHost
                || !this.appConfig.iotCentral.apiToken
                || !this.appConfig.iotCentral.deviceKey
                || !this.appConfig.iotCentral.scopeId) {

                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing camera management settings (ScopeId)`;
                this.server.log([moduleName, 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            deviceProvisionResult = await this.createAndProvisionAmsInferenceDevice(cameraInfo);

            if (deviceProvisionResult.dpsProvisionStatus === true && deviceProvisionResult.clientConnectionStatus === true) {
                this.amsInferenceDeviceMap.set(cameraInfo.cameraId, deviceProvisionResult.amsInferenceDevice);

                await this.server.settings.app.iotCentralModule.sendMeasurement({
                    [LvaGatewayCapability.evCreateCamera]: cameraInfo.cameraId
                }, iotcOutput);

                this.server.log([moduleName, 'info'], `Succesfully provisioned camera device with id: ${cameraInfo.cameraId}`);
            }
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning amsInferenceDevice: ${ex.message}`;

            this.server.log([moduleName, 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async createAndProvisionAmsInferenceDevice(cameraInfo: ICameraDeviceProvisionInfo): Promise<IProvisionResult> {
        this.server.log([moduleName, 'info'], `Provisioning device - id: ${cameraInfo.cameraId}`);

        const deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            amsInferenceDevice: null
        };

        try {
            const amsGraph = await AmsGraph.createAmsGraph(this.server.settings.app.iotCentralModule, cameraInfo);
            this.server.log([moduleName, 'info'], `Create AmsGraph succeeded: ${this.appConfig.env.amsAccountName}`);

            const deviceKey = this.computeDeviceKey(cameraInfo.cameraId, this.appConfig.iotCentral.deviceKey);
            this.server.log([moduleName, 'info'], `Computed deviceKey: ${deviceKey}`);

            const provisioningSecurityClient = new SymmetricKeySecurityClient(cameraInfo.cameraId, deviceKey);
            const provisioningClient = ProvisioningDeviceClient.create(
                this.dpsProvisioningHost,
                this.appConfig.iotCentral.scopeId,
                new ProvisioningTransport(),
                provisioningSecurityClient);

            this.server.log([moduleName, 'info'], `Created provisioningClient succeeded`);

            const provisioningPayload = {
                iotcModelId: LvaCameraDeviceTypeMap[cameraInfo.detectionType].templateId,
                iotcGateway: {
                    iotcGatewayId: this.server.settings.app.iotCentralModule.deviceId,
                    iotcModuleId: this.server.settings.app.iotCentralModule.moduleId
                }
            };

            provisioningClient.setProvisioningPayload(provisioningPayload);
            this.server.log([moduleName, 'info'], `setProvisioningPayload succeeded ${JSON.stringify(provisioningPayload, null, 4)}`);

            const dpsConnectionString = await new Promise<string>((resolve, reject) => {
                provisioningClient.register((dpsError, dpsResult) => {
                    if (dpsError) {
                        this.server.log([moduleName, 'error'], `DPS register failed: ${JSON.stringify(dpsError, null, 4)}`);

                        return reject(dpsError);
                    }

                    this.server.log([moduleName, 'info'], `DPS registration succeeded - hub: ${dpsResult.assignedHub}`);

                    return resolve(`HostName=${dpsResult.assignedHub};DeviceId=${dpsResult.deviceId};SharedAccessKey=${deviceKey}`);
                });
            });
            this.server.log([moduleName, 'info'], `register device client succeeded`);

            deviceProvisionResult.dpsProvisionStatus = true;
            deviceProvisionResult.dpsProvisionMessage = `IoT Central successfully provisioned device: ${cameraInfo.cameraId}`;
            deviceProvisionResult.dpsHubConnectionString = dpsConnectionString;

            deviceProvisionResult.amsInferenceDevice = new LvaCameraDeviceTypeMap[cameraInfo.detectionType].deviceClass(this.server.settings.app.iotCentralModule, amsGraph, cameraInfo);

            const { clientConnectionStatus, clientConnectionMessage } = await deviceProvisionResult.amsInferenceDevice.connectDeviceClient(deviceProvisionResult.dpsHubConnectionString);

            this.server.log([moduleName, 'info'], `clientConnectionStatus: ${clientConnectionStatus}, clientConnectionMessage: ${clientConnectionMessage}`);

            deviceProvisionResult.clientConnectionStatus = clientConnectionStatus;
            deviceProvisionResult.clientConnectionMessage = clientConnectionMessage;
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning device: ${ex.message}`;

            this.server.log([moduleName, 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async deprovisionAmsInferenceDevice(cameraId: string): Promise<boolean> {
        this.server.log([moduleName, 'info'], `Deprovisioning device - id: ${cameraId}`);

        let result = false;

        try {
            const amsInferenceDevice = this.amsInferenceDeviceMap.get(cameraId);
            if (amsInferenceDevice) {
                await amsInferenceDevice.deleteCamera();
                this.amsInferenceDeviceMap.delete(cameraId);
            }

            this.server.log([moduleName, 'info'], `Deleting IoT Central device instance: ${cameraId}`);
            try {
                await this.iotcApiRequest(
                    `https://${this.appConfig.iotCentral.appHost}/api/preview/devices/${cameraId}`,
                    'delete',
                    {
                        headers: {
                            Authorization: this.appConfig.iotCentral.apiToken
                        },
                        json: true
                    });

                await this.server.settings.app.iotCentralModule.sendMeasurement({
                    [LvaGatewayCapability.evDeleteCamera]: cameraId
                }, iotcOutput);

                this.server.log([moduleName, 'info'], `Succesfully de-provisioned camera device with id: ${cameraId}`);

                result = true;
            }
            catch (ex) {
                this.server.log([moduleName, 'error'], `Requeset to delete the IoT Central device failed: ${ex.message}`);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Failed de-provision device: ${ex.message}`);
        }

        return result;
    }

    private computeDeviceKey(deviceId: string, masterKey: string) {
        return crypto.createHmac('SHA256', Buffer.from(masterKey, 'base64')).update(deviceId, 'utf8').digest('base64');
    }

    private async amsInferenceDeviceOperation(deviceOperation: DeviceOperation, cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        this.server.log([moduleName, 'info'], `Processing LVA Edge gateway operation: ${JSON.stringify(cameraOperationInfo, null, 4)}`);

        const operationResult = {
            status: false,
            message: ''
        };

        const cameraId = cameraOperationInfo?.cameraId;
        if (!cameraId) {
            operationResult.message = `Missing cameraId`;

            this.server.log([moduleName, 'error'], operationResult.message);

            return operationResult;
        }

        const amsInferenceDevice = this.amsInferenceDeviceMap.get(cameraId);
        if (!amsInferenceDevice) {
            operationResult.message = `No device exists with cameraId: ${cameraId}`;

            this.server.log([moduleName, 'error'], operationResult.message);

            return operationResult;
        }

        const operationInfo = cameraOperationInfo?.operationInfo;
        if (!operationInfo) {
            operationResult.message = `Missing operationInfo data`;

            this.server.log([moduleName, 'error'], operationResult.message);

            return operationResult;
        }

        switch (deviceOperation) {
            case 'DELETE_CAMERA':
                await this.deprovisionAmsInferenceDevice(cameraId);
                break;

            case 'SEND_EVENT':
                await amsInferenceDevice.sendLvaEvent(operationInfo);
                break;

            case 'SEND_INFERENCES':
                await amsInferenceDevice.processLvaInferences(operationInfo);
                break;

            default:
                this.server.log([moduleName, 'error'], `Unkonwn device operation: ${deviceOperation}`);
                break;
        }

        return {
            status: true,
            message: `Success`
        };
    }

    @bind
    private async addCameraDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `${LvaGatewayCapability.cmAddCamera} command received`);

        const addCameraResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };

        const cameraInfo: ICameraDeviceProvisionInfo = {
            cameraId: commandRequest?.payload?.[AddCameraCommandRequestParams.CameraId],
            cameraName: commandRequest?.payload?.[AddCameraCommandRequestParams.CameraName],
            ipAddress: commandRequest?.payload?.[AddCameraCommandRequestParams.IpAddress],
            onvifUsername: commandRequest?.payload?.[AddCameraCommandRequestParams.OnvifUsername],
            onvifPassword: commandRequest?.payload?.[AddCameraCommandRequestParams.OnvifPassword],
            detectionType: commandRequest?.payload?.[AddCameraCommandRequestParams.DetectionType]
        };

        try {
            if (!cameraInfo.cameraId
                || !cameraInfo.cameraName
                || !cameraInfo.ipAddress
                || !cameraInfo.onvifUsername
                || !cameraInfo.onvifPassword
                || !cameraInfo.detectionType) {
                await commandResponse.send(200, {
                    [CommandResponseParams.StatusCode]: 400,
                    [CommandResponseParams.Message]: `Missing required parameters`,
                    [CommandResponseParams.Data]: ''
                });

                return;
            }

            const provisionResult = await this.createAmsInferenceDevice(cameraInfo);

            addCameraResponse[CommandResponseParams.Message] = provisionResult.clientConnectionMessage || provisionResult.dpsProvisionMessage;
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error creating LVA Edge gateway camera device: ${ex.message}`);

            addCameraResponse[CommandResponseParams.StatusCode] = 500;
            addCameraResponse[CommandResponseParams.Message] = `Error creating camera device ${cameraInfo.cameraId}`;
        }

        await commandResponse.send(200, addCameraResponse);
    }

    @bind
    private async deleteCameraDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `${LvaGatewayCapability.cmDeleteCamera} command received`);

        const deleteCameraResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };

        const cameraId = commandRequest?.payload?.[DeleteCameraCommandRequestParams.CameraId];

        try {
            if (!cameraId) {
                await commandResponse.send(200, {
                    [CommandResponseParams.StatusCode]: 400,
                    [CommandResponseParams.Message]: `Missing required Camera Id parameter`,
                    [CommandResponseParams.Data]: ''
                });

                return;
            }

            const deleteResult = await this.deprovisionAmsInferenceDevice(cameraId);

            if (deleteResult) {
                deleteCameraResponse[CommandResponseParams.Message] = `Finished deprovisioning camera device ${cameraId}`;
            }
            else {
                deleteCameraResponse[CommandResponseParams.StatusCode] = 500;
                deleteCameraResponse[CommandResponseParams.Message] = `Error deprovisioning camera device ${cameraId}`;
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error deleting LVA Edge gateway camera device: ${ex.message}`);

            deleteCameraResponse[CommandResponseParams.StatusCode] = 500;
            deleteCameraResponse[CommandResponseParams.Message] = `Error deprovisioning camera device ${cameraId}`;
        }

        await commandResponse.send(200, deleteCameraResponse);
    }

    @bind
    private async restartModuleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `${LvaGatewayCapability.cmRestartModule} command received`);

        try {
            // sending response before processing, since this is a restart request
            await commandResponse.send(200, {
                [CommandResponseParams.StatusCode]: 200,
                [CommandResponseParams.Message]: 'Restart module request received',
                [CommandResponseParams.Data]: ''
            });

            await this.restartModule(commandRequest?.payload?.[RestartModuleCommandRequestParams.Timeout] || 0, 'RestartModule command received');
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error sending response for ${LvaGatewayCapability.cmRestartModule} command: ${ex.message}`);

            await commandResponse.send(200, {
                [CommandResponseParams.StatusCode]: 500,
                [CommandResponseParams.Message]: 'Error while attempting to restart the module',
                [CommandResponseParams.Data]: ''
            });
        }
    }

    private async iotcApiRequest(uri, method, options): Promise<any> {
        try {
            const iotcApiResponse = await Wreck[method](uri, options);

            if (iotcApiResponse.res.statusCode < 200 || iotcApiResponse.res.statusCode > 299) {
                this.server.log([moduleName, 'error'], `Response status code = ${iotcApiResponse.res.statusCode}`);

                throw new Error((iotcApiResponse.payload as any)?.message || iotcApiResponse.payload || 'An error occurred');
            }

            return iotcApiResponse;
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `iotcApiRequest: ${ex.message}`);
            throw ex;
        }
    }
}
