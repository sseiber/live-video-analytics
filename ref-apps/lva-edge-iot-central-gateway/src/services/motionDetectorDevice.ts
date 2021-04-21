import { IIoTCentralModule } from '../plugins/iotCentral';
import { ICameraDeviceProvisionInfo } from './cameraGateway';
import { AmsGraph } from './amsGraph';
import {
    OnvifCameraInformationProps,
    OnvifCameraInterface,
    IoTCentralClientState,
    CameraState,
    AiInferenceInterface,
    AmsCameraDevice,
    LvaEdgeDiagnosticsSettings
} from './device';
import * as moment from 'moment';
import { bind, emptyObj } from '../utils';

interface IMotionInference {
    type: string;
    motion: {
        box: {
            l: number;
            t: number;
            w: number;
            h: number;
        };
    };
}

enum MotionDetectorSensitivity {
    Low = 'low',
    Medium = 'medium',
    High = 'high'
}

enum MotionDetectorSettings {
    Sensitivity = 'wpSensitivity'
}

interface IMotionDetectorSettings {
    [MotionDetectorSettings.Sensitivity]: MotionDetectorSensitivity;
}

const MotionDetectorInterface = {
    Setting: {
        Sensitivity: MotionDetectorSettings.Sensitivity
    }
};

export class AmsMotionDetectorDevice extends AmsCameraDevice {
    private motionDetectorSettings: IMotionDetectorSettings = {
        [MotionDetectorSettings.Sensitivity]: MotionDetectorSensitivity.Medium
    };

    constructor(iotCentralModule: IIoTCentralModule, amsGraph: AmsGraph, cameraInfo: ICameraDeviceProvisionInfo) {
        super(iotCentralModule, amsGraph, cameraInfo);
    }

    public setGraphParameters(): any {
        return {
            motionSensitivity: this.motionDetectorSettings[MotionDetectorSettings.Sensitivity],
            assetName: `${this.iotCentralModule.getAppConfig().scopeId}-${this.iotCentralModule.deviceId}-${this.cameraInfo.cameraId}-${moment.utc().format('YYYYMMDD-HHmmss')}`
        };
    }

    public async deviceReady(): Promise<void> {
        this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `Device is ready`);

        await this.sendMeasurement({
            [OnvifCameraInterface.State.IoTCentralClientState]: IoTCentralClientState.Connected,
            [OnvifCameraInterface.State.CameraState]: CameraState.Inactive
        });

        const cameraProps = await this.getCameraProps();

        await this.updateDeviceProperties({
            ...cameraProps,
            [OnvifCameraInterface.Property.CameraName]: this.cameraInfo.cameraName,
            [OnvifCameraInterface.Property.IpAddress]: this.cameraInfo.ipAddress,
            [OnvifCameraInterface.Property.OnvifUsername]: this.cameraInfo.onvifUsername,
            [OnvifCameraInterface.Property.OnvifPassword]: this.cameraInfo.onvifPassword,
            [AiInferenceInterface.Property.InferenceImageUrl]: ''
        });
    }

    public async processLvaInferences(inferences: IMotionInference[]): Promise<void> {
        if (!Array.isArray(inferences) || !this.deviceClient) {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Missing inferences array or client not connected`);
            return;
        }

        try {
            let inferenceCount = 0;

            for (const inference of inferences) {
                ++inferenceCount;

                await this.sendMeasurement({
                    [AiInferenceInterface.Telemetry.Inference]: inference
                });
            }

            if (inferenceCount > 0) {
                this.lastInferenceTime = moment.utc();

                await this.sendMeasurement({
                    [AiInferenceInterface.Telemetry.InferenceCount]: inferenceCount
                });

                await this.updateDeviceProperties({
                    [AiInferenceInterface.Property.InferenceImageUrl]: ''
                });
            }
        }
        catch (ex) {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Error processing downstream message: ${ex.message}`);
        }
    }

    public async getCameraProps(): Promise<OnvifCameraInformationProps> {
        let cameraProps: OnvifCameraInformationProps;

        try {
            let deviceInfoResult = await this.iotCentralModule.invokeDirectMethod(
                this.envConfig.onvifModuleId,
                'GetDeviceInformation',
                {
                    Address: this.cameraInfo.ipAddress,
                    Username: this.cameraInfo.onvifUsername,
                    Password: this.cameraInfo.onvifPassword
                });

            cameraProps = {
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

            cameraProps.rpMediaProfile1 = {
                mediaProfileName: deviceInfoResult.payload[0]?.MediaProfileName || '',
                mediaProfileToken: deviceInfoResult.payload[0]?.MediaProfileToken || ''
            };

            cameraProps.rpMediaProfile2 = {
                mediaProfileName: deviceInfoResult.payload[1]?.MediaProfileName || '',
                mediaProfileToken: deviceInfoResult.payload[1]?.MediaProfileToken || ''
            };
        }
        catch (ex) {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Error getting onvif device properties: ${ex.message}`);
        }

        return cameraProps;
    }

    @bind
    protected async onHandleDeviceProperties(desiredChangedSettings: any): Promise<void> {
        await super.onHandleDevicePropertiesInternal(desiredChangedSettings);

        try {
            if (this.lvaEdgeDiagnosticsSettings[LvaEdgeDiagnosticsSettings.DebugTelemetry] === true) {
                this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `desiredPropsDelta:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);
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
                    ? desiredChangedSettings[setting]?.value
                    : desiredChangedSettings[setting];

                switch (setting) {
                    case MotionDetectorInterface.Setting.Sensitivity:
                        patchedProperties[setting] = this.motionDetectorSettings[setting] = value || '';
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

        this.deferredStart.resolve();
    }
}
