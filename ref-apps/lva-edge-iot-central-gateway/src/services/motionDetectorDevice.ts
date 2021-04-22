import { IIoTCentralModule } from '../plugins/iotCentral';
import { ICameraDeviceProvisionInfo } from './cameraGateway';
import { AvaPipeline } from './avaPipeline';
import {
    OnvifCameraCapability,
    AiInferenceCapability,
    AvaCameraDevice
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

enum MotionDetectorCapability {
    wpSensitivity = 'wpSensitivity'
}

interface IMotionDetectorSettings {
    [MotionDetectorCapability.wpSensitivity]: MotionDetectorSensitivity;
}

export class AvaMotionDetectorDevice extends AvaCameraDevice {
    private motionDetectorSettings: IMotionDetectorSettings = {
        [MotionDetectorCapability.wpSensitivity]: MotionDetectorSensitivity.Medium
    };

    constructor(iotCentralModule: IIoTCentralModule, avaPipeline: AvaPipeline, cameraInfo: ICameraDeviceProvisionInfo) {
        super(iotCentralModule, avaPipeline, cameraInfo);
    }

    public setPipelineParams(): any {
        return {
            motionSensitivity: this.motionDetectorSettings[MotionDetectorCapability.wpSensitivity],
            assetName: `${this.iotCentralModule.getAppConfig().scopeId}-${this.iotCentralModule.deviceId}-${this.cameraInfo.cameraId}-${moment.utc().format('YYYYMMDD-HHmmss')}`
        };
    }

    public async deviceReady(): Promise<void> {
        this.iotCentralModule.logger([this.cameraInfo.cameraId, 'info'], `Device is ready`);

        const cameraProps = await this.getCameraProps();

        await this.updateDeviceProperties({
            ...cameraProps,
            [OnvifCameraCapability.rpCameraName]: this.cameraInfo.cameraName,
            [OnvifCameraCapability.rpIpAddress]: this.cameraInfo.ipAddress,
            [OnvifCameraCapability.rpOnvifUsername]: this.cameraInfo.onvifUsername,
            [OnvifCameraCapability.rpOnvifPassword]: this.cameraInfo.onvifPassword,
            [AiInferenceCapability.rpInferenceImageUrl]: ''
        });
    }

    public async processAvaInferences(inferences: IMotionInference[]): Promise<void> {
        if (!Array.isArray(inferences) || !this.deviceClient) {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Missing inferences array or client not connected`);
            return;
        }

        try {
            let inferenceCount = 0;

            for (const inference of inferences) {
                ++inferenceCount;

                await this.sendMeasurement({
                    [AiInferenceCapability.tlInference]: inference
                });
            }

            if (inferenceCount > 0) {
                this.lastInferenceTime = moment.utc();

                await this.sendMeasurement({
                    [AiInferenceCapability.tlInferenceCount]: inferenceCount
                });

                await this.updateDeviceProperties({
                    [AiInferenceCapability.rpInferenceImageUrl]: ''
                });
            }
        }
        catch (ex) {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Error processing downstream message: ${ex.message}`);
        }
    }

    @bind
    protected async onHandleDeviceProperties(desiredChangedSettings: any): Promise<void> {
        this.iotCentralModule.logger([this.cameraInfo.cameraId, '#####'], `onHandleDeviceProperties DERIVED`);
        await super.onHandleDeviceProperties(desiredChangedSettings);
        // await super.onHandleDevicePropertiesInternal(desiredChangedSettings);

        try {
            if (this.debugTelemetry()) {
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
                    case MotionDetectorCapability.wpSensitivity:
                        patchedProperties[setting] = this.motionDetectorSettings[setting] = value || 'medium';
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
