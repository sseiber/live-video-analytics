import { Server } from '@hapi/hapi';
import { ICameraDeviceProvisionInfo } from './cameraGateway';
import {
    OnvifCameraCapability,
    UnmodeledTelemetry,
    AvaCameraDevice
} from './device';
import * as moment from 'moment';
import { bind } from '../utils';

interface IAvaInference {
    type: string;
    entity: {
        box: {
            l: number;
            t: number;
            w: number;
            h: number;
        };
        tag?: {
            value: string;
            confidence: number;
        };
    };
}

export class AvaDevice extends AvaCameraDevice {
    constructor(server: Server, onvifModuleId: string, avaEdgeModuleId: string, appScopeId: string, pipelineTopology: any, cameraInfo: ICameraDeviceProvisionInfo) {
        super(server, onvifModuleId, avaEdgeModuleId, appScopeId, pipelineTopology, cameraInfo);
    }

    public setPipelineParams(): any {
        return {
            assetName: `${this.appScopeId}-${this.iotCentralModule.deviceId}-${this.cameraInfo.cameraId}-${moment.utc().format('YYYYMMDD-HHmmss')}`
        };
    }

    public async deviceReady(): Promise<void> {
        this.server.log([this.cameraInfo.cameraId, 'info'], `Device is ready`);

        const cameraProps = await this.getCameraProps();

        await this.updateDeviceProperties({
            ...cameraProps,
            [OnvifCameraCapability.rpCameraName]: this.cameraInfo.cameraName,
            [OnvifCameraCapability.rpIpAddress]: this.cameraInfo.ipAddress,
            [OnvifCameraCapability.rpOnvifUsername]: this.cameraInfo.onvifUsername,
            [OnvifCameraCapability.rpOnvifPassword]: this.cameraInfo.onvifPassword,
            [OnvifCameraCapability.rpIotcModelId]: this.cameraInfo.iotcModelId,
            [OnvifCameraCapability.rpAvaPipelineName]: this.cameraInfo.avaPipelineTopologyName,
            [OnvifCameraCapability.rpCaptureImageUrl]: ''
        });
    }

    public async processAvaInferences(inferences: IAvaInference[]): Promise<void> {
        if (!Array.isArray(inferences) || !this.deviceClient) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Missing inferences array or client not connected`);
            return;
        }

        this.server.log([this.cameraInfo.cameraId, 'info'], `processAvaInferences: received ${inferences.length} inferences`);

        this.lastInferenceTime = moment.utc();

        try {
            for (const inference of inferences) {
                await this.sendMeasurement({
                    [UnmodeledTelemetry.tlFullInferenceEntity]: inference
                });
            }
        }
        catch (ex) {
            this.server.log([this.cameraInfo.cameraId, 'error'], `Error processing downstream message: ${ex.message}`);
        }
    }

    @bind
    protected async onHandleDeviceProperties(desiredChangedSettings: any): Promise<void> {
        await super.onHandleDeviceProperties(desiredChangedSettings);

        this.deferredStart.resolve();
    }
}
