import { IIoTCentralModule } from '../plugins/iotCentral';
import { ICameraDeviceProvisionInfo } from './cameraGateway';
import { AvaPipeline } from './avaPipeline';
import {
    OnvifCameraCapability,
    AiInferenceCapability,
    AmsCameraDevice
} from './device';
import * as moment from 'moment';
import { bind, emptyObj } from '../utils';

interface IObjectInference {
    type: string;
    entity: {
        box: {
            l: number;
            t: number;
            w: number;
            h: number;
        };
        tag: {
            confidence: number;
            value: string;
        };
    };
}

const defaultDetectionClass = 'person';
const defaultConfidenceThreshold = 70.0;
const defaultInferenceFps = 2;

enum ObjectDetectorCapability {
    wpDetectionClasses = 'wpDetectionClasses',
    wpConfidenceThreshold = 'wpConfidenceThreshold',
    wpInferenceFps = 'wpInferenceFps'
}

interface IObjectDetectorSettings {
    [ObjectDetectorCapability.wpDetectionClasses]: string;
    [ObjectDetectorCapability.wpConfidenceThreshold]: number;
    [ObjectDetectorCapability.wpInferenceFps]: number;
}

export class AmsObjectDetectorDevice extends AmsCameraDevice {
    private objectDetectorSettings: IObjectDetectorSettings = {
        [ObjectDetectorCapability.wpDetectionClasses]: defaultDetectionClass,
        [ObjectDetectorCapability.wpConfidenceThreshold]: defaultConfidenceThreshold,
        [ObjectDetectorCapability.wpInferenceFps]: defaultInferenceFps
    };

    private detectionClasses: string[] = this.objectDetectorSettings[ObjectDetectorCapability.wpDetectionClasses].toUpperCase().split(',');

    constructor(iotCentralModule: IIoTCentralModule, avaPipeline: AvaPipeline, cameraInfo: ICameraDeviceProvisionInfo) {
        super(iotCentralModule, avaPipeline, cameraInfo);
    }

    public setPipelineParams(): any {
        return {
            frameRate: this.objectDetectorSettings[ObjectDetectorCapability.wpInferenceFps],
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

    public async processAvaInferences(inferences: IObjectInference[]): Promise<void> {
        if (!Array.isArray(inferences) || !this.deviceClient) {
            this.iotCentralModule.logger([this.cameraInfo.cameraId, 'error'], `Missing inferences array or client not connected`);
            return;
        }

        try {
            let detectionCount = 0;
            let sampleImageUrl = '';

            for (const inference of inferences) {
                const detectedClass = (inference.entity?.tag?.value || '').toUpperCase();
                const confidence = (inference.entity?.tag?.confidence || 0.0) * 100;

                if (this.detectionClasses.includes(detectedClass) && confidence >= this.objectDetectorSettings[ObjectDetectorCapability.wpConfidenceThreshold]) {
                    ++detectionCount;
                    sampleImageUrl = '';

                    await this.sendMeasurement({
                        [AiInferenceCapability.tlInference]: inference
                    });
                }
            }

            if (detectionCount > 0) {
                this.lastInferenceTime = moment.utc();

                await this.sendMeasurement({
                    [AiInferenceCapability.tlInferenceCount]: detectionCount
                });

                await this.updateDeviceProperties({
                    [AiInferenceCapability.rpInferenceImageUrl]: sampleImageUrl
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
                    case ObjectDetectorCapability.wpDetectionClasses: {
                        const detectionClassesString = (value || '');

                        this.detectionClasses = detectionClassesString.toUpperCase().split(',');

                        patchedProperties[setting] = detectionClassesString;
                        break;
                    }

                    case ObjectDetectorCapability.wpConfidenceThreshold:
                        patchedProperties[setting] = (this.objectDetectorSettings[setting] as any) = value || defaultConfidenceThreshold;
                        break;

                    case ObjectDetectorCapability.wpInferenceFps:
                        patchedProperties[setting] = (this.objectDetectorSettings[setting] as any) = value || defaultInferenceFps;
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
