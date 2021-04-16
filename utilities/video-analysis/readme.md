# Video analysis

This folder has a set of video analysis related utilities.

## Contents

| Folders              | Description                                                              |
|----------------------|--------------------------------------------------------------------------|
| `notebooks`          | Jupyter notebook samples for Live Video Analytics                        |
| `dl-streamer`        | OpenVINO™ DL Streamer – Edge AI Extension from Intel                     |
| `ovms`               | OpenVINO™ Model Server – AI Extension from Intel                         |
| `resnet-onnx`        | Docker container with ResNet ONNX model                                  |
| `shared`             | Graph manager script to manage graphs                                    |
| `tls-yolov3-onnx`    | Docker container with Secured YOLOv3 ONNX model                          |
| `yolov3-onnx`        | Docker container with YOLOv3 ONNX model and Tiny YOLOv3 ONNX model       |
| `yolov4-darknet`     | Docker container with YOLOv4 Darknet model                               |
| `yolov4-tflite-tiny` | Docker container with YOLOv4 TensorFlow Lite model                       |


## Instructions on pushing the container image to Azure Container Registry

These instructions are a guide on pushing the docker images to a private registry in Azure for LVA to consume.

> Note:  this section is based on [Push and Pull Docker images  - Azure Container Registry](http://docs.microsoft.com/en-us/azure/container-registry/container-registry-get-started-docker-cli).  More on Azure Container Registry (ACR) can be found [here](https://docs.microsoft.com/en-us/azure/container-registry/).


1. Log in to Azure with the Azure CLI ([install the Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli)).

    - To log in interactively to Azure use the following command and follow the instructions printed out.

    ```
    az login
    ```

    - To log in to Azure with device code (non-interactive, e.g. using SSH on a VM) use the following command and follow the instructions printed out.

    ```
    az login --use-device-code
    ```


2.  Ensure the image name is tagged with the ACR information as in `<my ACR username>.azurecr.io/<my image name or tag:version>`.

    - To retag an image you may do the following.

    ```
    docker tag <original image name/tag> <my ACR username>.azurecr.io/<my image name or tag:version>
    ```

3.  Log in to ACR with the Azure CLI (`docker` may also be used).

    ```
    az acr login --name <my ACR username>
    ```

    - [Info on methods to log in to ACR](https://docs.microsoft.com/en-us/azure/container-registry/container-registry-get-started-docker-cli#log-in-to-a-registry)

4.  Push the image to ACR as follows.

    - With docker (must have [docker installed](https://docs.docker.com/get-docker/)), use the following.
    ```
    docker push <my ACR username>.azurecr.io/<my image name or tag:version>
    ```

5.  Go to the Azure portal (https://portal.azure.com) and navigate to the ACR resource to ensure the repository now has the image available.

6.  Use the image path from ACR (`<my ACR username>.azurecr.io/<my image name or tag:version>`) in the LVA deployment manifest for your device along with your ACR credentials.

> Note:  alternatively, you can upload the image to [docker hub](https://hub.docker.com).

## Contributions needed

- Build a Docker container with YOLOv3 inferencing in GPU
- Build a Docker container with an inferencing model in FPGA
